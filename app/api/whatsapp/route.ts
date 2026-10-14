import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = 'clave_secreta_reportes_2026'
const META_MESSAGES_URL = 'https://graph.facebook.com/v19.0/1370874296109664/messages'
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
  const token = (searchParams.get('hub.verify_token') || '').trim()
  const challenge = searchParams.get('hub.challenge')

  if (mode === 'subscribe' && (token === META_VERIFY_TOKEN || token === (process.env.WHATSAPP_VERIFY_TOKEN || '').trim())) {
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' }
    })
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
      console.warn(`⚠️ Teléfono no registrado: cleanTo=${cleanTo}, local=${localPhone}`)
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

    const textoCrudo = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || ''
    const textoLimpio = normalizarTexto(textoCrudo)

    // 1. CONFIRMAR RECEPCIÓN DE RONDA
    const esConfirmarRecepcion =
      message.type === 'button' ||
      message.type === 'interactive' ||
      /\b(confirmar recepcion|confirmar|recepcion)\b/i.test(textoLimpio)

    if (esConfirmarRecepcion) {
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

    // 2. CONVERSACIÓN CON LA IA (GEMINI)
    if (message.type === 'text') {
      // Si quiere corregir o reiniciar
      if (/\b(corregir|cambiar|modificar|reiniciar|empezar de nuevo)\b/i.test(textoLimpio)) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_reporte',
          borrador_reporte: { datos: {}, historial: [] }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `🔄 Listo Don ${nombreOperador}, dígame qué modificamos del reporte de hoy y se lo actualizo con gusto.`
        )
        return NextResponse.json({ status: 'reset_flow' })
      }

      // Si el turno ya estaba cerrado y saluda o se despide
      if (estadoActual === 'inactivo' && esDespedidaOInterjeccion(textoLimpio)) {
        await enviarWhatsApp(
          from,
          `🙏 ¡Con todo el gusto Don ${nombreOperador}! Buen descanso y que pase feliz noche.`
        )
        return NextResponse.json({ status: 'closed_courtesy' })
      }

      const nuevoItem: MensajeHistorial = { role: 'user', text: textoCrudo }
      const historialActualizado: MensajeHistorial[] = [...(memoria.historial || []), nuevoItem].slice(-8)

      // Dejamos que Gemini entienda, razone y conduzca la entrevista
      const decisionIA = await consultarGeminiInteligente(
        textoCrudo,
        nombreOperador,
        frenteNombre,
        memoria.datos || {},
        historialActualizado
      )

      console.log('🤖 Decisión de Gemini:', JSON.stringify(decisionIA, null, 2))

      // Guardar el reporte cuando esté confirmado
      if (decisionIA.accion === 'guardar_reporte') {
        const d = { ...(memoria.datos || {}), ...decisionIA.datos_actualizados }
        await guardarOActualizarReporte(trabajador, d, textoCrudo)

        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'saved_by_ai' })
      }

      // Continuar la entrevista o pedir confirmación
      const respuestaItem: MensajeHistorial = { role: 'model', text: decisionIA.respuesta_whatsapp }
      historialActualizado.push(respuestaItem)

      const nuevaMemoria: MemoriaConversacion = {
        datos: { ...(memoria.datos || {}), ...decisionIA.datos_actualizados },
        historial: historialActualizado.slice(-8)
      }

      await supabase.from('trabajadores').update({
        estado_conversacion: decisionIA.accion === 'pedir_confirmacion' ? 'esperando_confirmacion' : 'conversando',
        borrador_reporte: nuevaMemoria
      }).eq('id', trabajador.id)

      await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
      return NextResponse.json({ status: 'conversation_continued' })
    }

    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('❌ Error general en Webhook:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function guardarOActualizarReporte(trabajador: any, d: DatosReporte, textoCrudo: string) {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)

  const { data: existentes } = await supabase
    .from('reportes_operativos')
    .select('id')
    .eq('trabajador_id', trabajador.id)
    .gte('created_at', hoy.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)

  const tipoFinal: TipoOperacion =
    d.tipo ||
    (d.metros === 0 && d.observaciones ? 'standby' : d.pilote || d.pq || d.ensanche ? 'pilote' : 'estudio_suelo')

  const payload = {
    trabajador_id: trabajador.id,
    proyecto_id: trabajador.proyecto_id,
    trabajador_nombre: trabajador.nombre,
    proyecto_nombre: trabajador.proyectos?.nombre || 'General',
    tipo_operacion: tipoFinal,
    sondeo: d.sondeo || null,
    pilote: d.pilote || null,
    metros_nq: d.metros || 0,
    avance_pq: d.pq || 0,
    ensanche: d.ensanche || 0,
    encamisado: d.encamisado || 0,
    ensayos_spt: d.ensayos_spt || 0,
    observaciones: d.observaciones || textoCrudo,
    confirmado: true
  }

  if (existentes && existentes.length > 0) {
    console.log(`📝 Actualizando reporte existente id=${existentes[0].id} para ${trabajador.nombre}`)
    await supabase.from('reportes_operativos').update(payload).eq('id', existentes[0].id)
  } else {
    console.log(`✨ Insertando nuevo reporte para ${trabajador.nombre}`)
    await supabase.from('reportes_operativos').insert(payload)
  }
}

