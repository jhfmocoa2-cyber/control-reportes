import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'clave_secreta_reportes_2026'
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''

interface CanastaReporte {
  tipo?: 'estudio_suelo' | 'pilote' | 'standby' | 'logistica'
  sondeo?: string | null
  pilote?: string | null
  metros?: number | null
  tramo_inicio?: number | null
  tramo_fin?: number | null
  cota_actual?: number | null
  recobro?: string | null
  ensayos_spt?: number | null
  muestras_shelby?: number | null
  pq?: number | null
  ensanche?: number | null
  encamisado?: number | null
  detalle?: string
  motivo_varada?: string
  resumen?: string
  ya_pregunto?: boolean
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 })
  }
  return new Response('Token no coincide', { status: 403 })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()

    if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
      console.log('📢 ESTADO ENTREGA META:', JSON.stringify(body.entry[0].changes[0].value.statuses, null, 2))
    }

    const entry = body.entry?.[0]
    const changes = entry?.changes?.[0]
    const value = changes?.value
    const message = value?.messages?.[0]

    if (!message) return NextResponse.json({ status: 'ignored_no_message' })

    const from = message.from
    const cleanTo = from.replace(/\D/g, '')
    const localPhone = cleanTo.startsWith('57') ? cleanTo.slice(2) : cleanTo

    const { data: trabajadores } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .or(`telefono.eq.${cleanTo},telefono.eq.${localPhone}`)
      .eq('activo', true)

    const trabajador = trabajadores?.[0]

    if (!trabajador) {
      await enviarWhatsApp(
        from,
        '⚠️ Este número no se encuentra registrado como personal operativo activo en el sistema de JHF Perforaciones.'
      )
      return NextResponse.json({ status: 'unregistered_user' })
    }

    // CLIC EN BOTÓN DE PLANTILLA ("Confirmar recepción")
    if (message.type === 'button' || message.type === 'interactive') {
      const nombreOperador = trabajador.nombre
      const frenteNombre = trabajador.proyectos?.nombre || 'General'

      await supabase.from('trabajadores').update({
        estado_conversacion: 'esperando_reporte_diario',
        borrador_reporte: null
      }).eq('id', trabajador.id)

      await enviarWhatsApp(
        from,
        `👋 ¡Hola ${nombreOperador}! Te saluda el Sistema de Control Operativo de *JHF Perforaciones S.A.S.*\n\n` +
        `¿Cómo les fue hoy en *${frenteNombre}*?\n\n` +
        `Por favor cuéntame en qué punto trabajaron (sondeo o pilote), cuántos metros avanzaron o si tuvieron alguna novedad (lluvia, trasteo o varada).`
      )
      return NextResponse.json({ status: 'button_welcome_sent' })
    }

    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(
        from,
        `👋 Hola ${trabajador.nombre}, este sistema automatizado no escucha audios. Por favor escríbeme en un mensajito corto cómo les fue hoy.`
      )
      return NextResponse.json({ status: 'audio_rejected' })
    }

    if (message.type === 'image') {
      await enviarWhatsApp(
        from,
        `📷 ¡Foto recibida, ${trabajador.nombre}! Si aún no has escrito los datos del avance de hoy, envíamelos en texto para cerrar tu reporte.`
      )
      return NextResponse.json({ status: 'image_received' })
    }

    if (message.type === 'text') {
      const textoCrudo = message.text?.body?.trim() || ''
      const estadoActual = trabajador.estado_conversacion || 'inactivo'
      const canastaPrevia: CanastaReporte = trabajador.borrador_reporte || {}
      const nombreOperador = trabajador.nombre
      const frenteNombre = trabajador.proyectos?.nombre || 'General'

      // Analizar con Gemini AI
      const ai = await analizarConGemini(textoCrudo, nombreOperador, frenteNombre, estadoActual, canastaPrevia)

      // 1. REINICIAR / CANCELAR
      if (ai.categoria === 'reiniciar') {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_reporte_diario',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `🔄 Listo ${nombreOperador}, empezamos de cero. Cuéntame cómo les fue hoy en *${frenteNombre}*.`
        )
        return NextResponse.json({ status: 'cancelled' })
      }

      // 2. CONFIRMACIÓN POSITIVA
      if (ai.categoria === 'confirmacion_positiva' && estadoActual === 'esperando_confirmacion') {
        const b = canastaPrevia

        await supabase.from('reportes_operativos').insert({
          trabajador_id: trabajador.id,
          proyecto_id: trabajador.proyecto_id,
          trabajador_nombre: nombreOperador,
          proyecto_nombre: frenteNombre,
          tipo_operacion: b.tipo || 'estudio_suelo',
          sondeo: b.sondeo || null,
          pilote: b.pilote || null,
          metros_nq: b.metros || 0,
          avance_pq: b.pq || 0,
          ensanche: b.ensanche || 0,
          encamisado: b.encamisado || 0,
          ensayos_spt: b.ensayos_spt || 0,
          observaciones: b.detalle || b.resumen || textoCrudo,
          confirmado: true
        })

        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `✅ *¡Listo ${nombreOperador}! Tu reporte quedó guardado en la bitácora de JHF Perforaciones.*\n\nMuchas gracias por tu gestión de hoy, ¡buen descanso!`
        )
        return NextResponse.json({ status: 'saved' })
      }

      // 3. CONFIRMACIÓN NEGATIVA
      if (ai.categoria === 'confirmacion_negativa' && estadoActual === 'esperando_confirmacion') {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_reporte_diario',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `✍️ Entendido ${nombreOperador}, no lo guardamos. Escríbeme de corrido cómo fue el avance o la actividad real de hoy para corregirlo.`
        )
        return NextResponse.json({ status: 'confirmation_rejected' })
      }

      // 4. DESPEDIDAS Y CORTESÍAS
      if (ai.categoria === 'despedida_cortesia') {
        if (estadoActual === 'esperando_confirmacion') {
          await supabase.from('trabajadores').update({
            estado_conversacion: 'inactivo',
            borrador_reporte: null
          }).eq('id', trabajador.id)
        }

        await enviarWhatsApp(
          from,
          `🙏 ¡Con gusto ${nombreOperador}! Que descanses y tengas una excelente noche. Quedamos atentos para mañana.`
        )
        return NextResponse.json({ status: 'courtesy_replied' })
      }

      // 5. BROMAS O MENSAJES SIN SENTIDO
      if (ai.categoria === 'broma_o_sin_sentido') {
        await enviarWhatsApp(
          from,
          ai.mensaje_al_operador || `😅 ¡Epa ${nombreOperador}! Cuéntame en serio cómo les fue hoy en *${frenteNombre}*: ¿cuántos metros perforaron o qué actividades hicieron?`
        )
        return NextResponse.json({ status: 'joke_handled' })
      }

      // 6. SALUDOS O DUDAS GENERALES
      if (ai.categoria === 'saludo_o_duda') {
        if (estadoActual === 'inactivo') {
          await enviarWhatsApp(
            from,
            `👋 Hola ${nombreOperador}, tu reporte de hoy ya está registrado en el sistema. Si deseas modificarlo o agregar algo, escribe *reiniciar*.`
          )
        } else {
          await enviarWhatsApp(
            from,
            `👋 ¡Hola ${nombreOperador}! ¿Cómo les fue hoy en *${frenteNombre}*?\n\nCuéntame en qué sondeo o pilote estuvieron, cuántos metros avanzaron o qué actividades hicieron hoy.`
          )
        }
        return NextResponse.json({ status: 'greeting_replied' })
      }

      // 7. PREGUNTAR POR DATO FALTANTE
      if (ai.falta_dato && !canastaPrevia.ya_pregunto && estadoActual !== 'esperando_datos_faltantes') {
        const nuevaCanasta = { ...canastaPrevia, ...ai.datos_extraidos, ya_pregunto: true }

        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_datos_faltantes',
          borrador_reporte: nuevaCanasta
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, ai.mensaje_al_operador)
        return NextResponse.json({ status: 'asking_missing_data' })
      }

      // 8. GENERAR FICHA DE RESUMEN Y SOLICITAR CONFIRMACIÓN
      const datosFinales: CanastaReporte = {
        ...canastaPrevia,
        ...ai.datos_extraidos,
        detalle: canastaPrevia.detalle ? `${canastaPrevia.detalle} - ${textoCrudo}` : textoCrudo
      }

      let resumen = ''
      if (datosFinales.tipo === 'pilote') {
        resumen =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* PILOTAJE\n` +
          `• *Pilote:* ${datosFinales.pilote || 'P-01'}\n` +
          `• *Preperforación (PQ):* ${datosFinales.pq ?? datosFinales.metros ?? 0} m\n` +
          `• *Ensanche:* ${datosFinales.ensanche || 0} m\n` +
          `• *Encamisado:* ${datosFinales.encamisado || 0} m\n` +
          `• *Detalle:* ${datosFinales.detalle}`
      } else if (datosFinales.tipo === 'standby' || datosFinales.tipo === 'logistica') {
        resumen =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* ${datosFinales.tipo === 'standby' ? 'NOVEDAD / STANDBY' : 'LOGÍSTICA DE CAMPO'}\n` +
          `• *Detalle:* ${datosFinales.detalle}`
      } else {
        const tramo = (datosFinales.tramo_inicio !== null && datosFinales.tramo_inicio !== undefined && datosFinales.tramo_fin !== null && datosFinales.tramo_fin !== undefined)
          ? ` (De ${datosFinales.tramo_inicio} m a ${datosFinales.tramo_fin} m)`
          : ''
        const spt = datosFinales.ensayos_spt ? `\n• *Ensayos SPT:* ${datosFinales.ensayos_spt}` : ''
        const shelby = datosFinales.muestras_shelby ? `\n• *Muestras Shelby:* ${datosFinales.muestras_shelby}` : ''
        const rec = datosFinales.recobro ? `\n• *Recobro / Muestra:* ${datosFinales.recobro}` : ''

        resumen =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* ESTUDIO DE SUELOS / GEOTECNIA\n` +
          `• *Sondeo / Punto:* ${datosFinales.sondeo || 'S-01'}\n` +
          `• *Avance Perforado:* ${datosFinales.metros ?? 0} m${tramo}${spt}${shelby}${rec}\n` +
          `• *Observaciones:* ${datosFinales.detalle}`
      }

      datosFinales.resumen = resumen

      await supabase.from('trabajadores').update({
        estado_conversacion: 'esperando_confirmacion',
        borrador_reporte: datosFinales
      }).eq('id', trabajador.id)

      await enviarWhatsApp(
        from,
        `📋 *Resumen de tu reporte:*\n\n${resumen}\n\n` +
        `----------------------------\n` +
        `📷 *Recuerda enviar foto de la planilla, caja de muestras o testigo.*\n\n` +
        `¿Está todo correcto? Responde *SÍ* para guardar o escríbeme cualquier corrección.`
      )
      return NextResponse.json({ status: 'draft_ready' })
    }

    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('Error procesando webhook:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function analizarConGemini(
  mensaje: string,
  operador: string,
  frente: string,
  estado: string,
  memoria: CanastaReporte
) {
  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY no configurada. Usando fallback básico.')
    return {
      categoria: 'reporte_avance',
      falta_dato: null,
      mensaje_al_operador: '',
      datos_extraidos: { tipo: 'estudio_suelo', metros: 0 }
    }
  }

  const prompt = `
Eres el analista de operaciones de "JHF Perforaciones S.A.S." en Colombia.
Tu trabajo es interpretar los mensajes de WhatsApp de los perforadores y operarios de campo en obras de geotecnia, sondeos y pilotaje.

Contexto actual:
- Operador: "${operador}"
- Frente de obra: "${frente}"
- Estado conversación: "${estado}"
- Datos previos en memoria: ${JSON.stringify(memoria)}
- Mensaje nuevo del operador: "${mensaje}"

Debes clasificar el mensaje en una de las siguientes categorías exactas:
1. "confirmacion_positiva": Si dice sí, correcto, ok, listo, guardelo, dale, de una, confirmo.
2. "confirmacion_negativa": Si dice no, asi no fue, esta mal, corrijame, no gracias.
3. "despedida_cortesia": Si dice gracias, feliz noche, bendiciones, hasta mañana, que descanse, amen.
4. "broma_o_sin_sentido": Si dice vulgaridades, chistes o comentarios irrelevantes sin relación a la obra.
5. "saludo_o_duda": Si solo dice hola, buenas tardes, que hay que hacer.
6. "reiniciar": Si pide cancelar, anular, reiniciar, empezar de nuevo.
7. "reporte_avance": Si reporta metros, sondeos, pilotes, tramos, ensayos SPT, shelby, recobros.
8. "novedad_operativa": Si reporta lluvia, varada de máquina, trasteo, armado, cambio de punto, falta de ACPM, paro de SST/interventoría.

Reglas técnicas:
- Geotecnia: Sondeos se normalizan como S-01, S-02. Cuchara partida = SPT. Tubo shelby = shelby.
- Pilotes: "prehueco" = preperforación PQ (metros en pq). "ensanche" = ensanche. "camisa/casing" = encamisado. Pilotes se normalizan P-01, P-02.
- Tramos: "de 2 a 5 metros" significa metros = 3 (tramo_inicio: 2, tramo_fin: 5).
- Si es una broma, genera una respuesta profesional pero cordial pidiendo el avance real en "mensaje_al_operador".
- Si faltan metros o el identificador del punto en un reporte técnico, indica "falta_dato": "metros" o "sondeo" o "pilote", y redacta en "mensaje_al_operador" la pregunta amable correspondiente.

Responde ÚNICAMENTE en JSON con la siguiente estructura:
{
  "categoria": "confirmacion_positiva" | "confirmacion_negativa" | "despedida_cortesia" | "broma_o_sin_sentido" | "saludo_o_duda" | "reiniciar" | "reporte_avance" | "novedad_operativa",
  "falta_dato": null | "metros" | "sondeo" | "pilote",
  "mensaje_al_operador": "Texto de respuesta si es saludo, broma o pregunta por dato faltante",
  "datos_extraidos": {
    "tipo": "estudio_suelo" | "pilote" | "standby" | "logistica",
    "sondeo": string | null,
    "pilote": string | null,
    "metros": number | null,
    "tramo_inicio": number | null,
    "tramo_fin": number | null,
    "ensayos_spt": number | null,
    "muestras_shelby": number | null,
    "recobro": string | null,
    "pq": number | null,
    "ensanche": number | null,
    "encamisado": number | null
  }
}
`

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    })

    const data = await res.json()
    const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (rawJson) {
      return JSON.parse(rawJson)
    }
  } catch (err) {
    console.error('Fallo en llamada a Gemini:', err)
  }

  return {
    categoria: 'reporte_avance',
    falta_dato: null,
    mensaje_al_operador: '',
    datos_extraidos: { tipo: 'estudio_suelo', metros: 0 }
  }
}

async function enviarWhatsApp(to: string, text: string) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return

  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text }
    })
  })
}
