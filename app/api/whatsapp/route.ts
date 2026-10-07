import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'clave_secreta_reportes_2026'
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''

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
    const entry = body.entry?.[0]
    const changes = entry?.changes?.[0]
    const value = changes?.value
    const message = value?.messages?.[0]

    if (!message) return NextResponse.json({ status: 'ignored_no_message' })

    const from = message.from
    const cleanFrom = from.replace(/\D/g, '')
    const localPhone = cleanFrom.startsWith('57') ? cleanFrom.slice(2) : cleanFrom

    const { data: trabajadores } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .or(`telefono.eq.${cleanFrom},telefono.eq.${localPhone}`)
      .eq('activo', true)

    const trabajador = trabajadores?.[0]

    if (!trabajador) {
      await enviarWhatsApp(
        from,
        '⚠️ Este número no se encuentra registrado como personal operativo activo en el sistema de JHF Perforaciones.'
      )
      return NextResponse.json({ status: 'unregistered_user' })
    }

    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(
        from,
        `👋 Hola ${trabajador.nombre}, este sistema no escucha notas de voz. Por favor escríbeme en un mensajito corto cómo les fue hoy.`
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
      const textoLimpio = quitarTildes(textoCrudo.toLowerCase())
      const estadoActual = trabajador.estado_conversacion || 'inactivo'
      const canastaPrevia: CanastaReporte = trabajador.borrador_reporte || {}
      const nombreOperador = trabajador.nombre
      const frenteNombre = trabajador.proyectos?.nombre || 'General'

      if (/\b(cancelar|anular|borrar|reiniciar|empezar de nuevo|borre eso)\b/i.test(textoLimpio)) {
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

      if (estadoActual === 'esperando_confirmacion' && esConfirmacionPositiva(textoLimpio)) {
        const b: CanastaReporte = trabajador.borrador_reporte || {}

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

      if (estadoActual === 'esperando_confirmacion' && esNegacionSimple(textoLimpio)) {
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

      if (esSaludoEstricto(textoLimpio)) {
        await enviarWhatsApp(
          from,
          `👋 ¡Hola ${nombreOperador}! ¿Cómo les fue hoy en *${frenteNombre}*?\n\nCuéntame en qué sondeo o punto trabajaron, cuántos metros avanzaron o qué actividad hicieron hoy.`
        )
        return NextResponse.json({ status: 'greeting_replied' })
      }

      if (estadoActual === 'varada_preguntando_solucion') {
        if (!tieneAvanceTecnico(textoLimpio)) {
          const noVarado = /\b(no estoy|no estamos|no quedo|ya quedo|solucionado|listo|arreglado|trabajamos normal)\b/i.test(textoLimpio)
          const sigueParado = !noVarado && /\b(sigue|parado|paralizado|manana|falta|repuesto|taller|torno|esperando)\b/i.test(textoLimpio)
          const situacion = noVarado ? 'SOLUCIONADO EN OBRA' : (sigueParado ? 'EQUIPO QUEDA PARADO' : 'NOVEDAD REPORTADA')

          const detalleFinal = `${canastaPrevia.motivo_varada || 'Novedad'} - Estado: ${situacion} (${textoCrudo})`
          const resumen =
            `👷 *Operador:* ${nombreOperador}\n` +
            `📍 *Frente:* ${frenteNombre}\n` +
            `• *Actividad:* NOVEDAD MECÁNICA / OPERATIVA\n` +
            `• *Reporte:* ${canastaPrevia.motivo_varada || textoCrudo}\n` +
            `• *Estado del equipo:* ${situacion}\n` +
            `• *Observación:* ${textoCrudo}`

          await supabase.from('trabajadores').update({
            estado_conversacion: 'esperando_confirmacion',
            borrador_reporte: { tipo: 'standby', detalle: detalleFinal, resumen }
          }).eq('id', trabajador.id)

          await enviarWhatsApp(
            from,
            `📋 *Resumen de tu reporte:*\n\n${resumen}\n\n📷 *Envía foto si aplica.*\n\n¿Está correcto? Responde *SÍ* para guardar en bitácora.`
          )
          return NextResponse.json({ status: 'varada_ready' })
        }
      }

      if (detectarLluvia(textoLimpio) && !tieneAvanceTecnico(textoLimpio) && estadoActual !== 'esperando_datos_faltantes') {
        const resumen =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* AFECTACIÓN CLIMÁTICA / LLUVIA\n` +
          `• *Detalle:* ${textoCrudo}`

        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_confirmacion',
          borrador_reporte: { tipo: 'standby', detalle: `Clima/Lluvia: ${textoCrudo}`, resumen }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `🌧️ *Entendido el reporte de clima, ${nombreOperador}:*\n\n${resumen}\n\n` +
          `• Si no se pudo avanzar hoy por la lluvia, responde *SÍ* para guardar.\n` +
          `• Si alcanzaron a perforar algo, escríbeme cuántos metros hicieron y en qué punto.`
        )
        return NextResponse.json({ status: 'rain_handled' })
      }

      if (detectarVaradaMecanica(textoLimpio) && !tieneAvanceTecnico(textoLimpio) && estadoActual !== 'esperando_datos_faltantes') {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'varada_preguntando_solucion',
          borrador_reporte: { motivo_varada: textoCrudo }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `⚠️ *Novedad de equipo recibida, ${nombreOperador}:*\n"${textoCrudo}"\n\n¿Lograron solucionarlo hoy mismo o la máquina queda *PARADA* para mañana?`
        )
        return NextResponse.json({ status: 'varada_followup' })
      }

      if (detectarLogisticaOStandby(textoLimpio) && !tieneAvanceTecnico(textoLimpio) && estadoActual !== 'esperando_datos_faltantes') {
        const resumen =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* LOGÍSTICA / ACTIVIDAD DE CAMPO\n` +
          `• *Detalle:* ${textoCrudo}`

        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_confirmacion',
          borrador_reporte: { tipo: 'logistica', detalle: textoCrudo, resumen }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `📋 *Resumen de tu reporte:*\n\n${resumen}\n\n📷 *Recuerda enviar foto de soporte.*\n\n¿Está correcto? Responde *SÍ* para guardar en bitácora.`
        )
        return NextResponse.json({ status: 'logistica_ready' })
      }

      const usarMemoria = estadoActual === 'esperando_datos_faltantes' || estadoActual === 'esperando_confirmacion'
      const nuevaCanasta = extraerDatosConDiccionarioCompleto(textoCrudo, usarMemoria ? canastaPrevia : {})
      const forzarCierre = Boolean(canastaPrevia.ya_pregunto) || estadoActual === 'esperando_datos_faltantes'

      const tieneAlgunDato =
        nuevaCanasta.metros !== null && nuevaCanasta.metros !== undefined ||
        Boolean(nuevaCanasta.sondeo) ||
        Boolean(nuevaCanasta.pilote) ||
        Boolean(nuevaCanasta.ensayos_spt) ||
        Boolean(nuevaCanasta.muestras_shelby) ||
        Boolean(nuevaCanasta.pq) ||
        Boolean(nuevaCanasta.ensanche) ||
        Boolean(nuevaCanasta.encamisado)

      if (!tieneAlgunDato && !forzarCierre) {
        if (textoCrudo.length > 18) {
          const resumenLibre =
            `👷 *Operador:* ${nombreOperador}\n` +
            `📍 *Frente:* ${frenteNombre}\n` +
            `• *Actividad:* REPORTE OPERATIVO DE JORNADA\n` +
            `• *Detalle:* ${textoCrudo}`

          await supabase.from('trabajadores').update({
            estado_conversacion: 'esperando_confirmacion',
            borrador_reporte: { tipo: 'estudio_suelo', detalle: textoCrudo, resumen: resumenLibre }
          }).eq('id', trabajador.id)

          await enviarWhatsApp(
            from,
            `📋 *Resumen de tu reporte:*\n\n${resumenLibre}\n\n¿Lo guardamos así en la bitácora? Responde *SÍ* para confirmar o escríbeme si deseas agregar los metros y el sondeo.`
          )
          return NextResponse.json({ status: 'free_text_ready' })
        }

        await enviarWhatsApp(
          from,
          `👋 Dime ${nombreOperador}, cuéntame en un mensaje cómo les fue hoy: ¿en qué sondeo o punto estuvieron y cuántos metros avanzaron? (O si estuvieron en trasteo, armado o lluvia).`
        )
        return NextResponse.json({ status: 'unrecognized_short' })
      }

      if (!forzarCierre && !nuevaCanasta.sondeo && !nuevaCanasta.pilote && (nuevaCanasta.metros || nuevaCanasta.ensayos_spt || nuevaCanasta.muestras_shelby)) {
        nuevaCanasta.ya_pregunto = true
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_datos_faltantes',
          borrador_reporte: nuevaCanasta
        }).eq('id', trabajador.id)

        const textoAvance = nuevaCanasta.metros ? `los *${nuevaCanasta.metros} metros*` : `los ensayos realizados`
        const preguntaPunto = nuevaCanasta.tipo === 'pilote'
          ? `¿En qué *número de pilote* trabajaron hoy? (Ej: *P-01*, *Pilote 2*).`
          : `¿En qué *número de sondeo o punto* trabajaron hoy? (Ej: *Sondeo 1*, *SP-1*, *Punto 2*).`

        await enviarWhatsApp(
          from,
          `👍 ¡Excelente ${nombreOperador}, anotados ${textoAvance}!\n\nSolo me falta un dato:${preguntaPunto}`
        )
        return NextResponse.json({ status: 'asking_point_once' })
      }

      if (!forzarCierre && (nuevaCanasta.sondeo || nuevaCanasta.pilote) && (nuevaCanasta.metros === null || nuevaCanasta.metros === undefined) && !nuevaCanasta.ensayos_spt && !nuevaCanasta.muestras_shelby) {
        nuevaCanasta.ya_pregunto = true
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_datos_faltantes',
          borrador_reporte: nuevaCanasta
        }).eq('id', trabajador.id)

        const puntoNombre = nuevaCanasta.pilote || nuevaCanasta.sondeo
        await enviarWhatsApp(
          from,
          `👍 Listo ${nombreOperador}, anotado el *${puntoNombre}*.\n\n¿Cuántos metros perforaron hoy en ese punto? (Ej: *3 metros* o *de 2 a 5 metros*).`
        )
        return NextResponse.json({ status: 'asking_meters_once' })
      }

      const esPilote = nuevaCanasta.tipo === 'pilote' || Boolean(nuevaCanasta.pilote)
      let resumenFinal = ''

      if (esPilote) {
        const piloteFinal = nuevaCanasta.pilote || 'P-01'
        const pqVal = nuevaCanasta.pq ?? ( (!nuevaCanasta.ensanche && !nuevaCanasta.encamisado) ? (nuevaCanasta.metros || 0) : 0 )
        const ensVal = nuevaCanasta.ensanche || 0
        const encVal = nuevaCanasta.encamisado || 0

        nuevaCanasta.pilote = piloteFinal
        nuevaCanasta.pq = pqVal
        nuevaCanasta.ensanche = ensVal
        nuevaCanasta.encamisado = encVal

        resumenFinal =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* PILOTAJE\n` +
          `• *Pilote:* ${piloteFinal}\n` +
          `• *Preperforación (PQ):* ${pqVal} m\n` +
          `• *Ensanche:* ${ensVal} m\n` +
          `• *Encamisado:* ${encVal} m\n` +
          `• *Detalle:* ${nuevaCanasta.detalle || textoCrudo}`
      } else {
        const sondeoFinal = nuevaCanasta.sondeo || 'S-01'
        const metrosFinal = nuevaCanasta.metros ?? 0
        nuevaCanasta.sondeo = sondeoFinal
        nuevaCanasta.metros = metrosFinal
        nuevaCanasta.tipo = 'estudio_suelo'

        const tramoInfo = (nuevaCanasta.tramo_inicio !== null && nuevaCanasta.tramo_inicio !== undefined && nuevaCanasta.tramo_fin !== null && nuevaCanasta.tramo_fin !== undefined)
          ? ` (De ${nuevaCanasta.tramo_inicio} m a${nuevaCanasta.tramo_fin} m)`
          : (nuevaCanasta.cota_actual ? ` (Profundidad alcanzada: ${nuevaCanasta.cota_actual} m)` : '')

        const recobroInfo = nuevaCanasta.recobro ? `\n• *Recobro / Muestra:* ${nuevaCanasta.recobro}` : ''
        const sptInfo = nuevaCanasta.ensayos_spt ? `\n• *Ensayos SPT:* ${nuevaCanasta.ensayos_spt}` : ''
        const shelbyInfo = nuevaCanasta.muestras_shelby ? `\n• *Muestras Shelby:* ${nuevaCanasta.muestras_shelby}` : ''

        resumenFinal =
          `👷 *Operador:* ${nombreOperador}\n` +
          `📍 *Frente:* ${frenteNombre}\n` +
          `• *Actividad:* ESTUDIO DE SUELOS / GEOTECNIA\n` +
          `• *Sondeo / Punto:* ${sondeoFinal}\n` +
          `• *Avance Perforado:* ${metrosFinal} m${tramoInfo}${recobroInfo}${sptInfo}${shelbyInfo}\n` +
          `• *Observaciones:* ${nuevaCanasta.detalle || textoCrudo}`
      }

      nuevaCanasta.resumen = resumenFinal

      await supabase.from('trabajadores').update({
        estado_conversacion: 'esperando_confirmacion',
        borrador_reporte: nuevaCanasta
      }).eq('id', trabajador.id)

      await enviarWhatsApp(
        from,
        `📋 *Resumen de tu reporte:* \n\n${resumenFinal}\n\n` +
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

function quitarTildes(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function normalizarJergaYOrtografia(raw: string): string {
  let s = quitarTildes(raw.toLowerCase())

  s = s.replace(/(\d+),(\d+)/g, '$1.$2')
  s = s.replace(/\b(icimos|isimos|hizimos|hisimos|hicimls|hicmos|isimls|isimo)\b/g, 'hicimos')
  s = s.replace(/\b(abansamos|avansamos|abanzamos|avanzamls|abanso|avanzo)\b/g, 'avanzamos')
  s = s.replace(/\b(perforamo|perforaron|perfore|perforo|bajamos|metimos|clavamos)\b/g, 'avanzamos')
  s = s.replace(/\b(sondio|zondeo|sondaje|sondeos)\b/g, 'sondeo')
  s = s.replace(/\b(prueva|pruva|prueb|pruebas)\b/g, 'prueba')
  s = s.replace(/\b(poryecto|proyeto|proyecyo)\b/g, 'proyecto')
  s = s.replace(/\b(zuelo|zuelos|suelos|geotecnia|geotecnico)\b/g, 'suelo')
  s = s.replace(/\b(preueco|pre ueco|pre-hueco|pre hueco|preperforacion|preperforasion|hueco guia|barreno guia)\b/g, 'pq')
  s = s.replace(/\b(ensanxe|ensancho|ensanchado|ensanchamos|escariado|escariador|rimado|ampliacion)\b/g, 'ensanche')
  s = s.replace(/\b(encamizado|encamisada|camisa|camisas|casing|revestimiento|entubado|entubar)\b/g, 'encamisado')
  s = s.replace(/\b(chelby|shelbi|chelbi|tubo shelby)\b/g, 'shelby')
  s = s.replace(/\b(media cana|cuchara partida|split spoon|penetracion estandar)\b/g, 'spt')
  s = s.replace(/\b(rechaso)\b/g, 'rechazo')

  const mapaNumeros: Record<string, string> = {
    'cero': '0', 'uno': '1', 'una': '1', 'dos': '2', 'tres': '3',
    'cuatro': '4', 'cinco': '5', 'seis': '6', 'siete': '7', 'ocho': '8',
    'nueve': '9', 'diez': '10', 'once': '11', 'doce': '12', 'trece': '13',
    'catorce': '14', 'quince': '15', 'dieciseis': '16', 'diecisiete': '17',
    'dieciocho': '18', 'diecinueve': '19', 'veinte': '20', 'veintiuno': '21',
    'veintidos': '22', 'veinticinco': '25', 'treinta': '30'
  }
  for (const [palabra, digito] of Object.entries(mapaNumeros)) {
    s = s.replace(new RegExp(`\\b${palabra}\\b`, 'g'), digito)
  }
  s = s.replace(/\bun\s+(?=metro|m\b|mts\b|sondeo|punto|pilote|spt|ensayo|shelby|tubo)/g, '1 ')

  s = s.replace(/(\d+)\s*(?:m|mt|mts|metros?)?\s*(?:y\s*medio|con\s*medio|y\s*media)\b/g, (_, n) => `${parseFloat(n) + 0.5} metros`)
  s = s.replace(/\b(?:1\s*)?(?:m|mt|mts|metros?)\s*(?:y\s*medio|con\s*medio|y\s*media)\b/g, '1.5 metros')
  s = s.replace(/\b(?:medio\s*(?:m|mt|mts|metros?)|50\s*(?:cm|centimetros))\b/g, '0.5 metros')
  s = s.replace(/\b(\d+)\s*con\s*(\d+)\b/g, '$1.$2 metros')
  s = s.replace(/(\d+(?:\.\d+)?)\s*(?:m|mt|mts|mtos|mtrs|metro)\b/g, '$1 metros')

  return s
}

function extraerDatosConDiccionarioCompleto(textoCrudo: string, previo: CanastaReporte): CanastaReporte {
  const t = normalizarJergaYOrtografia(textoCrudo)
  const c: CanastaReporte = { ...previo }

  if (!c.detalle) {
    c.detalle = textoCrudo
  } else if (!c.detalle.includes(textoCrudo)) {
    c.detalle = `${c.detalle} -${textoCrudo}`
  }

  const mencionaPilote = /\b(pilotes?|pilotaje|pq|ensanche|encamisado|vaciado|canastilla|caisson)\b/i.test(t) || /\bp[-_\s]*0*\d+\b/i.test(t)
  const mencionaSuelo = /\b(suelo|sondeo|spt|shelby|recobro|testigo|nucleo|muestra|rqd|apique|calicata|piezometro|nq|hq|bq)\b/i.test(t) || /\b(?:sp|sc|st|sm)[-_\s]*0*\d+\b/i.test(t)

  if (mencionaSuelo) {
    c.tipo = 'estudio_suelo'
  } else if (mencionaPilote) {
    c.tipo = 'pilote'
  } else if (!c.tipo) {
    c.tipo = 'estudio_suelo'
  }

  const matchSondeoExplicito =
    t.match(/\b(?:sondeo|punto|pozo|apique|calicata|perforacion)(?:\s+de\s+\w+)?(?:\s+numero|\s+nro|\s+#)?[\s-]*(\d+)\b/i) ||
    t.match(/\b(?:sp|sc|st|sm|s)[-_\s]*0*(\d+)\b/i)

  if (matchSondeoExplicito) {
    c.sondeo = `S-${matchSondeoExplicito[1].padStart(2, '0')}`
    c.tipo = 'estudio_suelo'
  }

  const matchPiloteExplicito =
    t.match(/\b(?:pilote|caisson|micropilote)(?:\s+numero|\s+nro|\s+#)?[\s-]*0*(\d+)\b/i) ||
    t.match(/\bp[-_]*0*(\d+)\b/i)

  if (matchPiloteExplicito && !matchSondeoExplicito) {
    c.pilote = `P-${matchPiloteExplicito[1].padStart(2, '0')}`
    c.tipo = 'pilote'
  }

  if (!c.sondeo && !c.pilote && previo.ya_pregunto) {
    const numSuelto = t.match(/\b(?:en el|el|numero|#)?\s*0*(\d+)\b/)
    if (numSuelto) {
      const n = numSuelto[1].padStart(2, '0')
      if (c.tipo === 'pilote') c.pilote = `P-${n}`
      else c.sondeo = `S-${n}`
    }
  }

  const matchTramo =
    t.match(/(?:de|desde|entre|en)\s*(\d+(?:\.\d+)?)\s*(?:metros?)?\s*(?:a|hasta|y|quedamos en|llegamos a)\s*(\d+(?:\.\d+)?)/i)

  if (matchTramo) {
    const ini = parseFloat(matchTramo[1])
    const fin = parseFloat(matchTramo[2])
    if (fin > ini) {
      c.tramo_inicio = ini
      c.tramo_fin = fin
      c.metros = parseFloat((fin - ini).toFixed(2))
    }
  }

  const matchCota = t.match(/(?:profundidad|cota|quedamos en|llegamos a|vamos en|hasta los?)\s*(\d+(?:\.\d+)?)\s*metros?/i)
  if (matchCota) {
    c.cota_actual = parseFloat(matchCota[1])
  }

  const pqEsp = t.match(/(\d+(?:\.\d+)?)\s*(?:metros?\s*)?(?:en|de|fueron)?\s*\bpq\b/i) || t.match(/\bpq\b[\s:=]*(?:de|fueron)?\s*(\d+(?:\.\d+)?)/i)
  const ensEsp = t.match(/(\d+(?:\.\d+)?)\s*(?:metros?\s*)?(?:en|de|fueron)?\s*\bensanche\b/i) || t.match(/\bensanche\b[\s:=]*(?:de|fueron)?\s*(\d+(?:\.\d+)?)/i)
  const encEsp = t.match(/(\d+(?:\.\d+)?)\s*(?:metros?\s*)?(?:en|de|fueron)?\s*\bencamisado\b/i) || t.match(/\bencamisado\b[\s:=]*(?:de|fueron)?\s*(\d+(?:\.\d+)?)/i)

  if (pqEsp) c.pq = parseFloat(pqEsp[1])
  if (ensEsp) c.ensanche = parseFloat(ensEsp[1])
  if (encEsp) c.encamisado = parseFloat(encEsp[1])

  const matchMetrosGen =
    t.match(/(\d+(?:\.\d+)?)\s*metros?\b/i) ||
    t.match(/\b(?:avanzamos|hicimos|avance|fueron|metimos)\s*(?:de\s*)?(\d+(?:\.\d+)?)\b/i)

  if (matchMetrosGen && (c.metros === null || c.metros === undefined)) {
    c.metros = parseFloat(matchMetrosGen[1])
  }

  if ((c.metros === null || c.metros === undefined) && previo.ya_pregunto && /^\d+(?:\.\d+)?$/.test(t.trim())) {
    c.metros = parseFloat(t.trim())
  }

  const mTotal = c.metros || previo.metros || null
  if (mTotal) {
    if (/\bpq\b/i.test(t) && !c.pq) { c.pq = mTotal; c.tipo = 'pilote' }
    if (/\bensanche\b/i.test(t) && !c.ensanche) { c.ensanche = mTotal; c.tipo = 'pilote' }
    if (/\bencamisado\b/i.test(t) && !c.encamisado) { c.encamisado = mTotal; c.tipo = 'pilote' }
  }

  const matchRecobro = t.match(/\b(?:recobro|recuperacion|rqd|r)\s*(?:de\s*|fue\s*|:|=)?\s*(\d+(?:\.\d+)?)\s*(cm|%|metros?)?/i)
  if (matchRecobro) {
    const unidad = matchRecobro[2] || 'cm'
    c.recobro = `${matchRecobro[1]}${unidad}`
  } else if (/\b(sin recobro|no salio muestra|se lavo la muestra|recobro 0)\b/i.test(t)) {
    c.recobro = '0% (Lavado / Sin recuperación)'
  }

  const matchCantSpt = t.match(/(\d+)\s*(?:ensayos?\s*(?:de\s*)?|muestras?\s*(?:de\s*)?)?\bspt\b/i)
  if (matchCantSpt) {
    c.ensayos_spt = parseInt(matchCantSpt[1])
  } else if (/\bspt\b/i.test(t) && !c.ensayos_spt) {
    c.ensayos_spt = 1
  }

  const matchCantShelby = t.match(/(\d+)\s*(?:tubos?\s*|muestras?\s*(?:de\s*)?)?\bshelby\b/i)
  if (matchCantShelby) {
    c.muestras_shelby = parseInt(matchCantShelby[1])
  } else if (/\bshelby\b/i.test(t) && !c.muestras_shelby) {
    c.muestras_shelby = 1
  }

  return c
}

function esConfirmacionPositiva(t: string): boolean {
  const limpio = t.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim()
  const afirmaciones = [
    'si', 'sii', 'siii', 'sip', 'si senor', 'correcto', 'ok', 'okay', 'listo',
    'de acuerdo', 'confirmo', 'confirmado', 'guardar', 'asentar', 'dale',
    'de una', 'asi es', 'esta bien', 'perfecto', 'bien', 'claro', 'afirmativo',
    'eso es', 'exacto', 'positivo', '👍', '✅'
  ]
  return afirmaciones.includes(limpio) || /^(si|ok|listo|correcto|confirmo)\b/i.test(limpio)
}

function esNegacionSimple(t: string): boolean {
  const limpio = t.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim()
  const negaciones = [
    'no', 'noo', 'nop', 'no senor', 'incorrecto', 'asi no', 'esta mal',
    'negativo', 'eso no fue', 'mal', 'equivocado', 'no es asi'
  ]
  return negaciones.includes(limpio)
}

function esSaludoEstricto(t: string): boolean {
  const limpio = t.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()¿?¡!]/g, '').trim()
  const saludos = [
    'hola', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches',
    'buenas', 'hola buen dia', 'hola buenas tardes', 'hola buenas',
    'hola don miguel', 'buenas don miguel', 'buenos dias don miguel',
    'q tal', 'que tal', 'como estan', 'como esta', 'como vamos', 'al pelo'
  ]
  return saludos.includes(limpio)
}

function tieneAvanceTecnico(t: string): boolean {
  const norm = normalizarJergaYOrtografia(t)
  return (
    /(\d+(?:\.\d+)?)\s*metros?\b/i.test(norm) ||
    /\b(sondeo|pilote|pq|ensanche|encamisado|spt|shelby|recobro)\b/i.test(norm) ||
    /\b(?:sp|sc|st|p)[-_\s]*0*\d+\b/i.test(norm)
  )
}

function detectarLluvia(t: string): boolean {
  const palabras = [
    'lluvia', 'llubia', 'yubia', 'llovio', 'yovio', 'lloviendo', 'llovedor',
    'aguacero', 'aguasero', 'tormenta', 'tempestad', 'borrasca', 'invierno',
    'inundado', 'inundo', 'empantanado', 'mucho barro', 'mal clima', 'por agua paramos'
  ]
  return palabras.some(p => t.includes(p))
}

function detectarVaradaMecanica(t: string): boolean {
  const palabras = [
    'varad', 'barad', 'dano', 'daño', 'danado', 'falla', 'revento', 'rebento',
    'rompio', 'manguera rota', 'motor', 'bomba', 'motobomba', 'torno', 'soldad',
    'sin acpm', 'sin combustible', 'se atranco', 'se pego la tuberia', 'sarta pegada',
    'pescando', 'corona quemada', 'broca', 'mordaza', 'winche', 'malacate',
    'swivel', 'swifer', 'embrague', 'clutch', 'fuga hidraulica', 'recalento', 'bateria'
  ]
  return palabras.some(p => t.includes(p))
}

function detectarLogisticaOStandby(t: string): boolean {
  const palabras = [
    'trasteo', 'trasteando', 'trastear', 'traslado', 'trasladando', 'moviendo maquina',
    'cambio de punto', 'armando', 'armar', 'desarmando', 'desarmar', 'desarme',
    'instalando', 'montando', 'tripode', 'torre', 'manguera', 'cuadrando el agua',
    'buscando agua', 'sin agua', 'explanacion', 'esplanasion', 'planchada', 'camino',
    'trocha', 'sacando tuberia', 'lavando pozo', 'mantenimiento', 'engrasando',
    'cajas de muestras', 'interventoria', 'esperando permiso', 'topografia',
    'replanteo', 'charla de seguridad', 'induccion', 'bloqueo', 'comunidad'
  ]
  return palabras.some(p => t.includes(p))
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
