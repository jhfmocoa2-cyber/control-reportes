import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'clave_secreta_reportes_2026'
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ''

type TipoOperacion = 'estudio_suelo' | 'pilote' | 'standby' | 'logistica'

interface MensajeHistorial {
  role: string
  text: string
}

interface DatosReporte {
  tipo?: TipoOperacion
  sondeo?: string | null
  pilote?: string | null
  metros?: number | null
  pq?: number | null
  ensanche?: number | null
  encamisado?: number | null
  ensayos_spt?: number | null
  recobro?: string | null
  observaciones?: string | null
}

interface MemoriaConversacion {
  datos?: DatosReporte
  historial?: MensajeHistorial[]
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
    console.log('📩 WEBHOOK RECIBIDO:', JSON.stringify(body, null, 2))

    const entry = body.entry?.[0]
    const changes = entry?.changes?.[0]
    const value = changes?.value
    const message = value?.messages?.[0]

    if (!message) {
      return NextResponse.json({ status: 'ignored_no_message' })
    }

    const from = message.from
    const cleanTo = from.replace(/\D/g, '')
    // Extraer número local (soporta 573... y 5793...)
    const localPhone = cleanTo.replace(/^579?/, '')

    const { data: trabajadores, error: errTrabajador } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .or(`telefono.eq.${cleanTo},telefono.eq.${localPhone},telefono.eq.57${localPhone}`)
      .eq('activo', true)

    if (errTrabajador) {
      console.error('❌ Error consultando trabajador en Supabase:', errTrabajador)
    }

    const trabajador = trabajadores?.[0]

    if (!trabajador) {
      console.warn(`⚠️ Teléfono no registrado en BD: cleanTo=${cleanTo}, local=${localPhone}`)
      await enviarWhatsApp(
        from,
        '⚠️ Este número no se encuentra registrado como personal operativo activo en el sistema de JHF Perforaciones.'
      )
      return NextResponse.json({ status: 'unregistered_user' })
    }

    const nombreOperador = trabajador.nombre
    const frenteNombre = trabajador.proyectos?.nombre || 'General'
    const estadoActual = trabajador.estado_conversacion || 'inactivo'

    const rawMemoria = (trabajador.borrador_reporte as any) || {}
    const memoria: MemoriaConversacion = {
      datos: rawMemoria.datos || (rawMemoria.tipo ? rawMemoria : {}),
      historial: Array.isArray(rawMemoria.historial) ? rawMemoria.historial : []
    }

    // EXTRAER TEXTO O CONTENIDO DEL MENSAJE
    const textoCrudo = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || ''
    const textoLimpio = normalizarTexto(textoCrudo)

    // 1. RECEPCIÓN DE RONDA (BOTÓN, INTERACCIÓN O TEXTO "CONFIRMAR RECEPCIÓN")
    const esConfirmarRecepcion =
      message.type === 'button' ||
      message.type === 'interactive' ||
      /\b(confirmar recepcion|confirmar|recepcion)\b/i.test(textoLimpio)

