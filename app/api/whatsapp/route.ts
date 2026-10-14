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

    // CLIC EN BOTÓN DE PLANTILLA
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
        `👋 Hola ${trabajador.nombre}, este sistema automatizado no escucha audios. Por favor escríbeme en un texto corto cómo les fue hoy.`
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
      const textoNormalizado = normalizarTexto(textoCrudo)
      const estadoActual = trabajador.estado_conversacion || 'inactivo'
      const canastaPrevia: CanastaReporte = trabajador.borrador_reporte || {}
      const nombreOperador = trabajador.nombre
      const frenteNombre = trabajador.proyectos?.nombre || 'General'

      // 1. REINICIAR / CANCELAR
      if (/\b(cancelar|anular|borrar|reiniciar|empezar de nuevo|borre eso)\b/i.test(textoNormalizado)) {
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

      // 2. CONFIRMACIÓN POSITIVA ("SÍ", "OK", "CONFIRMO")
      if (estadoActual === 'esperando_confirmacion' && esConfirmacionPositiva(textoNormalizado)) {
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
      if (estadoActual === 'esperando_confirmacion' && esNegacionSimple(textoNormalizado)) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_reporte_diario',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `✍️ Entendido ${nombreOperador}, descartado. Escríbeme el reporte correcto para registrarlo.`
        )
        return NextResponse.json({ status: 'confirmation_rejected' })
      }

      // 4. DESPEDIDAS Y CORTESÍAS
      if (esDespedidaOCortesia(textoNormalizado)) {
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

      // 5. BROMAS O VULGARIDADES (Si no vienen acompañadas de metros reales)
      const tieneMetrosEnBruto = /\b(\d+|un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(?:m|mt|mts|metro|pq|prehueco)/i.test(textoNormalizado)
      if (esBromaOGroseria(textoNormalizado) && !tieneMetrosEnBruto) {
        await enviarWhatsApp(
          from,
          `😅 Don ${nombreOperador}, déjese de bromas y hablemos de trabajo: ¿cuántos metros perforaron hoy en *${frenteNombre}* o qué novedades tuvieron?`
        )
        return NextResponse.json({ status: 'joke_filtered' })
      }

      // 6. SALUDOS SIMPLES
      if (esSaludoSimple(textoNormalizado)) {
        if (estadoActual === 'inactivo') {
          await enviarWhatsApp(
            from,
            `👋 Hola ${nombreOperador}, tu reporte de hoy ya está registrado en el sistema. Si deseas modificarlo, escribe *reiniciar*.`
          )
        } else {
          await enviarWhatsApp(
            from,
            `👋 ¡Hola ${nombreOperador}! ¿Cómo les fue hoy en *${frenteNombre}*?\n\nCuéntame en qué punto trabajaron, cuántos metros avanzaron o qué actividades hicieron.`
          )
        }
        return NextResponse.json({ status: 'greeting_replied' })
      }

      // ====================================================
      // 7. EXTRACCIÓN HÍBRIDA (GEMINI IA + MOTOR LOCAL)
      // ====================================================
      let extraccion = await analizarConGemini(textoCrudo, nombreOperador, frenteNombre, canastaPrevia)

      if (!extraccion || !extraccion.valido) {
        extraccion = analizarMotorLocal(textoCrudo, canastaPrevia)
      }

      // Si el operario no sabe el número de punto, se le asigna P-01 o S-01
      if (/no\s*(?:me\s*)?se\s*(?:el\s*)?(?:nombre|numero|nro|sondeo|pilote|punto)|me\s*tocaria\s*preguntar/i.test(textoNormalizado)) {
        if (extraccion.tipo === 'pilote' || extraccion.pq || extraccion.ensanche) {
          extraccion.pilote = extraccion.pilote || 'P-01'
        } else {
          extraccion.sondeo = extraccion.sondeo || 'S-01'
        }
      }

      const tieneMetraje = (extraccion.metros !== null && extraccion.metros !== undefined && extraccion.metros > 0) ||
                           (extraccion.pq !== null && extraccion.pq !== undefined && extraccion.pq > 0) ||
                           (extraccion.ensanche !== null && extraccion.ensanche !== undefined && extraccion.ensanche > 0)
      const tienePunto = Boolean(extraccion.sondeo || extraccion.pilote)
      const esStandby = extraccion.tipo === 'standby' || extraccion.tipo === 'logistica'

      if (!tieneMetraje && !tienePunto && !esStandby && !canastaPrevia.ya_pregunto) {
        await enviarWhatsApp(
          from,
          `👋 Don ${nombreOperador}, no alcancé a captar los metros ni el punto de trabajo. Por favor indícame cuántos metros avanzaron hoy o qué novedad tuvieron en *${frenteNombre}*.`
        )
        return NextResponse.json({ status: 'unclear_message' })
      }

      // ====================================================
      // 8. GENERAR FICHA RESUMEN Y SOLICITAR CONFIRMACIÓN
      // ====================================================
      const datosFinales: CanastaReporte = {
        ...canastaPrevia,
        ...extraccion,
        detalle: canastaPrevia.detalle ? `${canastaPrevia.detalle} -${textoCrudo}` : textoCrudo
      }

      let resumen = ''
      if (datosFinales.tipo === 'pilote' || datosFinales.pq || datosFinales.ensanche || datosFinales.pilote) {
        datosFinales.tipo = 'pilote'
        const piloteFinal = datosFinales.pilote || 'P-01'
        const pqFinal = datosFinales.pq ?? datosFinales.metros ?? 0
        const ensFinal = datosFinales.ensanche || 0
        const encFinal = datosFinales.encamisado || 0

        resumen =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* PILOTAJE\n` +
          `• *Pilote:* ${piloteFinal}\n` +
          `• *Preperforación (PQ):* ${pqFinal} m\n` +
          `• *Ensanche:* ${ensFinal} m\n` +
          `• *Encamisado:* ${encFinal} m\n` +
          `• *Detalle / Novedad:* ${datosFinales.detalle}`
      } else if (datosFinales.tipo === 'standby' || datosFinales.tipo === 'logistica') {
        resumen =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* ${datosFinales.tipo === 'standby' ? 'NOVEDAD / STANDBY' : 'LOGÍSTICA DE CAMPO'}\n` +
          `• *Detalle:* ${datosFinales.detalle}`
      } else {
        datosFinales.tipo = 'estudio_suelo'
        const sondeoFinal = datosFinales.sondeo || 'S-01'
        const metrosFinal = datosFinales.metros ?? 0
        const tramo = (datosFinales.tramo_inicio !== null && datosFinales.tramo_inicio !== undefined && datosFinales.tramo_fin !== null && datosFinales.tramo_fin !== undefined)
          ? ` (De ${datosFinales.tramo_inicio} m a${datosFinales.tramo_fin} m)`
          : ''
        const spt = datosFinales.ensayos_spt ? `\n• *Ensayos SPT:* ${datosFinales.ensayos_spt}` : ''
        const shelby = datosFinales.muestras_shelby ? `\n• *Muestras Shelby:* ${datosFinales.muestras_shelby}` : ''
        const rec = datosFinales.recobro ? `\n• *Recobro:* ${datosFinales.recobro}` : ''

        resumen =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* ESTUDIO DE SUELOS / GEOTECNIA\n` +
          `• *Sondeo / Punto:* ${sondeoFinal}\n` +
          `• *Avance Perforado:* ${metrosFinal} m${tramo}${spt}${shelby}${rec}\n` +
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

// MOTOR LOCAL DE PARSEO TÉCNICO Y CONVERSIÓN DE TEXTO A DÍGITOS
function analizarMotorLocal(raw: string, previo: CanastaReporte): any {
  let t = normalizarTexto(raw)

  // Conversión de números escritos en palabras a dígitos
  const mapaNumeros: Record<string, string> = {
    'cero': '0', 'un': '1', 'uno': '1', 'una': '1', 'dos': '2', 'dosss': '2', 'doss': '2',
    'tres': '3', 'tress': '3', 'cuatro': '4', 'cinco': '5', 'seis': '6', 'siete': '7',
    'ocho': '8', 'nueve': '9', 'diez': '10', 'once': '11', 'doce': '12', 'quince': '15',
    'veinte': '20'
  }
  for (const [palabra, digito] of Object.entries(mapaNumeros)) {
    t = t.replace(new RegExp(`\\b${palabra}\\b`, 'g'), digito)
  }
  t = t.replace(/\bmedio\s*(?:metro|m)\b/g, '0.5 metros')

  const c: any = { ...previo, valido: false }

  const mencionaPilote = /\b(pilote|pilotaje|pq|prehueco|pre hueco|ensanche|encamisado|casing)\b/i.test(t) || /\bp[-_\s]*0*\d+\b/i.test(t)
  const mencionaLluvia = /\b(lluvia|llovio|aguacero|clima|agua paramos|inundado)\b/i.test(t)
  const mencionaVarada = /\b(varad|dano|falla|revento|rompio|manguera|bomba|acpm|combustible|sst|interventoria|pararon|paro)\b/i.test(t)

  if (mencionaPilote) c.tipo = 'pilote'
  else if (mencionaLluvia || mencionaVarada) c.tipo = 'standby'
  else c.tipo = c.tipo || 'estudio_suelo'

  // Sondeos
  const mSondeo = t.match(/\b(?:sondeo|punto|pozo|sp|s)[-_\s]*0*(\d+)\b/i)
  if (mSondeo) { c.sondeo = `S-${mSondeo[1].padStart(2, '0')}`; c.tipo = 'estudio_suelo'; c.valido = true }

  // Pilotes
  const mPilote = t.match(/\b(?:pilote|p)[-_\s]*0*(\d+)\b/i)
  if (mPilote) { c.pilote = `P-${mPilote[1].padStart(2, '0')}`; c.tipo = 'pilote'; c.valido = true }

  // Tramos: "de 2 a 6 metros"
  const mTramo = t.match(/(?:de|desde)\s*(\d+(?:\.\d+)?)\s*(?:a|hasta)\s*(\d+(?:\.\d+)?)/i)
  if (mTramo) {
    const ini = parseFloat(mTramo[1])
    const fin = parseFloat(mTramo[2])
    if (fin > ini) {
      c.tramo_inicio = ini
      c.tramo_fin = fin
      c.metros = parseFloat((fin - ini).toFixed(2))
      c.valido = true
    }
  }

  // Prehueco / PQ
  const mPQ = t.match(/(\d+(?:\.\d+)?)\s*(?:metros?\s*)?(?:en|de)?\s*(?:pq|prehueco|pre hueco)/i) ||
              t.match(/(?:pq|prehueco|pre hueco)\s*(?:de)?\s*(\d+(?:\.\d+)?)/i)
  if (mPQ) {
    c.pq = parseFloat(mPQ[1])
    c.tipo = 'pilote'
    c.valido = true
  }

  // Metros sueltos o explícitos ("2 metros", "dos metros mano", "avance 3")
  const mMetros = t.match(/(\d+(?:\.\d+)?)\s*(?:metros?|m\b)/i) ||
                  t.match(/\b(?:hice|perfore|avanzamos|hicimos|hicieron|avance)\s*(\d+(?:\.\d+)?)/i)
  if (mMetros && !c.metros && !c.pq) {
    const val = parseFloat(mMetros[1])
    if (c.tipo === 'pilote') c.pq = val
    else c.metros = val
    c.valido = true
  }

  // SPT y Shelby
  const mSPT = t.match(/(\d+)\s*(?:ensayos?|muestras?)?\s*spt/i) || t.match(/\bspt\b/i)
  if (mSPT) { c.ensayos_spt = mSPT[1] ? parseInt(mSPT[1]) : 1; c.valido = true }

  if (mencionaLluvia || mencionaVarada) c.valido = true

  return c
}

// LLAMADA A GEMINI CON ENDPOINT OFICIAL ESTABLE V1
async function analizarConGemini(mensaje: string, operador: string, frente: string, memoria: CanastaReporte): Promise<any> {
  if (!GEMINI_API_KEY) return { valido: false }

  const prompt = `
Analiza el reporte de un perforador de "JHF Perforaciones S.A.S." en Colombia:
Operador: "${operador}", Frente: "${frente}", Mensaje: "${mensaje}", Memoria previa: ${JSON.stringify(memoria)}.

Devuelve ÚNICAMENTE un JSON:
{
  "valido": true,
  "tipo": "estudio_suelo" | "pilote" | "standby" | "logistica",
  "sondeo": string | null,
  "pilote": string | null,
  "metros": number | null,
  "tramo_inicio": number | null,
  "tramo_fin": number | null,
  "pq": number | null,
  "ensanche": number | null,
  "ensayos_spt": number | null,
  "recobro": string | null
}
Si el mensaje no contiene datos de metros, avances ni novedades operativas de obra, devuelve {"valido": false}.
`

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 2500) // Máximo 2.5 seg

    const res = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      }),
      signal: controller.signal
    })
    clearTimeout(timeoutId)

    if (res.ok) {
      const data = await res.json()
      const rawJson = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (rawJson) return JSON.parse(rawJson)
    }
  } catch (e) {
    // Si Gemini tarda o falla, deriva silenciosamente al motor local
  }

  return { valido: false }
}

function normalizarTexto(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '')
    .trim()
}

function esBromaOGroseria(limpio: string): boolean {
  const palabras = [
    'sexo', 'setso', 'ganzo', 'ganso', 'huevos', 'guevas', 'madre', 'chimba',
    'verga', 'mierda', 'puta', 'gonorrea', 'culiar', 'chiste', 'marica', 'loca', 'loco'
  ]
  return palabras.some(p => limpio.includes(p))
}

function esConfirmacionPositiva(limpio: string): boolean {
  const afirmaciones = [
    'si', 'sii', 'siii', 'sip', 'si senor', 'correcto', 'ok', 'okay', 'listo',
    'de acuerdo', 'confirmo', 'confirmado', 'guardar', 'asentar', 'dale',
    'de una', 'asi es', 'esta bien', 'perfecto', 'bien', 'claro', 'afirmativo',
    'eso es', 'exacto', 'positivo', '👍', '✅'
  ]
  return afirmaciones.includes(limpio) || /^(si|ok|listo|correcto|confirmo)\b/i.test(limpio)
}

function esNegacionSimple(limpio: string): boolean {
  const frases = [
    'no', 'noo', 'nop', 'no senor', 'incorrecto', 'asi no', 'esta mal',
    'negativo', 'eso no fue', 'mal', 'equivocado', 'no es asi', 'no gracias',
    'ya todo bien', 'asi dejelo', 'no deje asi', 'ninguno', 'nada mas'
  ]
  return frases.some(f => limpio === f || limpio.startsWith(f + ' '))
}

function esDespedidaOCortesia(limpio: string): boolean {
  const palabras = [
    'feliz noche', 'buenas noches', 'buena noche', 'hasta manana', 'hasta luego',
    'que descanse', 'descanse', 'bendiciones', 'amen', 'chao', 'gracias feliz noche',
    'muchas gracias', 'gracias a usted', 'listo gracias', 'vale gracias', 'todo bien',
    'ya todo bien', 'no senor gracias', 'no gracias ya todo bien', 'no gracias'
  ]
  return palabras.some(p => limpio.includes(p)) || /^(gracias|muchas gracias|vale|ok gracias|chao|amen|bendiciones)$/i.test(limpio)
}

function esSaludoSimple(limpio: string): boolean {
  const saludos = [
    'hola', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas',
    'q tal', 'que tal', 'como estan', 'como esta', 'como vamos'
  ]
  return saludos.includes(limpio)
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
