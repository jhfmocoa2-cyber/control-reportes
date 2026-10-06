import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'clave_secreta_reportes_2026'
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''

interface BorradorFinal {
  tipo: string
  pilote?: string | null
  sondeo?: string | null
  avance_pq?: number
  ensanche?: number
  encamisado?: number
  metros_nq?: number
  ensayos_spt?: number
  observaciones?: string
  resumen: string
}

interface ResultadoAnalisis {
  datosIncompletos: boolean
  preguntaAclaratoria?: string
  borradorParcial?: any
  borradorFinal?: BorradorFinal
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

    // 1. Identificar trabajador registrado
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

    // 2. Rechazo de audios
    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(
        from,
        '👋 Hola, este sistema automatizado solo procesa texto. Por favor redacta el avance o novedad en un mensaje escrito.'
      )
      return NextResponse.json({ status: 'audio_rejected' })
    }

    // 3. Recepción de fotos de evidencia
    if (message.type === 'image') {
      await enviarWhatsApp(
        from,
        '📷 Foto de evidencia recibida con éxito. Recuerda enviar también los datos del avance en texto si aún no los has registrado.'
      )
      return NextResponse.json({ status: 'image_received' })
    }

    // 4. Procesamiento de texto
    if (message.type === 'text') {
      const textoCrudo = message.text?.body?.trim() || ''
      const textoLower = textoCrudo.toLowerCase()
      const estadoActual = trabajador.estado_conversacion || 'inactivo'
      const borrador = trabajador.borrador_reporte || {}
      const nombreOperador = trabajador.nombre
      const frenteNombre = trabajador.proyectos?.nombre || 'General'

      // A. Comandos de cancelación
      if (['cancelar', 'anular', 'no mentira', 'borrar', 'me equivoque', 'me equivoqué'].some(k => textoLower.includes(k))) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          '🔄 Reporte cancelado. Puedes redactar nuevamente los datos correspondientes a tu jornada.'
        )
        return NextResponse.json({ status: 'cancelled' })
      }

      // B. Saludos aislados
      if (esSaludoAislado(textoLower)) {
        await enviarWhatsApp(
          from,
          `👋 ¡Buen día ${nombreOperador}! ¿Cómo te fue hoy en el frente? Cuéntame qué avance tuvieron o si hubo novedades mecánicas/climáticas en obra.`
        )
        return NextResponse.json({ status: 'greeting_replied' })
      }

      // C. Seguimiento a Varadas / Novedades
      if (estadoActual === 'varada_preguntando_solucion') {
        const sigueParado = textoLower.includes('sigue') || textoLower.includes('no') || textoLower.includes('parado') || textoLower.includes('mañana')
        const situacion = sigueParado ? 'EQUIPO QUEDA PARALIZADO' : 'NOVEDAD SOLUCIONADA'

        const datosVarada: BorradorFinal = {
          tipo: 'standby',
          resumen: `👷 *Operador:* ${nombreOperador}\n📍 *Frente:* ${frenteNombre}\n• *Actividad:* STAND-BY / NOVEDAD EN OBRA\n• *Motivo:* ${borrador.motivo_varada || 'Inconveniente operativo'}\n• *Situación:* ${situacion}\n• *Detalle:* ${textoCrudo}`,
          observaciones: `${borrador.motivo_varada || ''} | Estado: ${situacion} | Nota: ${textoCrudo}`
        }

        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_confirmacion',
          borrador_reporte: datosVarada
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `📋 *Resumen de la novedad registrada:*\n\n${datosVarada.resumen}\n\n📷 *Adjunta foto si la tienes.*\n\n¿Es correcto el reporte? Responde *SÍ* para asentar en bitácora.`
        )
        return NextResponse.json({ status: 'varada_ready' })
      }

      // D. Confirmación definitiva del reporte
      if (['si', 'sí', 'correcto', 'ok', 'de acuerdo', 'confirmo', 'listo', 'guardar'].includes(textoLower)) {
        if (trabajador.borrador_reporte && estadoActual === 'esperando_confirmacion') {
          const b = trabajador.borrador_reporte

          await supabase.from('reportes_operativos').insert({
            trabajador_id: trabajador.id,
            proyecto_id: trabajador.proyecto_id,
            trabajador_nombre: nombreOperador,
            proyecto_nombre: frenteNombre,
            tipo_operacion: b.tipo || 'pilote',
            pilote: b.pilote || null,
            sondeo: b.sondeo || null,
            avance_pq: b.avance_pq || 0,
            ensanche: b.ensanche || 0,
            encamisado: b.encamisado || 0,
            metros_nq: b.metros_nq || 0,
            ensayos_spt: b.ensayos_spt || 0,
            observaciones: b.observaciones || b.resumen,
            confirmado: true
          })

          await supabase.from('trabajadores').update({
            estado_conversacion: 'inactivo',
            borrador_reporte: null
          }).eq('id', trabajador.id)

          await enviarWhatsApp(
            from,
            `✅ *Reporte de ${nombreOperador} consolidado con éxito en el sistema.*\n\nQuedó registrado para la bitácora diaria de JHF Perforaciones. ¡Muchas gracias y buen descanso!`
          )
          return NextResponse.json({ status: 'saved' })
        }
      }

      // E. Detección de problemas o varadas iniciales
      if (detectarVarada(textoLower)) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'varada_preguntando_solucion',
          borrador_reporte: { motivo_varada: textoCrudo }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `⚠️ *Novedad registrada:* "${textoCrudo}"\n\n¿El problema se logró solucionar hoy o el equipo queda *PARADO* para mañana? ¿Qué repuesto, suministro o gestión hace falta?`
        )
        return NextResponse.json({ status: 'varada_followup' })
      }

      // F. Detección de Actividades Logísticas
      if (detectarLogistica(textoLower)) {
        const datosLogistica: BorradorFinal = {
          tipo: 'logistica',
          resumen: `👷 *Operador:* ${nombreOperador}\n📍 *Frente:* ${frenteNombre}\n• *Actividad:* LOGÍSTICA / ALISTAMIENTO DE FRENTE\n• *Detalle:* ${textoCrudo}`,
          observaciones: textoCrudo
        }

        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_confirmacion',
          borrador_reporte: datosLogistica
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `📋 *Resumen de actividad:* \n\n${datosLogistica.resumen}\n\n📷 *Recuerda enviar foto de la actividad.*\n\n¿Es correcto el reporte? Responde *SÍ* para asentar en bitácora.`
        )
        return NextResponse.json({ status: 'logistica_ready' })
      }

      // G. Procesamiento técnico de avance (Pilotaje o Suelos)
      const previo = estadoActual === 'esperando_datos_faltantes' || estadoActual === 'esperando_confirmacion' ? borrador : null
      const interpretacion: ResultadoAnalisis = interpretarAvanceObra(textoCrudo, nombreOperador, frenteNombre, previo)

      if (interpretacion.datosIncompletos && interpretacion.preguntaAclaratoria) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_datos_faltantes',
          borrador_reporte: interpretacion.borradorParcial
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, interpretacion.preguntaAclaratoria)
        return NextResponse.json({ status: 'asking_missing_info' })
      }

      if (interpretacion.borradorFinal) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_confirmacion',
          borrador_reporte: interpretacion.borradorFinal
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `📋 *Resumen de tu reporte:* \n\n${interpretacion.borradorFinal.resumen}\n\n` +
          `----------------------------\n` +
          `📷 *Recuerda enviar la foto de la planilla, muestras o testigo.*\n\n` +
          `¿Los datos son correctos? Responde *SÍ* para asentar o escribe el ajuste.`
        )
        return NextResponse.json({ status: 'draft_ready' })
      }
    }

    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('Error procesando webhook:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// Funciones de apoyo

function esSaludoAislado(t: string): boolean {
  const palabras = t.split(/\s+/)
  const saludos = ['hola', 'buen', 'buenos', 'dia', 'dias', 'tarde', 'tardes', 'noches', 'don', 'miguel', 'como', 'esta', 'estan']
  return palabras.every(p => saludos.includes(p) || p.length <= 2)
}

function detectarVarada(t: string): boolean {
  const palabras = [
    'varad', 'dano', 'daño', 'falla', 'revento', 'rompio', 'manguera',
    'lluvia', 'llubia', 'llovi', 'inund', 'torno', 'soldad', 'sin acpm',
    'sin combustible', 'paro interventoria', 'paraliz', 'stand by', 'standby', 'se atranco'
  ]
  return palabras.some(p => t.includes(p)) && !t.includes('avance') && !t.includes('hicimos')
}

function detectarLogistica(t: string): boolean {
  const palabras = [
    'trasteo', 'trasteando', 'armar', 'armando', 'desarmar', 'desarmando',
    'manguera', 'tirando manguera', 'esplanasion', 'explanacion', 'camino',
    'sacando tuberia', 'sacar tuberia', 'instalando', 'cuadrando el agua'
  ]
  return palabras.some(p => t.includes(p)) && !t.includes('avance') && !t.includes('pq') && !t.includes('ensanche')
}

function normalizarTexto(txt: string): string {
  let s = txt.toLowerCase()
  s = s.replace(/(\d+),(\d+)/g, '$1.$2')
  s = s.replace(/\b(icimos|isimos|hiz
cat << 'EOF' > app/api/whatsapp/route.ts
import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'clave_secreta_reportes_2026'
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''

interface BorradorFinal {
  tipo: string
  pilote?: string | null
  sondeo?: string | null
  avance_pq?: number
  ensanche?: number
  encamisado?: number
  metros_nq?: number
  ensayos_spt?: number
  observaciones?: string
  resumen: string
}

interface ResultadoAnalisis {
  datosIncompletos: boolean
  preguntaAclaratoria?: string
  borradorParcial?: any
  borradorFinal?: BorradorFinal
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

    // 1. Identificar trabajador registrado
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

    // 2. Rechazo de audios
    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(
        from,
        '👋 Hola, este sistema automatizado solo procesa texto. Por favor redacta el avance o novedad en un mensaje escrito.'
      )
      return NextResponse.json({ status: 'audio_rejected' })
    }

    // 3. Recepción de fotos de evidencia
    if (message.type === 'image') {
      await enviarWhatsApp(
        from,
        '📷 Foto de evidencia recibida con éxito. Recuerda enviar también los datos del avance en texto si aún no los has registrado.'
      )
      return NextResponse.json({ status: 'image_received' })
    }

    // 4. Procesamiento de texto
    if (message.type === 'text') {
      const textoCrudo = message.text?.body?.trim() || ''
      const textoLower = textoCrudo.toLowerCase()
      const estadoActual = trabajador.estado_conversacion || 'inactivo'
      const borrador = trabajador.borrador_reporte || {}
      const nombreOperador = trabajador.nombre
      const frenteNombre = trabajador.proyectos?.nombre || 'General'

      // A. Comandos de cancelación
      if (['cancelar', 'anular', 'no mentira', 'borrar', 'me equivoque', 'me equivoqué'].some(k => textoLower.includes(k))) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          '🔄 Reporte cancelado. Puedes redactar nuevamente los datos correspondientes a tu jornada.'
        )
        return NextResponse.json({ status: 'cancelled' })
      }

      // B. Saludos aislados
      if (esSaludoAislado(textoLower)) {
        await enviarWhatsApp(
          from,
          `👋 ¡Buen día ${nombreOperador}! ¿Cómo te fue hoy en el frente? Cuéntame qué avance tuvieron o si hubo novedades mecánicas/climáticas en obra.`
        )
        return NextResponse.json({ status: 'greeting_replied' })
      }

      // C. Seguimiento a Varadas / Novedades
      if (estadoActual === 'varada_preguntando_solucion') {
        const sigueParado = textoLower.includes('sigue') || textoLower.includes('no') || textoLower.includes('parado') || textoLower.includes('mañana')
        const situacion = sigueParado ? 'EQUIPO QUEDA PARALIZADO' : 'NOVEDAD SOLUCIONADA'

        const datosVarada: BorradorFinal = {
          tipo: 'standby',
          resumen: `👷 *Operador:* ${nombreOperador}\n📍 *Frente:* ${frenteNombre}\n• *Actividad:* STAND-BY / NOVEDAD EN OBRA\n• *Motivo:* ${borrador.motivo_varada || 'Inconveniente operativo'}\n• *Situación:* ${situacion}\n• *Detalle:* ${textoCrudo}`,
          observaciones: `${borrador.motivo_varada || ''} | Estado: ${situacion} | Nota: ${textoCrudo}`
        }

        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_confirmacion',
          borrador_reporte: datosVarada
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `📋 *Resumen de la novedad registrada:*\n\n${datosVarada.resumen}\n\n📷 *Adjunta foto si la tienes.*\n\n¿Es correcto el reporte? Responde *SÍ* para asentar en bitácora.`
        )
        return NextResponse.json({ status: 'varada_ready' })
      }

      // D. Confirmación definitiva del reporte
      if (['si', 'sí', 'correcto', 'ok', 'de acuerdo', 'confirmo', 'listo', 'guardar'].includes(textoLower)) {
        if (trabajador.borrador_reporte && estadoActual === 'esperando_confirmacion') {
          const b = trabajador.borrador_reporte

          await supabase.from('reportes_operativos').insert({
            trabajador_id: trabajador.id,
            proyecto_id: trabajador.proyecto_id,
            trabajador_nombre: nombreOperador,
            proyecto_nombre: frenteNombre,
            tipo_operacion: b.tipo || 'pilote',
            pilote: b.pilote || null,
            sondeo: b.sondeo || null,
            avance_pq: b.avance_pq || 0,
            ensanche: b.ensanche || 0,
            encamisado: b.encamisado || 0,
            metros_nq: b.metros_nq || 0,
            ensayos_spt: b.ensayos_spt || 0,
            observaciones: b.observaciones || b.resumen,
            confirmado: true
          })

          await supabase.from('trabajadores').update({
            estado_conversacion: 'inactivo',
            borrador_reporte: null
          }).eq('id', trabajador.id)

          await enviarWhatsApp(
            from,
            `✅ *Reporte de ${nombreOperador} consolidado con éxito en el sistema.*\n\nQuedó registrado para la bitácora diaria de JHF Perforaciones. ¡Muchas gracias y buen descanso!`
          )
          return NextResponse.json({ status: 'saved' })
        }
      }

      // E. Detección de problemas o varadas iniciales
      if (detectarVarada(textoLower)) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'varada_preguntando_solucion',
          borrador_reporte: { motivo_varada: textoCrudo }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `⚠️ *Novedad registrada:* "${textoCrudo}"\n\n¿El problema se logró solucionar hoy o el equipo queda *PARADO* para mañana? ¿Qué repuesto, suministro o gestión hace falta?`
        )
        return NextResponse.json({ status: 'varada_followup' })
      }

      // F. Detección de Actividades Logísticas
      if (detectarLogistica(textoLower)) {
        const datosLogistica: BorradorFinal = {
          tipo: 'logistica',
          resumen: `👷 *Operador:* ${nombreOperador}\n📍 *Frente:* ${frenteNombre}\n• *Actividad:* LOGÍSTICA / ALISTAMIENTO DE FRENTE\n• *Detalle:* ${textoCrudo}`,
          observaciones: textoCrudo
        }

        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_confirmacion',
          borrador_reporte: datosLogistica
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `📋 *Resumen de actividad:* \n\n${datosLogistica.resumen}\n\n📷 *Recuerda enviar foto de la actividad.*\n\n¿Es correcto el reporte? Responde *SÍ* para asentar en bitácora.`
        )
        return NextResponse.json({ status: 'logistica_ready' })
      }

      // G. Procesamiento técnico de avance (Pilotaje o Suelos)
      const previo = estadoActual === 'esperando_datos_faltantes' || estadoActual === 'esperando_confirmacion' ? borrador : null
      const interpretacion: ResultadoAnalisis = interpretarAvanceObra(textoCrudo, nombreOperador, frenteNombre, previo)

      if (interpretacion.datosIncompletos && interpretacion.preguntaAclaratoria) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_datos_faltantes',
          borrador_reporte: interpretacion.borradorParcial
        }).eq('id', trabajador.id)

        await enviarWhatsApp(from, interpretacion.preguntaAclaratoria)
        return NextResponse.json({ status: 'asking_missing_info' })
      }

      if (interpretacion.borradorFinal) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'esperando_confirmacion',
          borrador_reporte: interpretacion.borradorFinal
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `📋 *Resumen de tu reporte:* \n\n${interpretacion.borradorFinal.resumen}\n\n` +
          `----------------------------\n` +
          `📷 *Recuerda enviar la foto de la planilla, muestras o testigo.*\n\n` +
          `¿Los datos son correctos? Responde *SÍ* para asentar o escribe el ajuste.`
        )
        return NextResponse.json({ status: 'draft_ready' })
      }
    }

    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('Error procesando webhook:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// Funciones de apoyo

function esSaludoAislado(t: string): boolean {
  const palabras = t.split(/\s+/)
  const saludos = ['hola', 'buen', 'buenos', 'dia', 'dias', 'tarde', 'tardes', 'noches', 'don', 'miguel', 'como', 'esta', 'estan']
  return palabras.every(p => saludos.includes(p) || p.length <= 2)
}

function detectarVarada(t: string): boolean {
  const palabras = [
    'varad', 'dano', 'daño', 'falla', 'revento', 'rompio', 'manguera',
    'lluvia', 'llubia', 'llovi', 'inund', 'torno', 'soldad', 'sin acpm',
    'sin combustible', 'paro interventoria', 'paraliz', 'stand by', 'standby', 'se atranco'
  ]
  return palabras.some(p => t.includes(p)) && !t.includes('avance') && !t.includes('hicimos')
}

function detectarLogistica(t: string): boolean {
  const palabras = [
    'trasteo', 'trasteando', 'armar', 'armando', 'desarmar', 'desarmando',
    'manguera', 'tirando manguera', 'esplanasion', 'explanacion', 'camino',
    'sacando tuberia', 'sacar tuberia', 'instalando', 'cuadrando el agua'
  ]
  return palabras.some(p => t.includes(p)) && !t.includes('avance') && !t.includes('pq') && !t.includes('ensanche')
}

function normalizarTexto(txt: string): string {
  let s = txt.toLowerCase()
  s = s.replace(/(\d+),(\d+)/g, '$1.$2')
  s = s.replace(/\b(icimos|isimos|hizimos|hicimls|hicmos)\b/g, 'hicimos')
  s = s.replace(/\b(abansamos|avansamos|avanzamls)\b/g, 'avanzamos')
  s = s.replace(/\b(preueco|pre ueco|pre-hueco|pre hueco|preperforacion|preperforasion)\b/g, 'pq')
  s = s.replace(/\b(ensanxe|ensanchado|ensanchamos|escariado)\b/g, 'ensanche')
  s = s.replace(/\b(encamizado|camisa|camisas|tuberia)\b/g, 'encamisado')

  const numerosTexto: Record<string, string> = {
    'cero': '0', 'un': '1', 'uno': '1', 'una': '1', 'dos': '2', 'tres': '3',
    'cuatro': '4', 'cinco': '5', 'seis': '6', 'siete': '7', 'ocho': '8',
    'nueve': '9', 'diez': '10', 'once': '11', 'doce': '12', 'quince': '15', 'veinte': '20'
  }
  for (const [palabra, digito] of Object.entries(numerosTexto)) {
    s = s.replace(new RegExp(`\\b${palabra}\\b`, 'g'), digito)
  }

  s = s.replace(/(\d+)\s*(?:m|mts|metros)?\s*(?:y\s*medio|con\s*medio|y\s*media)\b/g, (_, n) => `${parseFloat(n) + 0.5} metros`)
  s = s.replace(/\b(?:1\s*)?(?:m|mts|metros)?\s*(?:y\s*medio|con\s*medio|y\s*media)\b/g, '1.5 metros')
  s = s.replace(/\bmedio\s*(?:m|mts|metros?)\b/g, '0.5 metros')
  s = s.replace(/\b(\d+)\s*con\s*(\d+)\b/g, '$1.$2 metros')

  return s
}

function interpretarAvanceObra(
  textoOriginal: string,
  operador: string,
  frente: string,
  previo: any = null
): ResultadoAnalisis {
  const t = normalizarTexto(textoOriginal)

  // 1. Detección de tramos de Sondeos: "De X a Y R Z"
  const rangoSondeo = t.match(/de\s*(\d+(?:\.\d+)?)\s*(?:m|mt|mts|metros)?\s*a\s*(\d+(?:\.\d+)?)\s*(?:m|mt|mts|metros)?(?:\s*(?:r|recobro)\s*(\d+(?:\.\d+)?))?/i)
  if (rangoSondeo) {
    const cotaIni = parseFloat(rangoSondeo[1])
    const cotaFin = parseFloat(rangoSondeo[2])
    const avance = parseFloat((cotaFin - cotaIni).toFixed(2))
    const recobro = rangoSondeo[3] ? `${rangoSondeo[3]} cm` : 'No especificado'

    const sondeoMatch = t.match(/(?:sondeo|sc|s|st|punto)[\s-]*(\d+)/i)
    const sondeoFinal = sondeoMatch ? `S-${sondeoMatch[1].padStart(2, '0')}` : (previo?.sondeo || null)

    if (!sondeoFinal) {
      return {
        datosIncompletos: true,
        borradorParcial: { tipo: 'estudio_suelo', metros_nq: avance, cota_fin: cotaFin, recobro, observaciones: textoOriginal },
        preguntaAclaratoria: `👍 Entendido el tramo de ${cotaIni} m a ${cotaFin} m (Avance: ${avance} m | Recobro: ${recobro}).\n\n¿En qué *número de sondeo o punto* están trabajando? (Ej: *Sondeo 2*, *SC13* o *Punto 19*).`
      }
    }

    return {
      datosIncompletos: false,
      borradorFinal: {
        tipo: 'estudio_suelo',
        sondeo: sondeoFinal,
        metros_nq: avance,
        observaciones: `${textoOriginal} | Cota: ${cotaFin}m | Recobro: ${recobro}`,
        resumen: `👷 *Operador:* ${operador}\n📍 *Frente:* ${frente}\n• *Tipo:* ESTUDIO DE SUELOS\n• *Sondeo:* ${sondeoFinal}\n• *Tramo:* ${cotaIni} m a ${cotaFin} m (Avance: ${avance} m)\n• *Recobro:* ${recobro}\n• *Detalle:* ${textoOriginal}`
      }
    }
  }

  // 2. Extracción de entidades
  const piloteMatch = t.match(/(?:pilote|p)[\s-]*(\d+)/i) || t.match(/\b(?:en el|al|el)\s+(\d+)\b/i)
  const sondeoMatch = t.match(/(?:sondeo|sc|s|st)[\s-]*(\d+)/i)

  const pqMatch =
    t.match(/(\d+(?:\.\d+)?)\s*(?:m|mts|metros)?\s*(?:en|de)?\s*pq\b/i) ||
    t.match(/\bpq\b\s*(?:de|en|fue|fueron)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i)

  const ensancheMatch =
    t.match(/(\d+(?:\.\d+)?)\s*(?:m|mts|metros)?\s*(?:de|en)?\s*ensanche\b/i) ||
    t.match(/\bensanche\b\s*(?:de|en|fue|fueron)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i)

  const encamisadoMatch =
    t.match(/(\d+(?:\.\d+)?)\s*(?:m|mts|metros)?\s*(?:de|en)?\s*encamisado\b/i) ||
    t.match(/\bencamisado\b\s*(?:de|en|fue|fueron)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i)

  const metrosGenericosMatch =
    t.match(/(?:avance|hicimos|hice|avanzamos|metimos)\s*(\d+(?:\.\d+)?)\s*(?:m|mts|metros)?/i) ||
    t.match(/(\d+(?:\.\d+)?)\s*(?:m|mts|metros)\s*(?:en general|hoy)?/i)

  const pilote = piloteMatch ? `P-${piloteMatch[1].padStart(2, '0')}` : (previo?.pilote || null)
  const sondeo = sondeoMatch ? `S-${sondeoMatch[1].padStart(2, '0')}` : (previo?.sondeo || null)
  const pq = pqMatch ? parseFloat(pqMatch[1]) : (previo?.avance_pq ?? null)
  const ensanche = ensancheMatch ? parseFloat(ensancheMatch[1]) : (previo?.ensanche ?? null)
  const encamisado = encamisadoMatch ? parseFloat(encamisadoMatch[1]) : (previo?.encamisado ?? null)

  // CASO DE METROS GENÉRICOS (No asume ceros ni P-01)
  if (metrosGenericosMatch && !pq && !ensanche && !encamisado && !t.includes('spt') && !t.includes('nq')) {
    const metros = parseFloat(metrosGenericosMatch[1])
    return {
      datosIncompletos: true,
      borradorParcial: { pilote, sondeo, metros_pendientes: metros, observaciones: textoOriginal },
      preguntaAclaratoria: `👍 Entendido el avance de *${metros} metros* para ${operador}.\n\nPara consolidar tu reporte:\n1. ¿En qué *pilote* o *sondeo* trabajaron?${pilote ? ` (Tengo anotado ${pilote})` : ''}\n2. ¿Esos ${metros} m fueron de *preperforación (PQ)*, *ensanche*, *encamisado* o *estudio de suelos*?`
    }
  }

  // Falta pilote o sondeo
  if (!pilote && !sondeo && (pq !== null || ensanche !== null || encamisado !== null)) {
    return {
      datosIncompletos: true,
      borradorParcial: { avance_pq: pq, ensanche, encamisado, observaciones: textoOriginal },
      preguntaAclaratoria: `📋 Entendido ${operador} (PQ: ${pq || 0}m, Ensanche: ${ensanche || 0}m).\n\n¿En qué *número de pilote* se hicieron estos trabajos? (Ej: *P-02* o *Pilote 3*).`
    }
  }

  const piloteFinal = pilote || 'P-01'
  const pqFinal = pq || 0
  const ensancheFinal = ensanche || 0
  const encamisadoFinal = encamisado || 0

  return {
    datosIncompletos: false,
    borradorFinal: {
      tipo: 'pilote',
      pilote: piloteFinal,
      avance_pq: pqFinal,
      ensanche: ensancheFinal,
      encamisado: encamisadoFinal,
      observaciones: textoOriginal,
      resumen: `👷 *Operador:* ${operador}\n📍 *Frente:* ${frente}\n• *Tipo:* PILOTAJE\n• *Pilote:* ${piloteFinal}\n• *Preperforación (PQ):* ${pqFinal} m\n• *Ensanche:* ${ensancheFinal} m\n• *Encamisado:* ${encamisadoFinal} m`
    }
  }
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
