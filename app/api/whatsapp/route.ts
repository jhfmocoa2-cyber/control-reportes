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
    const tipoProyecto = trabajador.proyectos?.tipo_proyecto || 'general'
    const estadoActual = trabajador.estado_conversacion || 'inactivo'
    const rawMemoria = (trabajador.borrador_reporte as any) || {}
    
    // EVITAR DUPLICADOS DE META
    if (rawMemoria.last_msg_id === message.id) return NextResponse.json({ status: 'ignored_duplicate' })

    // HORA BOGOTÁ Y DOMINGOS
    const horaBogota = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }))
    const esDomingo = horaBogota.getDay() === 0
    const horaDecimal = horaBogota.getHours() + (horaBogota.getMinutes() / 60)
    const esHoraReporte = horaDecimal >= 16.5 // Desde las 4:30 p.m.
    const horaFormateada = horaBogota.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })

    // MEMORIA DEL AYER
    const { data: reportesAnt } = await supabase.from('reportes_operativos')
      .select('*').eq('trabajador_id', trabajador.id).eq('confirmado', true)
      .order('created_at', { ascending: false }).limit(1)
    const reporteAyer = reportesAnt?.[0] || null

    const textoCrudo = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || ''
    const textoLimpio = normalizarTexto(textoCrudo)

    // 1. REINICIAR
    if (/\b(reiniciar|empezar de nuevo|borrar todo|corregir)\b/i.test(textoLimpio)) {
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte', borrador_reporte: { datos: {}, historial: [], last_msg_id: message.id, alerta_enviada: false } }).eq('id', trabajador.id)
      await enviarWhatsApp(from, `🔄 Listo ${nombreOperador}, bitácora en blanco. Arranquemos, ¿cómo nos fue hoy?`)
      return NextResponse.json({ status: 'reset_flow' })
    }

    // 2. DISPARADOR INICIAL O SALUDO
    const esBotonMeta = message.type === 'button' || message.type === 'interactive' || textoLimpio.includes('confirmar recepcion')
    const esSaludo = textoLimpio.length <= 15 && /\b(hola|ola|buenas|que mas|saludos)\b/i.test(textoLimpio)
    
    if (esBotonMeta || (esSaludo && estadoActual === 'inactivo')) {
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte', borrador_reporte: { datos: {}, historial: [], last_msg_id: message.id, alerta_enviada: false } }).eq('id', trabajador.id)
      
      let msjArranque = `👋 ¡Hola ${nombreOperador}! Espero que todo haya salido excelente en *${frenteNombre}* hoy.\n\n`
      if (tipoProyecto.toLowerCase().includes('pilote')) {
        msjArranque += `Cuéntame, ¿en qué número de pilote estuvimos dándole hoy y cómo estuvo el avance?`
      } else {
        msjArranque += `Cuéntame, ¿en qué número de sondeo estuvimos trabajando y cuántos metros logramos?`
      }
      if (reporteAyer) {
        const obs = reporteAyer.observaciones ? ` (Ayer reportaste: "${reporteAyer.observaciones}")` : ''
        msjArranque += obs
      }
      await enviarWhatsApp(from, msjArranque)
      return NextResponse.json({ status: 'welcome_sent' })
    }

    // 3. IGNORAR BUCLES DE DESPEDIDA
    if (estadoActual === 'inactivo' && textoLimpio.length < 25 && /\b(ok|listo|gracias|amén|amen|chao|feliz noche|buenas noches|buena noche|👍|🙏)\b/i.test(textoLimpio)) {
      return NextResponse.json({ status: 'ignored_courtesy_loop' })
    }

    // MULTIMEDIA
    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(from, `¡Qué pena ${nombreOperador}! Por ahora no escucho audios. Escríbemelo, porfa.`)
      return NextResponse.json({ status: 'audio_rejected' })
    }
    if (message.type === 'image') {
      await enviarWhatsApp(from, `📷 Foto recibida y guardada como soporte.`)
      return NextResponse.json({ status: 'image_received' })
    }

    // 4. PILAR 1: EL AMORTIGUADOR DE 3 SEGUNDOS
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

      // ESPERAMOS 3 SEGUNDOS
      await new Promise(resolve => setTimeout(resolve, 3000))

      // REVISAMOS SI ENTRÓ OTRO MENSAJE CON ESCUDO NULL-CHECK DE TYPESCRIPT
      const { data: checkData } = await supabase.from('trabajadores').select('borrador_reporte').eq('id', trabajador.id).single()
      
      const currentBorrador = checkData?.borrador_reporte || nuevaMemoria

      if (currentBorrador.last_msg_id !== message.id) {
        console.log('Amortiguador activado: mensaje superado por uno más reciente.')
        return NextResponse.json({ status: 'superseded_by_newer_message' })
      }

      // 5. FLUJO DE INTELIGENCIA
      const decisionIA = await consultarGroq(textoCrudo, nombreOperador, frenteNombre, tipoProyecto, currentBorrador.datos || {}, currentBorrador.historial || [], esDomingo, reporteAyer, horaFormateada, esHoraReporte)

      // ALERTA JEFATURA
      if (decisionIA.alerta_jefatura && !currentBorrador.alerta_enviada) {
        await enviarWhatsApp(NUMERO_JEFATURA, `🚨 *ALERTA DE OBRA* 🚨\nEl perforador *${nombreOperador}* en *${frenteNombre}* reporta novedad crítica/dominical.\n\n*Mensaje:* "${textoCrudo}"`)
        nuevaMemoria.alerta_enviada = true
      }

      // POSPUESTO
      if (decisionIA.posponer_reporte) {
        await supabase.from('trabajadores').update({ estado_conversacion: 'pospuesto', borrador_reporte: { datos: decisionIA, historial: currentBorrador.historial, last_msg_id: message.id, alerta_enviada: nuevaMemoria.alerta_enviada } }).eq('id', trabajador.id)
        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'postponed' })
      }

      // GUARDAR REPORTE
      if (decisionIA.accion === 'guardar_reporte') {
        await guardarOActualizarReporte(trabajador, decisionIA, textoCrudo)
        await supabase.from('trabajadores').update({ estado_conversacion: 'inactivo', borrador_reporte: null }).eq('id', trabajador.id)
        await enviarWhatsApp(from, decisionIA.respuesta_whatsapp)
        return NextResponse.json({ status: 'saved_by_ai' })
      }

      // CONTINUAR CONVERSACIÓN
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

