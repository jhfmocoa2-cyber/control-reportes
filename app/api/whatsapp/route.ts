import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const META_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'clave_secreta_reportes_2026'
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''

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

    // 1. Identificar trabajador registrado y activo
    const { data: trabajadores } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .or(`telefono.eq.${cleanFrom},telefono.eq.${localPhone}`)
      .eq('activo', true)

    const trabajador = trabajadores?.[0]

    if (!trabajador) {
      await enviarWhatsApp(
        from,
        '⚠️ Este número no se encuentra registrado como personal activo en JHF Perforaciones.'
      )
      return NextResponse.json({ status: 'unregistered_user' })
    }

    // 2. Control de formato: rechazo de notas de voz
    if (message.type === 'audio' || message.type === 'voice') {
      await enviarWhatsApp(
        from,
        '👋 Hola, este sistema automatizado solo procesa texto. Por favor redacta tu reporte por escrito.'
      )
      return NextResponse.json({ status: 'audio_rejected' })
    }

    // 3. Recepción de fotografía de evidencia
    if (message.type === 'image') {
      await enviarWhatsApp(
        from,
        '📷 Foto de evidencia recibida con éxito. Recuerda redactar el texto con las cotas si aún no lo has enviado.'
      )
      return NextResponse.json({ status: 'image_received' })
    }

    // 4. Procesamiento de texto
    if (message.type === 'text') {
      const textoCrudo = message.text?.body?.trim() || ''
      const textoLower = textoCrudo.toLowerCase()
      const estadoActual = trabajador.estado_conversacion || 'inactivo'
      const borrador = trabajador.borrador_reporte || {}

      // A. Cancelación o anulación
      if (
        textoLower.includes('cancelar') ||
        textoLower.includes('anular') ||
        textoLower.includes('no mentira') ||
        textoLower.includes('borrar') ||
        textoLower.includes('me equivoqu')
      ) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'inactivo',
          borrador_reporte: null
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          '🔄 Reporte cancelado. Puedes escribir nuevamente los datos de tu jornada.'
        )
        return NextResponse.json({ status: 'cancelled' })
      }

      // B. Seguimiento a Varadas / Paradas de obra
      if (estadoActual === 'varada_preguntando_solucion') {
        const sigueParado = textoLower.includes('sigue') || textoLower.includes('no') || textoLower.includes('parado') || textoLower.includes('mañana')
        const resolucion = sigueParado ? 'EQUIPO QUEDA PARALIZADO' : 'NOVEDAD SOLUCIONADA'

        const datosVarada = {
          tipo: 'standby',
          resumen: `• *Estado:* STAND-BY / VARADA\n• *Motivo:* ${borrador.motivo_varada || 'Inconveniente técnico'}\n• *Situación:* ${resolucion}\n• *Detalle:* ${textoCrudo}`,
          observaciones: `${borrador.motivo_varada || ''} | ${resolucion} | Nota: ${textoCrudo}`
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

      // C. Confirmación definitiva del reporte
      if (['si', 'sí', 'correcto', 'ok', 'de acuerdo', 'confirmo', 'listo', 'guardar'].includes(textoLower)) {
        if (trabajador.borrador_reporte) {
          const b = trabajador.borrador_reporte

          await supabase.from('reportes_operativos').insert({
            trabajador_id: trabajador.id,
            proyecto_id: trabajador.proyecto_id,
            trabajador_nombre: trabajador.nombre,
            proyecto_nombre: trabajador.proyectos?.nombre || 'General',
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
            '✅ *Reporte consolidado con éxito en el sistema de JHF Perforaciones.*\n\nQuedó registrado para la bitácora diaria. ¡Muchas gracias y buen descanso!'
          )
          return NextResponse.json({ status: 'saved' })
        }
      }

      // D. Detección de novedad o falla mecánica
      if (detectarVarada(textoLower)) {
        await supabase.from('trabajadores').update({
          estado_conversacion: 'varada_preguntando_solucion',
          borrador_reporte: { motivo_varada: textoCrudo }
        }).eq('id', trabajador.id)

        await enviarWhatsApp(
          from,
          `⚠️ *Novedad registrada:* "${textoCrudo}"\n\n¿El problema se logró solucionar hoy o el equipo queda *PARADO* para mañana? ¿Qué repuesto o gestión se está esperando?`
        )
        return NextResponse.json({ status: 'varada_followup' })
      }

      // E. Procesamiento técnico de avance (Pilotaje o Suelos)
      const previo = estadoActual === 'esperando_confirmacion' ? borrador : null
      const nuevoBorrador = interpretarAvanceObra(textoCrudo, previo)

      await supabase.from('trabajadores').update({
        estado_conversacion: 'esperando_confirmacion',
        borrador_reporte: nuevoBorrador
      }).eq('id', trabajador.id)

      await enviarWhatsApp(
        from,
        `📋 *Resumen de tu reporte:* \n\n${nuevoBorrador.resumen}\n\n` +
        `----------------------------\n` +
        `📷 *Recuerda enviar la foto de la planilla o testigo.*\n\n` +
        `¿Los datos son correctos? Responde *SÍ* para asentar o escribe el dato a corregir (ej: *ensanche 2m* o *pilote P-04*).`
      )
      return NextResponse.json({ status: 'draft_created' })
    }

    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('Error procesando webhook:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// 1. Limpieza léxica y normalización fonética
function normalizarTexto(txt: string): string {
  let s = txt.toLowerCase()

  // Comas a puntos
  s = s.replace(/(\d+),(\d+)/g, '$1.$2')

  // Ortografía coloquial
  s = s.replace(/\b(icimos|isimos|hizimos|hicimls|hicmos)\b/g, 'hicimos')
  s = s.replace(/\b(abansamos|avansamos|avanzamls)\b/g, 'avanzamos')
  s = s.replace(/\b(preueco|pre ueco|pre-hueco|pre hueco|preperforacion|preperforasion)\b/g, 'pq')
  s = s.replace(/\b(ensanxe|ensanchado|ensanchamos|escariado|escariador)\b/g, 'ensanche')
  s = s.replace(/\b(encamizado|camisa|camisas|tuberia)\b/g, 'encamisado')

  // Conversión de palabras numéricas a dígitos
  const numerosTexto: Record<string, string> = {
    'cero': '0', 'un': '1', 'uno': '1', 'una': '1', 'dos': '2', 'tres': '3',
    'cuatro': '4', 'cinco': '5', 'seis': '6', 'siete': '7', 'ocho': '8',
    'nueve': '9', 'diez': '10', 'once': '11', 'doce': '12', 'quince': '15', 'veinte': '20'
  }
  for (const [palabra, digito] of Object.entries(numerosTexto)) {
    s = s.replace(new RegExp(`\\b${palabra}\\b`, 'g'), digito)
  }

  // Fracciones y decimales hablados (tanto para dígitos como para palabras)
  // Ej: "2 metros y medio", "2 y medio", "2m y medio" -> 2.5 metros
  s = s.replace(/(\d+)\s*(?:m|mts|metros)?\s*(?:y\s*medio|con\s*medio|y\s*media)\b/g, (_, n) => `${parseFloat(n) + 0.5} metros`)
  
  // Ej: "metro y medio", "1 metro y medio" -> 1.5 metros
  s = s.replace(/\b(?:1\s*)?(?:m|mts|metros)?\s*(?:y\s*medio|con\s*medio|y\s*media)\b/g, '1.5 metros')
  
  // Ej: "medio metro" -> 0.5 metros
  s = s.replace(/\bmedio\s*(?:m|mts|metros?)\b/g, '0.5 metros')

  // Ej: "2 con 5", "3 con 2" -> 2.5, 3.2
  s = s.replace(/\b(\d+)\s*con\s*(\d+)\b/g, '$1.$2 metros')

  return s
}

function detectarVarada(tl: string): boolean {
  const palabras = [
    'varad', 'dano', 'daño', 'falla', 'revento', 'rompio', 'manguera',
    'lluvia', 'llubia', 'llovi', 'inund', 'torno', 'soldad', 'sin acpm',
    'sin combustible', 'sin agua', 'no llego concreto', 'esperando mixer',
    'no llego hierro', 'paro interventoria', 'paraliz', 'stand by', 'standby'
  ]
  return palabras.some(p => tl.includes(p)) && !tl.includes('hicimos') && !tl.includes('avanzamos')
}

// 2. Extracción técnica robusta
function interpretarAvanceObra(textoOriginal: string, previo: any = null) {
  const t = normalizarTexto(textoOriginal)

  // Caso: Estudio de suelos (SPT, NQ, Sondeos)
  if (t.includes('spt') || t.includes('sondeo') || t.includes('shelby') || t.includes('nq')) {
    const sondeoMatch = t.match(/s(?:ondeo)?[\s-]*(\d+)/i)
    const sptMatch = t.match(/(\d+)\s*(?:spt|ensayos?|golpes?)/i)
    const cotaMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:m|mts|metros)?/i)

    const sondeoFinal = sondeoMatch ? `S-${sondeoMatch[1].padStart(2, '0')}` : (previo?.sondeo || 'S-01')
    const sptFinal = sptMatch ? parseInt(sptMatch[1]) : (previo?.ensayos_spt || 1)
    const nqFinal = cotaMatch ? parseFloat(cotaMatch[1]) : (previo?.metros_nq || 0)

    return {
      tipo: 'estudio_suelo',
      sondeo: sondeoFinal,
      ensayos_spt: sptFinal,
      metros_nq: nqFinal,
      resumen: `• *Tipo:* EXPLORACIÓN GEOTÉCNICA\n• *Sondeo:* ${sondeoFinal}\n• *Profundidad / Cota:* ${nqFinal} m\n• *Ensayos SPT:* ${sptFinal}\n• *Observación:* "${textoOriginal}"`,
      observaciones: textoOriginal
    }
  }

  // Caso: Pilotaje (Pilote, Preperforación PQ, Ensanche, Encamisado)
  const piloteMatch = t.match(/(?:pilote|p)[\s-]*(\d+)/i) || t.match(/\b(?:en el|al|el)\s+(\d+)\b/i)

  // PQ: busca número antes de 'pq' O después de 'pq'
  const pqMatch =
    t.match(/(\d+(?:\.\d+)?)\s*(?:m|mts|metros)?\s*(?:en|de)?\s*pq\b/i) ||
    t.match(/\bpq\b\s*(?:de|en|fue|fueron)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i)

  // Ensanche: busca número antes de 'ensanche' O después de 'ensanche'
  const ensancheMatch =
    t.match(/(\d+(?:\.\d+)?)\s*(?:m|mts|metros)?\s*(?:de|en)?\s*ensanche\b/i) ||
    t.match(/\bensanche\b\s*(?:de|en|fue|fueron)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i)

  // Encamisado: busca número antes de 'encamisado' O después de 'encamisado'
  const encamisadoMatch =
    t.match(/(\d+(?:\.\d+)?)\s*(?:m|mts|metros)?\s*(?:de|en)?\s*encamisado\b/i) ||
    t.match(/\bencamisado\b\s*(?:de|en|fue|fueron)?\s*[:=]?\s*(\d+(?:\.\d+)?)/i)

  // Consolidación y memoria de corrección
  const piloteFinal = piloteMatch ? `P-${piloteMatch[1].padStart(2, '0')}` : (previo?.pilote || 'P-01')
  const pqFinal = pqMatch ? parseFloat(pqMatch[1]) : (previo?.avance_pq ?? 0)
  const ensancheFinal = ensancheMatch ? parseFloat(ensancheMatch[1]) : (previo?.ensanche ?? 0)
  const encamisadoFinal = encamisadoMatch ? parseFloat(encamisadoMatch[1]) : (previo?.encamisado ?? 0)

  return {
    tipo: 'pilote',
    pilote: piloteFinal,
    avance_pq: pqFinal,
    ensanche: ensancheFinal,
    encamisado: encamisadoFinal,
    resumen: `• *Tipo:* PILOTAJE\n• *Pilote:* ${piloteFinal}\n• *Preperforación (PQ):* ${pqFinal} m\n• *Ensanche:* ${ensancheFinal} m\n• *Encamisado:* ${encamisadoFinal} m`,
    observaciones: textoOriginal
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
