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

    // 2. PROCESAMIENTO DE MENSAJES DE TEXTO
    if (message.type === 'text') {
      // Manejo de corrección explícita
      if (textoLimpio === 'corregir' || textoLimpio === 'cambiar' || textoLimpio === 'modificar') {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_reporte',
          borrador_reporte: { datos: {}, historial: [] }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `🔄 Listo Don ${nombreOperador}, dígame qué modificamos del reporte de hoy (metros, novedades o pilote/sondeo) y se lo actualizo de una.`
        )
        return NextResponse.json({ status: 'ready_to_correct' })
      }

      // Si el reporte ya estaba cerrado y saluda o se despide
      if (estadoActual === 'inactivo') {
        if (esDespedidaOInterjeccion(textoLimpio)) {
          await enviarWhatsApp(
            from,
            `🙏 ¡Con todo el gusto Don ${nombreOperador}! Buen descanso y que pase feliz noche.`
          )
          return NextResponse.json({ status: 'closed_turn_courtesy' })
        }

        const quiereReportar = /\b(reiniciar|corregir|cambiar|nuevo reporte|reportar|modificar|otro reporte|mentiras|espera|fueron|hicimos|avance|varado|barado)\b/i.test(textoLimpio) ||
                               /\b(\d+|un|uno|dos|tres|cuatro|cinco)\s*(?:m|mt|metros|pq|prehueco|sondeo|pilote)\b/i.test(textoLimpio)

        if (!quiereReportar) {
          await enviarWhatsApp(
            from,
            `👍 Don ${nombreOperador}, su reporte de hoy ya quedó debidamente guardado en la bitácora de JHF Perforaciones. ¡Que descanse!\n\n*(Si necesita corregir o cambiar algún dato, escriba "corregir")*`
          )
          return NextResponse.json({ status: 'already_saved_acknowledged' })
        }

        memoria.datos = {}
        memoria.historial = []
      }

      if (/\b(cancelar|anular|borrar|reiniciar|empezar de nuevo)\b/i.test(textoLimpio)) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_reporte',
          borrador_reporte: { datos: {}, historial: [] }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, `🔄 Listo Don ${nombreOperador}, borramos lo anterior y empezamos de cero. Cuéntame cómo les fue hoy en *${frenteNombre}*.`)
        return NextResponse.json({ status: 'reset' })
      }

      // Guardar si confirma
      if (estadoActual === 'esperando_confirmacion' && esConfirmacion(textoLimpio)) {
        const d = memoria.datos || {}
        await guardarOActualizarReporte(trabajador, d, textoCrudo)

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
        await guardarOActualizarReporte(trabajador, d, textoCrudo)

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

  const payload = {
    trabajador_id: trabajador.id,
    proyecto_id: trabajador.proyecto_id,
    trabajador_nombre: trabajador.nombre,
    proyecto_nombre: trabajador.proyectos?.nombre || 'General',
    tipo_operacion: d.tipo || (d.pilote || d.pq || d.ensanche ? 'pilote' : 'estudio_suelo'),
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
  const modelos = ['gemini-flash-latest', 'gemini-1.5-flash', 'gemini-2.5-flash']

  const prompt = `
Eres el Asistente de Operaciones de "JHF Perforaciones S.A.S." en Colombia.
Hablas con "Don ${operador}" en el frente "${frente}". 
Tono: humano, cercano, respetuoso de obra ("Don ${operador}", "mano", "listo", "hágale").

JERGA Y SITUACIONES DE OBRA:
1. VARADAS Y PAROS: Si dicen que estuvieron varados ("barado", "varado", "se reventó la correa/polea", "daño mecánico", "paró SST", "llovió"):
   - Si no avanzaron o dicen "ninguno", "cero", "nada": avance metros = 0, pq = 0, tipo = "standby".
   - Registra en observaciones la razón de la varada (ej: "Varado por polea y correa reventada, sin avance").
   - Pide confirmación de una vez: "¿Le parece bien dejar anotada la varada de la polea y correa con 0 metros en bitácora? Responda SÍ para confirmar."
2. BROMAS Y VULGARIDADES: Si dicen bromas pesadas o groserías de confianza ("marica", "carechimba", "mariconsuelo", chistes de doble sentido), no te ofendas ni los sermonees; respóndeles con buen humor y camaradería de obra y llévalos a los datos reales.
3. PREHUECO / PQ: es operación de pilote.
4. SONDEO: es estudio de suelo.
5. CONFIRMACIÓN: Si confirman ("si", "ok", "listo", "de una", "dejemos asi"), accion: "guardar_reporte".

DATOS PREVIOS RECOLECTADOS: ${JSON.stringify(datosPrevios)}
HISTORIAL DE CHAT:
${historial.map(h => `${h.role}:${h.text}`).join('\n')}
ÚLTIMO MENSAJE: "${mensaje}"

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

  const safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
  ]

  for (const modelo of modelos) {
    if (!GEMINI_API_KEY) break
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
        const errText = await res.text()
        console.warn(`⚠️ Gemini API ${modelo} respondió status ${res.status}:`, errText)
      }
    } catch (e: any) {
      console.warn(`Error llamando a ${modelo}:`, e.message)
    }
  }

  return respaldoContextualInteligente(mensaje, operador, frente, datosPrevios)
}

function respaldoContextualInteligente(
  raw: string,
  operador: string,
  frente: string,
  previo: DatosReporte
): { accion: string; respuesta_whatsapp: string; datos_actualizados: DatosReporte } {
  const t = normalizarTexto(raw)

  if (esConfirmacion(t)) {
    return {
      accion: 'guardar_reporte',
      respuesta_whatsapp: `✅ *¡Listo Don ${operador}! Su reporte quedó guardado en la bitácora de JHF Perforaciones.*\n\n¡Que descanse mano!`,
      datos_actualizados: { ...previo }
    }
  }

  // 1. Detección de VARADAS, DAÑOS MECÁNICOS O CERO METROS
  const esVarada = /\b(varad|barad|polea|correa|dano|daniad|danad|revent|frenad|parados|mantenimiento|ningun|nada|cero|no avanz|no pud|no hic)\b/i.test(t)
  if (esVarada) {
    return {
      accion: 'pedir_confirmacion',
      respuesta_whatsapp:
        `¡Qué vaina Don ${operador}! Entendido el tema mecánico con la polea y correa mano. Le anotamos 0 metros de avance y la novedad de la varada para la bitácora.\n\n` +
        `¿Le parece bien para dejarlo guardado? Responda *SÍ* para confirmar.`,
      datos_actualizados: {
        tipo: 'standby',
        sondeo: previo.sondeo || null,
        pilote: previo.pilote || null,
        metros: 0,
        pq: 0,
        observaciones: `Varado: ${raw}`
      }
    }
  }

  // 2. Detección de metros numéricos
  const matchNum = raw.match(/(\d+(?:[.,]\d+)?)/)
  const numero = matchNum ? parseFloat(matchNum[1].replace(',', '.')) : null

  const esPilote = previo.tipo === 'pilote' || /\b(pilote|pilotaje|pq|prehueco|pre hueco)\b/i.test(t)
  const punto = esPilote ? (previo.pilote || 'P-01 (Por verificar)') : (previo.sondeo || 'S-01')

  if (numero !== null && numero > 0 && numero < 150) {
    const pq = esPilote ? numero : 0
    const metros = !esPilote ? numero : 0
    return {
      accion: 'pedir_confirmacion',
      respuesta_whatsapp:
        `¡Copiado Don ${operador}! Anotamos *${numero} m* en *${punto}* para hoy en${frente}.\n\n` +
        `¿Está todo correcto? Responda *SÍ* para guardar en bitácora.`,
      datos_actualizados: {
        tipo: esPilote ? 'pilote' : 'estudio_suelo',
        pilote: esPilote ? punto : null,
        sondeo: !esPilote ? punto : null,
        pq,
        metros,
        observaciones: raw
      }
    }
  }

  return {
    accion: 'conversar',
    respuesta_whatsapp:
      `¡Buenas Don ${operador}! Cuénteme con calma mano: ¿cuántos metros perforaron hoy en ${frente} o qué novedad tuvieron en el turno?`,
    datos_actualizados: { ...previo }
  }
}

function normalizarTexto(t: string): string {
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim()
}

function esConfirmacion(limpio: string): boolean {
  return /^(si|sii|siii|sip|ok|okay|listo|correcto|confirmo|confirmado|de una|dale|asi es|mm si|si senor|dejemos asi|asi dejamos)$/i.test(limpio) ||
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
      console.log(`✅ ¡Mensaje entregado a WhatsApp con éxito para: ${to}!`)
    }
  } catch (err: any) {
    console.error('❌ Excepción de red enviando a Meta Graph API:', err.message)
  }
}