async function consultarGroq(mensaje: string, operador: string, frente: string, tipoProyecto: string, datosPrevios: any, historial: MensajeHistorial[], esDomingo: boolean, reporteAyer: any, horaFormateada: string, esHoraReporte: boolean) {
  const groqKey = (process.env.GROQ_API_KEY || '').trim()
  if (!groqKey) return { accion: 'conversar', respuesta_whatsapp: `⏳ Hubo un error de conexión, ${operador}.`, alerta_jefatura: false, posponer_reporte: false }

  const prompt = `
Eres el Asistente de Bitácoras de JHF Perforaciones. Hablas por WhatsApp con el perforador "${operador}".
Tono: Colega de obra natural y fluido. PROHIBIDO usar "Don", "Doña" o "QAP".

CONTEXTO DEL SISTEMA:
- Proyecto: ${frente} (Tipo: ${tipoProyecto})
- Reloj en Obra: ${horaFormateada} -> ${esHoraReporte ? 'ES HORA DE REPORTE (Cierre del día)' : 'ES TEMPRANO (Jornada en curso)'}
- HOY ES DOMINGO: ${esDomingo ? 'SÍ' : 'NO'}
- REPORTE DE AYER: ${reporteAyer ? JSON.stringify(reporteAyer) : 'No hay.'}

REGLAS DE INGENIERÍA (NUEVA LÓGICA DE 6 PILARES):
1. TRABAJO DOMINICAL: Si HOY ES DOMINGO es SÍ, vuélvete un auditor estricto. Pide justificación y dos fotografías (ingreso/salida). Activa "alerta_jefatura": true.
2. TODAVÍA NO TERMINO (Pospuesto): Si el operador dice "aún no acabo" o "espéreme", dile: "¡Hágale! Escríbame por aquí cuando termine." Activa "posponer_reporte": true.
3. CONCIENCIA DEL RELOJ Y NOVEDADES: Si reportan varada, lluvia o SISO y ES TEMPRANO, dales ánimo, activa "alerta_jefatura": true, y pregunta: "¿Con esto cerramos el reporte de hoy o quedo pendiente por si logran avanzar?". Si ES HORA DE REPORTE, pregúntales cómo les terminó de ir con esa novedad en la tarde.
4. ARREPENTIMIENTO (MENSAJES EN PEDAZOS): Tienes el historial de todo lo que el usuario ha dicho. Si el operador te corrige un dato, ACATALO, los datos nuevos reemplazan a los viejos.
5. CEROS IMPLÍCITOS Y SALIDA DE EMERGENCIA (¡MUY IMPORTANTE!): 
   - Si el operador te dice "hice 3m de camisa", ASUME INTELIGENTEMENTE que prehueco y ensanche fueron 0. NO le preguntes por las otras fases, no lo interrogues.
   - Si el operador dice "No me sé el número del pilote", NO lo bloquees. Pon en numero_punto: "Pilote Pendiente" y permítele cerrar el reporte.
6. DOS GAVETAS (Estado vs Avance de HOY): 
   En tu JSON de salida tienes "estado_punto" (el contexto general) y "avance_hoy" (SOLO LO QUE SE HIZO HOY). 
   - Extrae inteligentemente lo que se avanzó hoy y ponlo en "avance_hoy".
   - Todo el contexto histórico, sumas o comentarios de ayer ponlos en "observaciones".
7. CIERRE SILENCIOSO: Haz un resumen amable en texto, pide confirmación y pon accion="pedir_confirmacion". Si responden que SÍ, pon accion="guardar_reporte".

DATOS PREVIOS EN EL BORRADOR (Úsalos para no olvidar lo que ya te dijeron hoy): ${JSON.stringify(datosPrevios)}
HISTORIAL DE CHAT RECIENTE (Aquí están los mensajes del operador):
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
        logErrores.push(`[${modelo}:${res.status}]`)
      }
    } catch (e: any) {
      logErrores.push(`[${modelo}: timeout]`)
    }
  }

  return { accion: 'conversar', respuesta_whatsapp: `⏳ Denme un segundito que el sistema central está guardando los datos. Vuelva a enviarme este último mensaje porfa.`, alerta_jefatura: false, posponer_reporte: false }
}

function normalizarTexto(t: string): string { return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim() }

async function enviarWhatsApp(to: string, text: string) {
  const token = (process.env.WHATSAPP_ACCESS_TOKEN || '').replace(/['"]/g, '').trim()
  if (!token) return
  try {
    await fetch(META_MESSAGES_URL, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } }) })
  } catch (err: any) { console.error(err) }
}