    if (esConfirmarRecepcion) {
      console.log(`✅ Recepción confirmada para ${nombreOperador}. Iniciando reporte diario.`)

      await supabase.from('trabajadores').update({
        estado_conversacion: 'esperando_reporte',
        borrador_reporte: { datos: {}, historial: [] }
      }).eq('id', trabajador.id)

      await enviarWhatsApp(
        from,
        `👋 ¡Hola Don ${nombreOperador}! Te saluda el Asistente de Operaciones de *JHF Perforaciones S.A.S.*\n\n` +
        `¿Cómo les fue hoy en *${frenteNombre}*?\n\n` +
        `Cuéntame cómo avanzaron (metros en sondeo o pilote) o si tuvieron novedades (lluvia, trasteo, SST o varadas).`
      )
      return NextResponse.json({ status: 'welcome_sent' })
    }

    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(
        from,
        `👋 Don ${nombreOperador}, por ahora no puedo escuchar notas de voz. Escríbame porfa en un mensajito corto cómo les fue hoy.`
      )
      return NextResponse.json({ status: 'audio_rejected' })
    }

    if (message.type === 'image') {
      await enviarWhatsApp(
        from,
        `📷 ¡Foto recibida, Don ${nombreOperador}! Queda registrada como soporte en la bitácora.`
      )
      return NextResponse.json({ status: 'image_received' })
    }

    // 2. PROCESAMIENTO DE TEXTO
    if (message.type === 'text') {
      // Si el turno ya estaba cerrado
      if (estadoActual === 'inactivo') {
        if (esDespedidaOInterjeccion(textoLimpio)) {
          await enviarWhatsApp(
            from,
            `🙏 ¡Con todo el gusto Don ${nombreOperador}! Buen descanso y que pase feliz noche. Quedamos atentos para mañana.`
          )
          return NextResponse.json({ status: 'closed_turn_courtesy' })
        }

        const quiereReportar = /\b(reiniciar|corregir|cambiar|nuevo reporte|reportar|modificar|otro reporte)\b/i.test(textoLimpio) ||
                               /\b(\d+|un|uno|dos|tres|cuatro|cinco)\s*(?:m|mt|metros|pq|prehueco|sondeo|pilote)\b/i.test(textoLimpio)

        if (!quiereReportar) {
          await enviarWhatsApp(
            from,
            `👍 Don ${nombreOperador}, su reporte de hoy ya quedó debidamente guardado en la bitácora de JHF Perforaciones. ¡Que descanse!\n\n*(Si necesita corregirlo o reportar algo adicional, escriba "corregir")*`
          )
          return NextResponse.json({ status: 'already_saved_acknowledged' })
        }

        memoria.datos = {}
        memoria.historial = []
      }

      // Reiniciar
      if (/\b(cancelar|anular|borrar|reiniciar|empezar de nuevo)\b/i.test(textoLimpio)) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_reporte',
          borrador_reporte: { datos: {}, historial: [] }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, `🔄 Listo Don ${nombreOperador}, borramos lo anterior y empezamos de cero. Cuéntame cómo les fue hoy en *${frenteNombre}*.`)
        return NextResponse.json({ status: 'reset' })
      }

      // Confirmación directa con "SÍ"
      if (estadoActual === 'esperando_confirmacion' && esConfirmacion(textoLimpio)) {
        const d = memoria.datos || {}

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
          observaciones: d.observaciones || textoCrudo,
          confirmado: true
        })

        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `✅ *¡Listo Don ${nombreOperador}! Su reporte quedó guardado exitosamente en la bitácora de JHF Perforaciones.*\n\nMuchas gracias por su compromiso de hoy, ¡que tenga un excelente descanso!`
        )
        return NextResponse.json({ status: 'saved_direct' })
      }

      // Evaluación inteligente con Gemini
      const nuevoItem: MensajeHistorial = { role: 'user', text: textoCrudo }
      const historialActualizado: MensajeHistorial[] = [...(memoria.historial || []), nuevoItem].slice(-6)

      const decisionIA = await consultarGeminiInteligente(
        textoCrudo,
        nombreOperador,
        frenteNombre,
        memoria.datos || {},
        historialActualizado
      )

      if (decisionIA.accion === 'guardar_reporte') {
        const d = { ...(memoria.datos || {}), ...decisionIA.datos_actualizados }

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
          observaciones: d.observaciones || textoCrudo,
          confirmado: true
        })

        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'saved_by_ai' })
      }

      const respuestaItem: MensajeHistorial = { role: 'model', text: decisionIA.respuesta_whatsapp }
      historialActualizado.push(respuestaItem)

      const nuevaMemoria: MemoriaConversacion = {
        datos: { ...(memoria.datos || {}), ...decisionIA.datos_actualizados },
        historial: historialActualizado.slice(-6)
      }

      await supabase.from('trabajadores').update({
        estado_conversacion: decisionIA.accion === 'pedir_confirmacion' ? 'esperando_confirmacion' : 'conversando',
        borrador_reporte: nuevaMemoria
      }).eq('id', trabajador.id)

      await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
      return NextResponse.json({ status: 'replied_smart' })
    }

    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('❌ Error general en Webhook:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function consultarGeminiInteligente(
  mensaje: string,
  operador: string,
  frente: string,
  datosPrevios: DatosReporte,
  historial: MensajeHistorial[]
): Promise<{ accion: string; respuesta_whatsapp: string; datos_actualizados: DatosReporte }> {
  const modelos = ['gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.5-flash']

  const prompt = `
Eres el Asistente de Operaciones de "JHF Perforaciones S.A.S." en Colombia.
Hablas con "Don ${operador}" en el frente "${frente}". Tono humano, cercano, respetuoso de obra ("Don ${operador}", "mano", "listo").

DATOS TÉCNICOS PREVIOS: ${JSON.stringify(datosPrevios)}
HISTORIAL:
${historial.map(h => `${h.role}:${h.text}`).join('\n')}
ÚLTIMO MENSAJE: "${mensaje}"

REGLAS:
1. Si no sabe el pilote ("no sé en cuál estoy", "me toca preguntar"), pon "Pilote: Por verificar" o "P-01 (Provisional)" y pide confirmación sin pelear ni inventar sondeos.
2. Si confirma ("si", "ok", "listo", "de una"), accion: "guardar_reporte".
3. Si dice bromas, responde con chispa y pídele en serio los datos de la obra.
4. "prehueco" o "PQ" = avance pq (pilote).

Devuelve ÚNICAMENTE un JSON:
{
  "accion": "conversar" | "pedir_confirmacion" | "guardar_reporte",
  "respuesta_whatsapp": "Texto para WhatsApp",
  "datos_actualizados": {
    "tipo": "estudio_suelo" | "pilote" | "standby" | "logistica",
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
        let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        raw = raw.replace(/^```json/im, '').replace(/^```/im, '').replace(/```$/im, '').trim()
        if (raw) {
          const parsed = JSON.parse(raw)
          return {
            accion: parsed.accion || 'conversar',
            respuesta_whatsapp: parsed.respuesta_whatsapp || '',
            datos_actualizados: (parsed.datos_actualizados || {}) as DatosReporte
          }
        }
      }
    } catch (e: any) {
      console.warn(`Error llamando a ${modelo}:`, e.message)
    }
  }

  return respaldoContextual(mensaje, operador, frente, datosPrevios)
}

