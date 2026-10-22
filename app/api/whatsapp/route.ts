import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'

const META_VERIFY_TOKEN = 'clave_secreta_reportes_2026'
const META_MESSAGES_URL = 'https://graph.facebook.com/v19.0/1370874296109664/messages'
const NUMERO_JEFATURA = '573103953485'

type MensajeHistorial = { role: string; text: string }

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
    const tipoProyecto = trabajador.proyectos?.tipo_proyecto || 'pilotes'
    const estadoActual = trabajador.estado_conversacion || 'inactivo'
    const rawMemoria = (trabajador.borrador_reporte as any) || {}
    
    if (rawMemoria.last_msg_id === message.id) return NextResponse.json({ status: 'ignored_duplicate' })

    const horaBogota = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }))
    const esDomingo = horaBogota.getDay() === 0
    const horaDecimal = horaBogota.getHours() + (horaBogota.getMinutes() / 60)
    const horaFormateada = horaBogota.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })

    const { data: reportesAnt } = await supabase.from('reportes_operativos')
      .select('*')
      .eq('trabajador_id', trabajador.id)
      .eq('proyecto_id', trabajador.proyecto_id)
      .eq('confirmado', true)
      .order('created_at', { ascending: false }).limit(1)
      
    const reporteUltimo = reportesAnt?.[0] || null
    const esPrimerContacto = !reporteUltimo

    let yaReportoHoy = false
    if (reporteUltimo) {
      const options = { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' } as const
      const fechaUltimo = new Date(reporteUltimo.created_at).toLocaleDateString('es-CO', options)
      const fechaHoyStr = horaBogota.toLocaleDateString('es-CO', options)
      yaReportoHoy = (fechaUltimo === fechaHoyStr)
    }

    const textoCrudo = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || ''
    const textoLimpio = normalizarTexto(textoCrudo)
    const esBotonMeta = message.type === 'button' || message.type === 'interactive' || textoLimpio.includes('confirmar recepcion')

    if (estadoActual === 'inactivo' && yaReportoHoy && !esBotonMeta) {
      if (!/\b(reiniciar|empezar de nuevo|borrar todo|corregir)\b/i.test(textoLimpio)) {
        return NextResponse.json({ status: 'ignored_already_reported_today' })
      }
    }

    if (/\b(reiniciar|empezar de nuevo|borrar todo|corregir)\b/i.test(textoLimpio)) {
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte', borrador_reporte: { datos: {}, historial: [], last_msg_id: message.id, alerta_enviada: false } }).eq('id', trabajador.id)
      await enviarWhatsApp(from, `🔄 Listo ${nombreOperador}, bitácora en blanco. Arranquemos, ¿cómo nos fue hoy?`)
      return NextResponse.json({ status: 'reset_flow' })
    }

    const esSaludo = textoLimpio.length <= 15 && /\b(hola|ola|buenas|que mas|buenos dias|buenas tardes)\b/i.test(textoLimpio)
    
    if (esBotonMeta || (esSaludo && estadoActual === 'inactivo')) {
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte', borrador_reporte: { datos: {}, historial: [], last_msg_id: message.id, alerta_enviada: false } }).eq('id', trabajador.id)
      
      let msjArranque = ''
      if (esPrimerContacto) {
        msjArranque = `👋 ¡Qué más ${nombreOperador}! Arrancamos a reportar en este proyecto de *${frenteNombre}*.\n\nPara ponerme al día: al corte de hoy, ¿en qué punto estamos trabajando y qué logramos hacer?`
      } else {
        msjArranque = `👋 ¡Hola ${nombreOperador}! Espero que todo haya salido excelente en *${frenteNombre}* hoy.\n\n`
        if (tipoProyecto.toLowerCase().includes('pilote')) {
          msjArranque += `Cuéntame, ¿en qué número de pilote estuvimos dándole hoy y cómo estuvo el avance?`
        } else {
          msjArranque += `Cuéntame, ¿en qué número de sondeo estuvimos trabajando y cuántos metros logramos?`
        }
      }
      
      await enviarWhatsApp(from, msjArranque)
      return NextResponse.json({ status: 'welcome_sent' })
    }

    if (estadoActual === 'inactivo' && esMensajeCortesia(textoLimpio)) {
      return NextResponse.json({ status: 'ignored_courtesy_loop' })
    }

    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(from, `¡Qué pena ${nombreOperador}! Por ahora no escucho audios. Escríbemelo, porfa.`)
      return NextResponse.json({ status: 'audio_rejected' })
    }
    if (message.type === 'image') {
      await enviarWhatsApp(from, `📷 Foto recibida y guardada como soporte.`)
      return NextResponse.json({ status: 'image_received' })
    }

    if (message.type === 'text') {
      const historial = Array.isArray(rawMemoria.historial) ? rawMemoria.historial : []
      const nuevoItem: MensajeHistorial = { role: 'user', text: textoCrudo }
      const historialActualizado = [...historial, nuevoItem].slice(-15)

      const nuevaMemoria = {
        datos: rawMemoria.datos || {},
        historial: historialActualizado,
        last_msg_id: message.id,
        alerta_enviada: rawMemoria.alerta_enviada || false
      }
      
      await supabase.from('trabajadores').update({ borrador_reporte: nuevaMemoria }).eq('id', trabajador.id)
      await new Promise(resolve => setTimeout(resolve, 3000))

      const { data: checkData } = await supabase.from('trabajadores').select('borrador_reporte').eq('id', trabajador.id).single()
      const currentBorrador = checkData?.borrador_reporte || nuevaMemoria

      if (currentBorrador.last_msg_id !== message.id) {
        return NextResponse.json({ status: 'superseded_by_newer_message' })
      }

      const decisionIA = await consultarGroq(textoCrudo, nombreOperador, frenteNombre, tipoProyecto, currentBorrador.datos || {}, currentBorrador.historial || [], esDomingo, reporteUltimo, horaFormateada, esPrimerContacto)

      if (decisionIA.alerta_jefatura && !currentBorrador.alerta_enviada && horaDecimal >= 7 && horaDecimal < 17) {
        await enviarWhatsApp(NUMERO_JEFATURA, `🚨 *ALERTA DE OBRA* 🚨\nEl perforador *${nombreOperador}* en *${frenteNombre}* reporta novedad crítica/dominical.\n\n*Mensaje:* "${textoCrudo}"`)
        nuevaMemoria.alerta_enviada = true
      }

      if (decisionIA.posponer_reporte) {
        await supabase.from('trabajadores').update({ estado_conversacion: 'pospuesto', borrador_reporte: { datos: decisionIA, historial: currentBorrador.historial, last_msg_id: message.id, alerta_enviada: nuevaMemoria.alerta_enviada } }).eq('id', trabajador.id)
        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'postponed' })
      }

      if (decisionIA.accion === 'guardar_reporte') {
        const dataFinal = (decisionIA.avance_hoy?.metros_pq || decisionIA.avance_hoy?.metros_ensanche || decisionIA.avance_hoy?.metros_camisa || decisionIA.avance_hoy?.metros_nq_spt || decisionIA.avance_hoy?.tipo === 'standby' || decisionIA.avance_hoy?.tipo === 'logistica') 
                          ? decisionIA 
                          : currentBorrador.datos;

        await guardarOActualizarReporte(trabajador, dataFinal, textoCrudo)
        await supabase.from('trabajadores').update({ estado_conversacion: 'inactivo', borrador_reporte: null }).eq('id', trabajador.id)
        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'saved_by_ai' })
      }

      const respuestaItem: MensajeHistorial = { role: 'model', text: decisionIA.respuesta_whatsapp }
      const historialFinal = [...(currentBorrador.historial || []), respuestaItem].slice(-15)
      
      await supabase.from('trabajadores').update({
        estado_conversacion: decisionIA.accion === 'pedir_confirmacion' ? 'esperando_confirmacion' : 'conversando', 
        borrador_reporte: { datos: decisionIA, historial: historialFinal, last_msg_id: message.id, alerta_enviada: nuevaMemoria.alerta_enviada }
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

async function guardarOActualizarReporte(trabajador: any, decisionIA: any, textoCrudo: string) {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  const pto = decisionIA.estado_punto || {}
  const avance = decisionIA.avance_hoy || {}
  
  const { data: existentes } = await supabase.from('reportes_operativos').select('id').eq('trabajador_id', trabajador.id).gte('created_at', hoy.toISOString()).order('created_at', { ascending: false }).limit(1)
  
  const payload = {
    trabajador_id: trabajador.id, proyecto_id: trabajador.proyecto_id, trabajador_nombre: trabajador.nombre,
    proyecto_nombre: trabajador.proyectos?.nombre || 'General', 
    tipo_operacion: avance.tipo || 'pilote', 
    sondeo: (avance.tipo === 'estudio_suelo') ? pto.numero_punto : null, 
    pilote: (avance.tipo === 'pilote') ? pto.numero_punto : null, 
    metros_nq: avance.metros_nq_spt || 0,
    avance_pq: avance.metros_pq || 0, 
    ensanche: avance.metros_ensanche || 0, 
    encamisado: avance.metros_camisa || 0, 
    ensayos_spt: avance.metros_nq_spt || 0, 
    profundidad_total_pilote: pto.profundidad_diseno || 0,
    observaciones: avance.observaciones || textoCrudo, 
    confirmado: true
  }
  
  if (existentes && existentes.length > 0) {
    await supabase.from('reportes_operativos').update(payload).eq('id', existentes[0].id)
  } else {
    await supabase.from('reportes_operativos').insert(payload)
  }
}

async function consultarGroq(mensaje: string, operador: string, frente: string, tipoProyecto: string, datosPrevios: any, historial: MensajeHistorial[], esDomingo: boolean, reporteUltimo: any, horaFormateada: string, esPrimerContacto: boolean) {
  const groqKey = (process.env.GROQ_API_KEY || '').trim()
  if (!groqKey) return { accion: 'conversar', respuesta_whatsapp: `⏳ Error de conexión.`, alerta_jefatura: false, posponer_reporte: false }

  const esSuelos = tipoProyecto.toLowerCase().includes('suelo')
  
  const reglasEspecificas = esSuelos ? `
4. REGLAS PARA ESTUDIOS DE SUELOS: Estás en un proyecto de Estudio de Suelos. Habla de "Sondeos". PROHIBIDO mencionar "pilote", "encamisado", "camisa", "prehueco". Si reportan metros de avance, anótalos y pregunta si fue SPT o NQ (a menos que ya lo hayan dicho).
  ` : `
4. REGLAS PARA PILOTES: Estás en un proyecto de Pilotes. Habla de "Pilotes". Si dicen "avancé 5 metros", indaga si fueron de camisa, prehueco o ensanche. Guárdalo donde te indique y asume cero para las otras fases sin preguntar.
  `

  const prompt = `
Eres el Asistente de Bitácoras de JHF Perforaciones. Hablas por WhatsApp con el perforador "${operador}".
Tono: Colega de obra natural y fluido. PROHIBIDO usar "Don", "Doña" o "QAP".

CONTEXTO DEL SISTEMA:
- Proyecto: ${frente} (Tipo: ${tipoProyecto})
- Reloj en Obra: ${horaFormateada}
- HOY ES DOMINGO: ${esDomingo ? 'SÍ' : 'NO'}
- ES PRIMER CONTACTO EN ESTA OBRA: ${esPrimerContacto ? 'SÍ' : 'NO'}

REGLAS DE INGENIERÍA:
1. PRIMER CONTACTO: Si "ES PRIMER CONTACTO" es SÍ, pregunta amigablemente en qué punto están trabajando hoy y si arrancan de cero o ya traen metros de antes. NO exijas saber "qué está 100% terminado" porque a veces apenas están instalando equipo. Sé natural y no los presiones.
2. EL BUG DEL "SÍ": Si el operador dice "sí", "listo" o "ok" para confirmar el reporte que tú le resumiste, TIENES PROHIBIDO BORRAR LOS DATOS PREVIOS. Tu JSON debe devolver los mismos números exactos que tenías antes en "datos_previos", con accion="guardar_reporte".
3. PROHIBIDO GUARDAR PREMATURAMENTE: Nunca uses accion="guardar_reporte" directamente. Siempre debes hacer un resumen general y usar accion="pedir_confirmacion". Solo cuando el operador diga "Sí" o "ok" a tu resumen, puedes usar "guardar_reporte".
${reglasEspecificas}
5. LOGÍSTICA / INSTALACIÓN (CERO METROS) [¡CRÍTICO!]: Si el operador indica que hoy SOLAMENTE instaló, buscó agua, movió equipo, o hizo logística, ASUME AUTOMÁTICAMENTE avance cero (0). Pon tipo="logistica". TIENES ESTRICTAMENTE PROHIBIDO preguntarle por metros, SPT, NQ, o camisas en este escenario. Simplemente acepta que hoy fue día de instalación, resume su comentario y pide confirmación para cerrar.
6. NOVEDADES CRÍTICAS: Si reportan varada o lluvia, activa "alerta_jefatura": true.

DATOS PREVIOS (MANTENLOS INTACTOS SI EL USUARIO ESTÁ CONFIRMANDO):
${JSON.stringify(datosPrevios)}

HISTORIAL DE CHAT RECIENTE:
${historial.map(h => `${h.role}:${h.text}`).join('\n')}

RESPONDE ÚNICAMENTE CON UN OBJETO JSON VÁLIDO CON ESTA ESTRUCTURA EXACTA:
{
  "accion": "conversar" | "pedir_confirmacion" | "guardar_reporte",
  "respuesta_whatsapp": "Tu respuesta aquí...",
  "alerta_jefatura": boolean,
  "posponer_reporte": boolean,
  "estado_punto": {
    "numero_punto": string | null,
    "profundidad_diseno": number | null,
    "acumulado_previo": string | null,
    "estado": "en_progreso" | "finalizado" | "pendiente_info"
  },
  "avance_hoy": {
    "tipo": "pilote" | "estudio_suelo" | "standby" | "logistica",
    "metros_pq": number | null,
    "metros_ensanche": number | null,
    "metros_camisa": number | null,
    "metros_nq_spt": number | null,
    "observaciones": string | null
  }
}
`
  let logErrores = []
  const modelos = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']

  for (const modelo of modelos) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 8500) 

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
            estado_punto: parsed.estado_punto || {},
            avance_hoy: parsed.avance_hoy || {}
          }
        }
      } else {
        const data = await res.json()
        logErrores.push(`[${modelo}: ${res.status}]`)
      }
    } catch (e: any) {
      logErrores.push(`[${modelo}: timeout]`)
    }
  }

  return { accion: 'conversar', respuesta_whatsapp: `⏳ Denme un segundito que el sistema central está guardando los datos. Vuelva a enviarme este último mensaje porfa.`, alerta_jefatura: false, posponer_reporte: false }
}

function normalizarTexto(t: string): string { return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim() }

function esMensajeCortesia(textoLimpio: string): boolean {
  if (textoLimpio.length > 30) return false;
  return /\b(ok|listo|gracias|amén|amen|chao|feliz noche|buenas noches|buena noche|👍|🙏|con gusto|de nada|vale|dale|bueno|saludos|hasta mañana|nos vemos|descanse)\b/i.test(textoLimpio);
}

async function enviarWhatsApp(to: string, text: string) {
  const token = (process.env.WHATSAPP_ACCESS_TOKEN || '').replace(/['"]/g, '').trim()
  if (!token) return
  try {
    await fetch(META_MESSAGES_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }) })
  } catch (err: any) { console.error(err) }
}
