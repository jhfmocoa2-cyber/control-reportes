import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = 'clave_secreta_reportes_2026'
const META_MESSAGES_URL = 'https://graph.facebook.com/v19.0/1370874296109664/messages'

type TipoOperacion = 'estudio_suelo' | 'pilote' | 'standby' | 'logistica'
interface MensajeHistorial { role: string; text: string }

interface DatosReporte {
  tipo?: TipoOperacion; sondeo?: string | null; pilote?: string | null;
  metros?: number | null; pq?: number | null; ensanche?: number | null;
  encamisado?: number | null; ensayos_spt?: number | null; observaciones?: string | null;
}

interface MemoriaConversacion { datos?: DatosReporte; historial?: MensajeHistorial[]; last_msg_id?: string }

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get('hub.mode')
  const token = (searchParams.get('hub.verify_token') || '').trim()
  const challenge = searchParams.get('hub.challenge')
  if (mode === 'subscribe' && (token === META_VERIFY_TOKEN || token === (process.env.WHATSAPP_VERIFY_TOKEN || '').trim())) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }
  return new Response('Token no coincide', { status: 403 })
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const entry = body.entry?.[0]
    const message = entry?.changes?.[0]?.value?.messages?.[0]
    if (!message) return NextResponse.json({ status: 'ignored_no_message' })

    const from = message.from
    const cleanTo = from.replace(/\D/g, '')
    const localPhone = cleanTo.replace(/^579?/, '')

    const { data: trabajadores } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .or(`telefono.eq.${cleanTo},telefono.eq.${localPhone},telefono.eq.57${localPhone}`)
      .eq('activo', true)

    const trabajador = trabajadores?.[0]
    if (!trabajador) return NextResponse.json({ status: 'unregistered_user' })

    const nombreOperador = trabajador.nombre
    const frenteNombre = trabajador.proyectos?.nombre || 'General'
    const estadoActual = trabajador.estado_conversacion || 'inactivo'
    const rawMemoria = (trabajador.borrador_reporte as any) || {}
    
    // Filtro anti-duplicados de Meta
    if (rawMemoria.last_msg_id === message.id) return NextResponse.json({ status: 'ignored_duplicate' })

    const memoria: MemoriaConversacion = {
      datos: rawMemoria.datos || (rawMemoria.tipo ? rawMemoria : {}),
      historial: Array.isArray(rawMemoria.historial) ? rawMemoria.historial : []
    }

    const textoCrudo = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || ''
    const textoLimpio = normalizarTexto(textoCrudo)
    
    if (/\b(reiniciar|empezar de nuevo|borrar todo|corregir)\b/i.test(textoLimpio)) {
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte', borrador_reporte: { datos: {}, historial: [], last_msg_id: message.id } }).eq('id', trabajador.id)
      await enviarWhatsApp(from, `🔄 Listo Don ${nombreOperador}, sistema destrabado. ¿Qué novedades tenemos?`)
      return NextResponse.json({ status: 'reset_flow' })
    }

    const esSaludo = /\b(hola|ola|holi|oli|buenas|buenos dias|buenas tardes|buenas noches|que mas|saludos|confirmar recepcion|recepcion)\b/i.test(textoLimpio)
    if ((message.type === 'button' || message.type === 'interactive' || esSaludo) && (estadoActual === 'inactivo' || estadoActual === 'esperando_reporte')) {
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte', borrador_reporte: { datos: {}, historial: [], last_msg_id: message.id } }).eq('id', trabajador.id)
      await enviarWhatsApp(from, `👋 ¡Hola Don ${nombreOperador}! Te saluda el Asistente de Operaciones de *JHF Perforaciones S.A.S.*\n\n¿Cómo les fue hoy en *${frenteNombre}*?\n\nCuéntame cómo avanzaron o si tuvieron novedades (lluvia, SST o varadas).`)
      return NextResponse.json({ status: 'welcome_sent' })
    }

    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(from, `👋 Don ${nombreOperador}, por ahora no puedo escuchar audios. Escríbame porfa un mensajito con el reporte.`)
      return NextResponse.json({ status: 'audio_rejected' })
    }
    if (message.type === 'image') {
      await enviarWhatsApp(from, `📷 ¡Foto recibida, Don ${nombreOperador}! Queda registrada como soporte en la bitácora.`)
      return NextResponse.json({ status: 'image_received' })
    }

    if (message.type === 'text') {
      if (estadoActual === 'inactivo' && esDespedidaOInterjeccion(textoLimpio)) {
        await enviarWhatsApp(from, `🙏 ¡Con todo el gusto Don ${nombreOperador}! Buen descanso.`)
        return NextResponse.json({ status: 'closed_courtesy' })
      }

      await supabase.from('trabajadores').update({ borrador_reporte: { ...rawMemoria, last_msg_id: message.id } }).eq('id', trabajador.id)
      const nuevoItem: MensajeHistorial = { role: 'user', text: textoCrudo }
      const historialActualizado: MensajeHistorial[] = [...(memoria.historial || []), nuevoItem].slice(-8)

      const decisionIA = await consultarGroq(textoCrudo, nombreOperador, frenteNombre, memoria.datos || {}, historialActualizado)

      if (decisionIA.accion === 'guardar_reporte') {
        const d = { ...(memoria.datos || {}), ...decisionIA.datos_actualizados }
        await guardarOActualizarReporte(trabajador, d, textoCrudo)
        await supabase.from('trabajadores').update({ estado_conversacion: 'inactivo', borrador_reporte: null }).eq('id', trabajador.id)
        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'saved_by_ai' })
      }

      const respuestaItem: MensajeHistorial = { role: 'model', text: decisionIA.respuesta_whatsapp }
      historialActualizado.push(respuestaItem)
      const nuevaMemoria: MemoriaConversacion = {
        datos: { ...(memoria.datos || {}), ...decisionIA.datos_actualizados }, historial: historialActualizado.slice(-8), last_msg_id: message.id
      }
      await supabase.from('trabajadores').update({
        estado_conversacion: decisionIA.accion === 'pedir_confirmacion' ? 'esperando_confirmacion' : 'conversando', borrador_reporte: nuevaMemoria
      }).eq('id', trabajador.id)

      await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
      return NextResponse.json({ status: 'conversation_continued' })
    }
    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('❌ Error general:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function guardarOActualizarReporte(trabajador: any, d: DatosReporte, textoCrudo: string) {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  const { data: existentes } = await supabase.from('reportes_operativos').select('id').eq('trabajador_id', trabajador.id).gte('created_at', hoy.toISOString()).order('created_at', { ascending: false }).limit(1)
  const tipoFinal: TipoOperacion = d.tipo || (d.metros === 0 && d.observaciones ? 'standby' : d.pilote || d.pq || d.ensanche ? 'pilote' : 'estudio_suelo')
  const payload = {
    trabajador_id: trabajador.id, proyecto_id: trabajador.proyecto_id, trabajador_nombre: trabajador.nombre,
    proyecto_nombre: trabajador.proyectos?.nombre || 'General', tipo_operacion: tipoFinal, sondeo: d.sondeo || null, pilote: d.pilote || null, metros_nq: d.metros || 0,
    avance_pq: d.pq || 0, ensanche: d.ensanche || 0, encamisado: d.encamisado || 0, ensayos_spt: d.ensayos_spt || 0, observaciones: d.observaciones || textoCrudo, confirmado: true
  }
  if (existentes && existentes.length > 0) {
    await supabase.from('reportes_operativos').update(payload).eq('id', existentes[0].id)
  } else {
    await supabase.from('reportes_operativos').insert(payload)
  }
}

