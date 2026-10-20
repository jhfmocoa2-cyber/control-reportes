import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// 🚨 LIMPIADOR Y BLOQUEADOR DE CACHÉ DE VERCEL 🚨
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const META_VERIFY_TOKEN = 'clave_secreta_reportes_2026'
const META_MESSAGES_URL = 'https://graph.facebook.com/v19.0/1370874296109664/messages'
const NUMERO_JEFATURA = '573103953485'

type TipoOperacion = 'estudio_suelo' | 'pilote' | 'standby' | 'logistica'
interface MensajeHistorial { role: string; text: string }

interface DatosReporte {
  tipo?: TipoOperacion; sondeo?: string | null; pilote?: string | null;
  metros?: number | null; pq?: number | null; ensanche?: number | null;
  encamisado?: number | null; ensayos_spt?: number | null; observaciones?: string | null;
}

interface MemoriaConversacion { 
  datos?: DatosReporte; 
  historial?: MensajeHistorial[]; 
  last_msg_id?: string;
  alerta_enviada?: boolean; 
}

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
      .select('*, proyectos(nombre, tipo_proyecto)')
      .or(`telefono.eq.${cleanTo},telefono.eq.${localPhone},telefono.eq.57${localPhone}`)
      .eq('activo', true)

    const trabajador = trabajadores?.[0]
    if (!trabajador) return NextResponse.json({ status: 'unregistered_user' })

    const nombreOperador = trabajador.nombre
    const frenteNombre = trabajador.proyectos?.nombre || 'General'
    const tipoProyecto = trabajador.proyectos?.tipo_proyecto || 'general'
    const estadoActual = trabajador.estado_conversacion || 'inactivo'
    const rawMemoria = (trabajador.borrador_reporte as any) || {}
    
    // Escudo anti-duplicados de Meta
    if (rawMemoria.last_msg_id === message.id) return NextResponse.json({ status: 'ignored_duplicate' })

    // HORA BOGOTÁ Y DOMINGOS
    const horaBogota = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }))
    const esDomingo = horaBogota.getDay() === 0

    // MEMORIA DEL AYER
    const { data: reportesAnt } = await supabase.from('reportes_operativos')
      .select('*').eq('trabajador_id', trabajador.id).eq('confirmado', true)
      .order('created_at', { ascending: false }).limit(1)
    const reporteAyer = reportesAnt?.[0] || null

    const memoria: MemoriaConversacion = {
      datos: rawMemoria.datos || (rawMemoria.tipo ? rawMemoria : {}),
      historial: Array.isArray(rawMemoria.historial) ? rawMemoria.historial : [],
      alerta_enviada: rawMemoria.alerta_enviada || false
    }

    const textoCrudo = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || ''
    const textoLimpio = normalizarTexto(textoCrudo)
    
    // 1. COMANDO REINICIAR FORZADO
    if (/\b(reiniciar|empezar de nuevo|borrar todo|corregir)\b/i.test(textoLimpio)) {
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte', borrador_reporte: { datos: {}, historial: [], last_msg_id: message.id, alerta_enviada: false } }).eq('id', trabajador.id)
      await enviarWhatsApp(from, `🔄 Listo ${nombreOperador}, bitácora en blanco. Arranquemos, ¿cómo nos fue hoy?`)
      return NextResponse.json({ status: 'reset_flow' })
    }

    // 2. MATAR BUCLES DE DESPEDIDA
    if (estadoActual === 'inactivo' && textoLimpio.length < 25 && /\b(ok|listo|gracias|amén|amen|chao|feliz noche|buenas noches|buena noche|👍|🙏)\b/i.test(textoLimpio)) {
      return NextResponse.json({ status: 'ignored_courtesy_loop' })
    }

    // 3. DISPARADORES DE NUEVA CONVERSACIÓN (AQUÍ ESTÁ LA MAGIA REPARADA)
    const esBotonMeta = message.type === 'button' || message.type === 'interactive' || textoLimpio.includes('confirmar recepcion');
    const esSaludo = /\b(hola|ola|holi|oli|buenas|buenos dias|buenas tardes|que mas|saludos|reporte)\b/i.test(textoLimpio);
    
    if (esBotonMeta || (esSaludo && (estadoActual === 'inactivo' || estadoActual === 'esperando_reporte'))) {
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte', borrador_reporte: { datos: {}, historial: [], last_msg_id: message.id, alerta_enviada: false } }).eq('id', trabajador.id)
      
      let msjArranque = `👋 ¡Hola ${nombreOperador}! Espero que todo haya salido excelente en *${frenteNombre}* hoy.\n\n`
      if (tipoProyecto.toLowerCase().includes('pilote')) {
        msjArranque += `Cuéntame, ¿en qué número de pilote estuvimos dándole hoy y cómo estuvo el avance?`
      } else if (tipoProyecto.toLowerCase().includes('suelo') || tipoProyecto.toLowerCase().includes('sondeo')) {
        msjArranque += `Cuéntame, ¿en qué número de sondeo estuvimos trabajando y cuántos metros logramos?`
      } else {
        msjArranque += `Cuéntame, ¿qué logramos avanzar hoy o tuvimos alguna novedad?`
      }
      
      await enviarWhatsApp(from, msjArranque)
      return NextResponse.json({ status: 'welcome_sent' })
    }

    // 4. MULTIMEDIA
    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(from, `¡Qué pena ${nombreOperador}! Por ahora no puedo escuchar audios. Escríbemelo en un mensajito corto, porfa.`)
      return NextResponse.json({ status: 'audio_rejected' })
    }
    if (message.type === 'image') {
      await enviarWhatsApp(from, `📷 Foto recibida y guardada en la bitácora.`)
      return NextResponse.json({ status: 'image_received' })
    }

    // 5. FLUJO DE INTELIGENCIA
    if (message.type === 'text') {
      await supabase.from('trabajadores').update({ borrador_reporte: { ...rawMemoria, last_msg_id: message.id } }).eq('id', trabajador.id)
      const nuevoItem: MensajeHistorial = { role: 'user', text: textoCrudo }
      const historialActualizado: MensajeHistorial[] = [...(memoria.historial || []), nuevoItem].slice(-10)

      const decisionIA = await consultarGroq(textoCrudo, nombreOperador, frenteNombre, tipoProyecto, memoria.datos || {}, historialActualizado, esDomingo, reporteAyer)

      if (decisionIA.alerta_jefatura && !memoria.alerta_enviada) {
        await enviarWhatsApp(NUMERO_JEFATURA, `🚨 *ALERTA DE OBRA* 🚨\nEl perforador *${nombreOperador}* en *${frenteNombre}* acaba de reportar una novedad crítica o un trabajo dominical no autorizado.\n\n*Mensaje del operador:* "${textoCrudo}"`)
        memoria.alerta_enviada = true 
      }

      if (decisionIA.posponer_reporte) {
        await supabase.from('trabajadores').update({ estado_conversacion: 'pospuesto', borrador_reporte: { datos: decisionIA.datos_actualizados, historial: historialActualizado, last_msg_id: message.id, alerta_enviada: memoria.alerta_enviada } }).eq('id', trabajador.id)
        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'postponed' })
      }

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
        datos: { ...(memoria.datos || {}), ...decisionIA.datos_actualizados }, historial: historialActualizado.slice(-10), last_msg_id: message.id, alerta_enviada: memoria.alerta_enviada
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

