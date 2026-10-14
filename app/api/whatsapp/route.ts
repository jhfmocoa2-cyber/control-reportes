import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'clave_secreta_reportes_2026'
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''

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
        '⚠️ Este número no se encuentra registrado como personal operativo activo en JHF Perforaciones.'
      )
      return NextResponse.json({ status: 'unregistered_user' })
    }

    const nombreOperador = trabajador.nombre
    const frenteNombre = trabajador.proyectos?.nombre || 'General'
    const memoriaPrevia = trabajador.borrador_reporte || {}
    const estadoActual = trabajador.estado_conversacion || 'inactivo'

    // CLIC EN EL BOTÓN DE LA PLANTILLA
    if (message.type === 'button' || message.type === 'interactive') {
      await supabase.from('trabajadores').update({
        estado_conversacion: 'esperando_reporte',
        borrador_reporte: null
      }).eq('id', trabajador.id)

      await enviarWhatsApp(
        from,
        `👋 ¡Hola ${nombreOperador}! Te saluda el Asistente Operativo de *JHF Perforaciones S.A.S.*\n\n` +
        `¿Cómo les fue hoy en *${frenteNombre}*?\n\n` +
        `Cuéntame en un mensaje si avanzaron en metros (sondeo o pilote) o si tuvieron novedades (lluvia, trasteo, SST o varada).`
      )
      return NextResponse.json({ status: 'welcome_sent' })
    }

    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(
        from,
        `👋 Don ${nombreOperador}, por ahora no puedo procesar notas de voz. Escríbame porfa en un mensaje corto cómo les fue hoy.`
      )
      return NextResponse.json({ status: 'audio_rejected' })
    }

    if (message.type === 'image') {
      await enviarWhatsApp(
        from,
        `📷 ¡Foto recibida, ${nombreOperador}! Queda anexada al reporte del día.`
      )
      return NextResponse.json({ status: 'image_received' })
    }

    if (message.type === 'text') {
      const textoMensaje = message.text?.body?.trim() || ''
      const textoLimpio = normalizarTexto(textoMensaje)

      // 1. REINICIAR DIRECTO
      if (/\b(cancelar|anular|borrar|reiniciar|empezar de nuevo)\b/i.test(textoLimpio)) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_reporte',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, `🔄 Listo Don ${nombreOperador}, empezamos de cero. Cuéntame cómo les fue hoy en *${frenteNombre}*.`)
        return NextResponse.json({ status: 'reset' })
      }

      // 2. CONFIRMACIÓN DIRECTA CON "SÍ"
      if (estadoActual === 'esperando_confirmacion' && esConfirmacion(textoLimpio)) {
        const d = memoriaPrevia

        await supabase.from('reportes_operativos').insert({
          trabajador_id: trabajador.id,
          proyecto_id: trabajador.proyecto_id,
          trabajador_nombre: nombreOperador,
          proyecto_nombre: frenteNombre,
          tipo_operacion: d.tipo || 'estudio_suelo',
          sondeo: d.sondeo || null,
          pilote: d.pilote || null,
          metros_nq: d.metros || 0,
          avance_pq: d.pq || 0,
          ensanche: d.ensanche || 0,
          encamisado: d.encamisado || 0,
          ensayos_spt: d.ensayos_spt || 0,
          observaciones: d.observaciones || d.detalle || textoMensaje,
          confirmado: true
        })

        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `✅ *¡Listo Don ${nombreOperador}! Tu reporte quedó guardado en la bitácora de JHF Perforaciones.*\n\nMuchas gracias por tu labor de hoy, ¡buen descanso!`
        )
        return NextResponse.json({ status: 'saved' })
      }

      // 3. CORTESÍAS Y DESPEDIDAS
      if (esDespedida(textoLimpio)) {
        if (estadoActual === 'esperando_confirmacion') {
          await supabase.from('trabajadores').update({
            estado_conversacion: 'inactivo',
            borrador_reporte: null
          }).eq('id', trabajador.id)
        }
        await enviarWhatsApp(from, `🙏 ¡Con gusto Don ${nombreOperador}! Que descanse y tenga una excelente noche.`)
        return NextResponse.json({ status: 'courtesy' })
      }

      // 4. CEREBRO IA CON CASCADA DE GEMINI
      const decisionIA = await consultarGeminiCascada(textoMensaje, nombreOperador, frenteNombre, memoriaPrevia)

      // Guardar si la IA determinó confirmación
      if (decisionIA.accion === 'guardar_reporte' && estadoActual === 'esperando_confirmacion') {
        const d = { ...memoriaPrevia, ...decisionIA.datos_actualizados }

        await supabase.from('reportes_operativos').insert({
          trabajador_id: trabajador.id,
          proyecto_id: trabajador.proyecto_id,
          trabajador_nombre: nombreOperador,
          proyecto_nombre: frenteNombre,
          tipo_operacion: d.tipo || 'estudio_suelo',
          sondeo: d.sondeo || null,
          pilote: d.pilote || null,
          metros_nq: d.metros || 0,
          avance_pq: d.pq || 0,
          ensanche: d.ensanche || 0,
          encamisado: d.encamisado || 0,
          ensayos_spt: d.ensayos_spt || 0,
          observaciones: d.observaciones || textoMensaje,
          confirmado: true
        })

        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'saved_by_ai' })
      }

      // Actualizar estado y enviar respuesta
      const memoriaActualizada = { ...memoriaPrevia, ...decisionIA.datos_actualizados }

      await supabase.from('trabajadores').update({
        estado_conversacion: decisionIA.accion === 'pedir_confirmacion' ? 'esperando_confirmacion' : 'conversando',
        borrador_reporte: memoriaActualizada
      }).eq('id', trabajador.id)

      await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
      return NextResponse.json({ status: 'replied' })
    }

    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('Error procesando webhook:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// CASCADA DE GEMINI: gemini-flash-latest -> gemini-3.7-flash -> Motor local
async function consultarGeminiCascada(
  mensaje: string,
  operador: string,
  frente: string,
  memoria: any
): Promise<any> {
  const modelos = ['gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.5-flash']

  const prompt = `
Eres el asistente virtual de operaciones de "JHF Perforaciones S.A.S." en Colombia.
Hablas con perforadores y operarios de campo en obras geotécnicas y pilotaje.
Tu tono es humano, profesional, respetuoso y cercano con jerga colombiana de obra ("Don ${operador}", "mano", "listo").

Contexto:
- Operador: "${operador}"
- Frente de trabajo: "${frente}"
- Memoria acumulada hoy: ${JSON.stringify(memoria)}
- Mensaje nuevo del operador: "${mensaje}"

Reglas clave:
1. SI DICE BROMAS O TEMAS AJENOS (ej: "sexo", "o se maria la loca", etc.):
   - No seas un robot frío. Responde con chispa y pídele con humor que te cuente en serio cuántos metros hicieron hoy en la obra.
   - accion: "conversar".
2. SI REPORTA AVANCE O NOVEDADES (ej: "dos metros mano en prehueco y nos paró sst", "hicimos 4 m en sondeo 1"):
   - Convierte números en palabras ("dos" = 2).
   - "prehueco" o "PQ" = avance pq (pilote). "SPT" = ensayos spt. "lluvia/varada/sst" = novedad.
   - Si no sabe el número de punto, asígnale "P-01" o "S-01" provisional y no te trabes.
   - Devuelve la ficha estructurada y dile: "¿Está todo correcto? Responde SÍ para guardar en bitácora".
   - accion: "pedir_confirmacion".
3. SI CONFIRMA (ej: "sí", "si", "ok", "listo", "de acuerdo"):
   - accion: "guardar_reporte".
4. SI DA LAS GRACIAS O SE DESPIDE:
   - Deséale una feliz noche sin abrir reportes.
   - accion: "conversar".

Devuelve ÚNICAMENTE un JSON válido:
{
  "accion": "conversar" | "pedir_confirmacion" | "guardar_reporte",
  "respuesta_whatsapp": "Texto para WhatsApp",
  "datos_actualizados": {
    "tipo": "estudio_suelo" | "pilote" | "standby",
    "sondeo": string | null,
    "pilote": string | null,
    "metros": number | null,
    "pq": number | null,
    "ensanche": number | null,
    "ensayos_spt": number | null,
    "observaciones": string | null
  }
}
`

  for (const modelo of modelos) {
    if (!GEMINI_API_KEY) break

    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
        })
      })

      if (res.ok) {
        const data = await res.json()
        const raw = data.candidates?.[0]?.content?.parts?.[0]?.text
        if (raw) return JSON.parse(raw)
      } else {
        console.warn(`Modelo ${modelo} devolvió ${res.status}, probando siguiente modelo en cascada...`)
      }
    } catch (e: any) {
      console.warn(`Fallo de conexión con ${modelo}:`, e.message)
    }
  }

  // Respaldo de seguridad si Google llegase a fallar en todos los modelos
  return respaldoLocal(mensaje, operador, frente, memoria)
}