async function consultarGeminiInteligente(
  mensaje: string,
  operador: string,
  frente: string,
  datosPrevios: DatosReporte,
  historial: MensajeHistorial[]
): Promise<{ accion: string; respuesta_whatsapp: string; datos_actualizados: DatosReporte }> {
  // Modelos estables de Google
  const modelos = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest']

  const prompt = `
Eres el Asistente de Operaciones de campo de "JHF Perforaciones S.A.S." en Colombia.
Estás hablando por WhatsApp con "Don ${operador}" en el frente "${frente}".
Tu tono debe ser humano, respetuoso, empático y propio del ambiente de obra en Colombia ("Don ${operador}", "mano", "listo", "hágale", "cuénteme").

TU ROL PRINCIPAL:
Eres un entrevistador operativo ágil. Tu objetivo es entender lo que te cuenta el operador y asegurarte de reunir toda la información necesaria para el informe diario sin complicarle la vida.

INFORMACIÓN TÉCNICA QUE DEBE TENER EL REPORTE:
1. Actividad / Frente: ¿En qué trabajaron? (Sondeo / Estudio de suelo, Pilotaje / Prehueco PQ / Ensanche, o Standby / Varada mecánica / Lluvia / Paro de SST).
2. Punto o Elemento: ¿Cuál sondeo (ej: S-01) o pilote (ej: P-01)? Si el operador no sabe el número o dice que le toca preguntar, pon "P-01 (Por verificar)" o "S-01 (Por verificar)" sin discutir.
3. Avance en Metros: Metros lineales perforados. Si estuvieron varados o parados todo el turno, el avance es 0.0 metros.
4. Novedades / Observaciones: Motivo de varada (correas, poleas, bombas, combustible), clima, temas de SST, etc.

CÓMO CONDUCIR LA CONVERSACIÓN:
- Escucha con atención: Si el operador hace bromas, se desahoga o usa jerga de obra pesada ("carechimba", "mariconsuelo", chistes de doble sentido), tómalo con buen humor y camaradería, y con respeto condúcelo a la información técnica.
- Pregunta lo que falte:
  * Si te dice que estuvo varado por una polea o correa, respóndele con empatía ("¡Qué vaina Don ${operador}!") y pregúntale si alcanzaron a avanzar algo antes del daño o si quedaron en 0 metros.
  * Si te dice los metros pero no qué estaban haciendo o en qué punto, pregúntaselo con naturalidad.
- Resumen y Confirmación:
  * Cuando ya tengas la información completa (actividad, punto, metros y novedades) O cuando el operador te diga que no hay más datos:
    Hazle un resumen claro y cordial de la jornada y pregúntale si está todo correcto para guardarlo en bitácora (acción: "pedir_confirmacion").
- Guardar el reporte:
  * Si el operador responde confirmando ("sí", "listo", "de una", "dejemos así", "correcto", "dale", "ok"):
    Agradécele cordialmente, deséale un buen descanso y marca acción: "guardar_reporte".

DATOS PREVIOS RECOLECTADOS HASTA AHORA:
${JSON.stringify(datosPrevios)}

HISTORIAL DE LA CONVERSACIÓN:
${historial.map(h => `${h.role}:${h.text}`).join('\n')}

ÚLTIMO MENSAJE DEL OPERADOR:
"${mensaje}"

Responde ÚNICAMENTE un JSON válido con esta estructura:
{
  "accion": "conversar" | "pedir_confirmacion" | "guardar_reporte",
  "respuesta_whatsapp": "El mensaje que le enviarás al operador por WhatsApp",
  "datos_actualizados": {
    "tipo": "estudio_suelo" | "pilote" | "standby" | "logistica",
    "sondeo": string | null,
    "pilote": string | null,
    "metros": number | null,
    "pq": number | null,
    "ensanche": number | null,
    "encamisado": number | null,
    "ensayos_spt": number | null,
    "observaciones": string | null
  }
}
`

  // Umbral seguro para que Gemini no lance error 400 pero tolere jerga de obra
  const safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
  ]

  for (const modelo of modelos) {
    if (!GEMINI_API_KEY) {
      console.error('❌ Falta GEMINI_API_KEY en las variables de entorno')
      break
    }

    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          safetySettings,
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
      } else {
        const errBody = await res.text()
        console.warn(`⚠️ Modelo ${modelo} falló con status ${res.status}:`, errBody)
      }
    } catch (e: any) {
      console.warn(`⚠️ Excepción llamando a ${modelo}:`, e.message)
    }
  }

  // Respaldo de cortesía únicamente en caso extremo de desconexión de Google
  return {
    accion: 'conversar',
    respuesta_whatsapp: `Don ${operador}, qué pena que se me entrecortó la señal mano. ¿Me repite porfa lo último que me dijo sobre cómo les fue hoy?`,
    datos_actualizados: { ...datosPrevios }
  }
}

function normalizarTexto(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim()
}

function esDespedidaOInterjeccion(limpio: string): boolean {
  const palabras = [
    'gracias', 'ok gracias', 'muchas gracias', 'feliz noche', 'buenas noches',
    'hasta manana', 'bendiciones', 'que descanse', 'uuy', 'uy', 'epa', 'listo gracias',
    'vale gracias', 'todo bien', 'chao', 'amen', 'nos vemos', '👍', '🙏', 'gracias mano'
  ]
  return palabras.includes(limpio)
}

async function enviarWhatsApp(to: string, text: string) {
  const token = (process.env.WHATSAPP_ACCESS_TOKEN || '').replace(/['"]/g, '').trim()

  if (!token) {
    console.error('❌ Falta WHATSAPP_ACCESS_TOKEN en las variables de Vercel')
    return
  }

  try {
    const res = await fetch(META_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
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
      console.log(`✅ Mensaje entregado a WhatsApp con éxito para: ${to}`)
    }
  } catch (err: any) {
    console.error('❌ Excepción de red enviando a Meta Graph API:', err.message)
  }
}