async function consultarGroq(mensaje: string, operador: string, frente: string, tipoProyecto: string, datosPrevios: DatosReporte, historial: MensajeHistorial[], esDomingo: boolean, reporteAyer: any) {
  const groqKey = (process.env.GROQ_API_KEY || '').trim()
  if (!groqKey) return { accion: 'conversar', respuesta_whatsapp: `⏳ Hubo un error de conexión, ${operador}.`, datos_actualizados: datosPrevios, alerta_jefatura: false, posponer_reporte: false }

  const prompt = `
Eres el Asistente de Bitácoras de JHF Perforaciones. Hablas por WhatsApp con el perforador "${operador}".
Tono: Cálido, ameno, natural y fluido. Nada militar ni robótico. PROHIBIDO usar "Don", "Doña" o "QAP". PROHIBIDO saludar múltiples veces en la misma conversación.

CONTEXTO DEL SISTEMA:
- Proyecto: ${frente}
- Tipo de Proyecto (Base de datos): ${tipoProyecto}
- HOY ES DOMINGO O FESTIVO: ${esDomingo ? 'SÍ' : 'NO'}
- REPORTE AYER: ${reporteAyer ? JSON.stringify(reporteAyer) : 'No hay.'}

REGLAS ESTRICTAS DE OPERACIÓN:
1. TRABAJO DOMINICAL: Si HOY ES DOMINGO es SÍ, vuélvete un auditor. Dile: "Un momento ${operador}, no tenías aprobado trabajo dominical. ¿Quién autorizó esto? Para registrar esta novedad, envíame ya mismo dos fotografías (ingreso y salida) donde se vean los rostros, fecha, hora local y ubicación." Activa "alerta_jefatura": true.
2. TODAVÍA NO TERMINO (Pospuesto): Si el operador dice "aún no acabo", "estoy dándole", "espéreme", dile: "¡Tranquilo, hágale! Escríbame por aquí cuando termine y cerramos el reporte." Activa "posponer_reporte": true.
3. NOVEDADES CRÍTICAS (Alerta): Si reportan daño de máquina (varada), lluvia, o paro SISO, dales ánimo, activa "alerta_jefatura": true. Si el operador reporta temprano, pregúntale: "¿Cerramos el reporte aquí o quedo pendiente por si logran avanzar más tarde?". Si dice que ya se cerró, asume metros=0 y tipo="standby".
4. ARREPENTIMIENTO: Si el operador te corrige un dato anterior, dile "Claro que sí, lo actualizamos. ¿Cómo quedan los datos reales?".
5. MENSAJES EN PEDAZOS: Los operadores escriben corto. Lee el historial para entender todo el contexto antes de responder.
6. MATEMÁTICA DE PILOTES (SI EL PROYECTO ES PILOTES): Si dice "avancé 4 metros", NO TIENES LOS DATOS COMPLETOS. Debes indagar con naturalidad: "¿Fueron 4 metros de prehueco, ensanche o metiendo camisa? ¿De cuántos metros va a quedar el pilote en total?". EXTRAE SOLO LO DE HOY, y anota el acumulado en observaciones.
7. CIERRE: Solo cuando tengas TODOS los datos (si es pilote: prehueco, camisa, ensanche, profundidad total), haz un resumen amable en texto, mételo en "observaciones" del JSON, pide confirmación y pon accion="pedir_confirmacion". Si responden "sí", "ok" o "listo", pon accion="guardar_reporte" y despídete amablemente de forma breve.

DATOS RECOLECTADOS HOY: ${JSON.stringify(datosPrevios)}
HISTORIAL RECIENTE: ${historial.map(h => `${h.role}:${h.text}`).join('\n')}

RESPONDE ÚNICAMENTE CON UN OBJETO JSON VÁLIDO CON ESTA ESTRUCTURA EXACTA:
{
  "accion": "conversar" | "pedir_confirmacion" | "guardar_reporte",
  "respuesta_whatsapp": "Tu respuesta aquí...",
  "alerta_jefatura": boolean,
  "posponer_reporte": boolean,
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
  const modelos = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']

  for (const modelo of modelos) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 7500)

      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelo, messages: [{ role: 'system', content: prompt }, { role: 'user', content: mensaje }], response_format: { type: 'json_object' }, temperature: 0.1 }),
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
            alerta_jefatura: !!parsed.alerta_jefatura,
            posponer_reporte: !!parsed.posponer_reporte,
            datos_actualizados: (parsed.datos_actualizados || {}) as DatosReporte 
          }
        }
      } else {
        const data = await res.json()
        logErrores.push(`[${modelo}:${res.status}]`)
      }
    } catch (e: any) {
      logErrores.push(`[${modelo}: timeout]`)
    }
  }

  return { accion: 'conversar', respuesta_whatsapp: `⏳ Denme un segundito que el sistema central está guardando los datos. Vuelva a enviarme este último mensaje porfa.`, alerta_jefatura: false, posponer_reporte: false, datos_actualizados: datosPrevios }
}

function normalizarTexto(t: string): string { return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim() }

async function enviarWhatsApp(to: string, text: string) {
  const token = (process.env.WHATSAPP_ACCESS_TOKEN || '').replace(/['"]/g, '').trim()
  if (!token) return
  try {
    await fetch(META_MESSAGES_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }) })
  } catch (err: any) { console.error(err) }
}