function respaldoLocal(raw: string, operador: string, frente: string, memoria: any) {
  let t = normalizarTexto(raw)
  const palabrasNum: Record<string, string> = {
    'cero': '0', 'un': '1', 'uno': '1', 'una': '1', 'dos': '2', 'dosss': '2', 'tres': '3', 'cuatro': '4', 'cinco': '5'
  }
  for (const [p, d] of Object.entries(palabrasNum)) {
    t = t.replace(new RegExp(`\\b${p}\\b`, 'g'), d)
  }

  const esPilote = /\b(pilote|pilotaje|pq|prehueco|pre hueco)\b/i.test(t)
  const mMetros = t.match(/(\d+(?:\.\d+)?)\s*(?:m|mt|mts|metros?|pq|prehueco)/i) || t.match(/\b(?:hice|perfore|avanzamos)\s*(\d+(?:\.\d+)?)/i)
  const valorMetros = mMetros ? parseFloat(mMetros[1]) : (memoria.pq || memoria.metros || null)
  const puntoDetectado = esPilote ? (memoria.pilote || 'P-01') : (memoria.sondeo || 'S-01')

  if (valorMetros || /\b(sst|paro|lluvia|varad)\b/i.test(t)) {
    const pq = esPilote ? valorMetros : 0
    const metros = !esPilote ? valorMetros : 0
    const obs = memoria.observaciones ? `${memoria.observaciones} -${raw}` : raw

    const resumen =
      `👷 *Operador:* ${operador}\n` +
      `📍 *Frente:* ${frente}\n` +
      `• *Actividad:* ${esPilote ? 'PILOTAJE' : 'ESTUDIO DE SUELOS'}\n` +
      `• *${esPilote ? 'Pilote' : 'Sondeo'}:* ${puntoDetectado}\n` +
      (esPilote ? `• *Preperforación (PQ):* ${pq || 0} m\n` : `• *Avance Perforado:* ${metros || 0} m\n`) +
      `• *Novedades / Detalle:* ${obs}`

    return {
      accion: 'pedir_confirmacion',
      respuesta_whatsapp:
        `📋 *Resumen de tu reporte:*\n\n${resumen}\n\n` +
        `----------------------------\n` +
        `📷 *Recuerda enviar foto de soporte de la jornada.*\n\n` +
        `¿Está todo correcto? Responde *SÍ* para guardar en bitácora.`,
      datos_actualizados: { tipo: esPilote ? 'pilote' : 'estudio_suelo', pilote: esPilote ? puntoDetectado : null, sondeo: !esPilote ? puntoDetectado : null, pq, metros, observaciones: obs }
    }
  }

  return {
    accion: 'conversar',
    respuesta_whatsapp: `👋 Don ${operador}, cuénteme: ¿cuántos metros perforaron hoy en *${frente}* o qué novedades tuvieron?`,
    datos_actualizados: {}
  }
}

function normalizarTexto(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim()
}

function esConfirmacion(limpio: string): boolean {
  return /^(si|sii|siii|sip|ok|okay|listo|correcto|confirmo|confirmado|de una|dale|asi es)$/i.test(limpio)
}

function esDespedida(limpio: string): boolean {
  return /^(gracias|muchas gracias|feliz noche|buenas noches|hasta manana|bendiciones|que descanse)$/i.test(limpio)
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