function respaldoContextual(
  raw: string,
  operador: string,
  frente: string,
  previo: DatosReporte
): { accion: string; respuesta_whatsapp: string; datos_actualizados: DatosReporte } {
  const t = normalizarTexto(raw)
  const esPilote = previo.tipo === 'pilote' || /\b(pilote|pilotaje|pq|prehueco|pre hueco)\b/i.test(t)
  const punto = esPilote ? (previo.pilote || 'P-01 (Por verificar)') : (previo.sondeo || 'S-01')
  const pq = esPilote ? (previo.pq || 2) : 0
  const metros = !esPilote ? (previo.metros || 2) : 0
  const obs = previo.observaciones || 'Labores detenidas por SST'
  const tipoCalculado: TipoOperacion = esPilote ? 'pilote' : 'estudio_suelo'

  if (esConfirmacion(t)) {
    return {
      accion: 'guardar_reporte',
      respuesta_whatsapp: `✅ *¡Listo Don ${operador}! Su reporte quedó guardado en la bitácora de JHF Perforaciones.*\n\n¡Que descanse mano!`,
      datos_actualizados: { ...previo }
    }
  }

  return {
    accion: 'pedir_confirmacion',
    respuesta_whatsapp:
      `¡Tranquilo Don ${operador}! Dejamos el punto como *${punto}* con sus${pq || metros} m y la novedad de SST.\n\n` +
      `¿Le parece bien para guardarlo en bitácora? Responda *SÍ* para confirmar.`,
    datos_actualizados: {
      tipo: tipoCalculado,
      pilote: esPilote ? punto : null,
      sondeo: !esPilote ? punto : null,
      pq,
      metros,
      observaciones: obs
    }
  }
}

function normalizarTexto(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim()
}

function esConfirmacion(limpio: string): boolean {
  return /^(si|sii|siii|sip|ok|okay|listo|correcto|confirmo|confirmado|de una|dale|asi es|mm si|si senor)$/i.test(limpio) ||
         /^si\b/i.test(limpio)
}

function esDespedidaOInterjeccion(limpio: string): boolean {
  const palabras = [
    'gracias', 'ok gracias', 'muchas gracias', 'feliz noche', 'buenas noches',
    'hasta manana', 'bendiciones', 'que descanse', 'uuy', 'uy', 'epa', 'listo gracias',
    'vale gracias', 'todo bien', 'chao', 'amen', 'nos vemos', '👍', '🙏', 'gracias mano'
  ]
  return palabras.includes(limpio) || /^(gracias|ok gracias|chao|feliz noche|buenas noches|uuy|uy)$/i.test(limpio)
}

async function enviarWhatsApp(to: string, text: string) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error('❌ Credenciales incompletas para enviar WhatsApp:', {
      hasToken: Boolean(WHATSAPP_TOKEN),
      hasPhoneId: Boolean(PHONE_NUMBER_ID)
    })
    return
  }

  try {
    const res = await fetch(`[https://graph.facebook.com/v19.0/$](https://graph.facebook.com/v19.0/$){PHONE_NUMBER_ID}/messages`, {
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

    if (!res.ok) {
      const errText = await res.text()
      console.error(`❌ Meta API rechazó el mensaje (${res.status}):`, errText)
    } else {
      console.log(`📤 Mensaje entregado a Meta con éxito para: ${to}`)
    }
  } catch (err: any) {
    console.error('❌ Excepción de red enviando a Meta Graph API:', err.message)
  }
}