async function consultarGroq(mensaje: string, operador: string, frente: string, datosPrevios: DatosReporte, historial: MensajeHistorial[]) {
  const groqKey = (process.env.GROQ_API_KEY || '').trim()
  if (!groqKey) return { accion: 'conversar', respuesta_whatsapp: `🛠️ ERROR VERCEL: Llave GROQ_API_KEY no encontrada.`, datos_actualizados: datosPrevios }

  const prompt = `
Eres el Asistente Técnico de Operaciones de "JHF Perforaciones S.A.S." en Colombia. Hablas con "Don ${operador}" en el proyecto "${frente}".
OBJETIVO: Recolectar la bitácora operativa diaria.

DIRECTRICES:
1. NOVEDADES Y STANDBY: Si reportan lluvia, daños o paros SST sin avance: metros = 0, tipo = "standby". Responde con empatía técnica y pide confirmación.
2. OPERACIONES: "Prehueco/PQ/Ensanche" = pilote. "Sondeo" = estudio_suelo.
3. PUNTOS: Si no lo saben = "P-01 (Por verificar)".
4. CONFIRMACIÓN: Resume la información y pide confirmación (accion="pedir_confirmacion"). Si aprueba ("sí", "ok"), accion="guardar_reporte".
5. TEMAS ADMINISTRATIVOS: Si preguntan por viáticos, pagos o permisos, diles cortésmente que solo manejas reportes técnicos de obra y que contacten a la oficina. Luego pregúntales por el reporte técnico.

DATOS PREVIOS: ${JSON.stringify(datosPrevios)}
HISTORIAL: ${historial.map(h => `${h.role}:${h.text}`).join('\n')}

RESPONDE ÚNICAMENTE CON UN OBJETO JSON VÁLIDO CON ESTA ESTRUCTURA EXACTA:
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
    "encamisado": number | null,
    "ensayos_spt": number | null,
    "observaciones": string | null
  }
}
`
  let logErrores = []
  
  // Modelos oficiales vigentes y recomendados por Groq
  const modelos = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']

  for (const modelo of modelos) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 7500)

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${groqKey}`, 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ 
          model: modelo, 
          messages: [
            { role: 'system', content: prompt }, 
            { role: 'user', content: mensaje }
          ], 
          response_format: { type: 'json_object' }, 
          temperature: 0.1 
        }),
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (res.ok) {
        const data = await res.json()
        let raw = data.choices?.[0]?.message?.content || ''
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
        const data = await res.json()
        logErrores.push(`[${modelo}: ${res.status}]${JSON.stringify(data.error?.message || 'error')}`)
      }
    } catch (e: any) {
      logErrores.push(`[${modelo}: timeout/red]${e.message}`)
    }
  }

  return { accion: 'conversar', respuesta_whatsapp: `🛠️ ERROR GROQ: ${logErrores.join(' | ')}`, datos_actualizados: datosPrevios }
}

function normalizarTexto(t: string): string { return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim() }
function esDespedidaOInterjeccion(limpio: string): boolean { return /^(gracias|ok gracias|muchas gracias|feliz noche|buenas noches|chao|amen|nos vemos|👍|🙏|hasta luego)$/i.test(limpio) }
async function enviarWhatsApp(to: string, text: string) {
  const token = (process.env.WHATSAPP_ACCESS_TOKEN || '').replace(/['"]/g, '').trim()
  if (!token) return
  try {
    await fetch(META_MESSAGES_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }) })
  } catch (err: any) { console.error(err) }
}
