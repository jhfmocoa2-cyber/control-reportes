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
    const msgType = message.type
    console.log(`[MENSAJE ENTRANTE] De: ${from} | Tipo: ${msgType}`)

    // 1. Buscar trabajador en Supabase
    const { data: trabajador, error: dbError } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .eq('telefono', from)
      .eq('activo', true)
      .maybeSingle()

    if (dbError) {
      console.error('[SUPABASE ERROR]:', dbError)
    }

    if (!trabajador) {
      console.warn(`[AVISO] Número ${from} no registrado o inactivo en Supabase. Enviando advertencia...`)
      await enviarWhatsApp(
        from,
        '⚠️ Hola, este número no se encuentra registrado como personal activo en el sistema de control operativo.'
      )
      return NextResponse.json({ status: 'unregistered_user' })
    }

    // 2. Si envía audio o nota de voz
    if (msgType === 'audio' || msgType === 'voice') {
      await enviarWhatsApp(
        from,
        '👋 Hola, soy un bot de control operativo y no puedo procesar audios. Por favor escribe tu reporte detallado en un mensaje de texto.'
      )
      return NextResponse.json({ status: 'audio_rejected' })
    }

    // 3. Si envía foto
    if (msgType === 'image') {
      await enviarWhatsApp(
        from,
        '📷 Foto de evidencia recibida con éxito. Por favor acompáñala con el reporte en texto si aún no lo has enviado.'
      )
      return NextResponse.json({ status: 'image_received' })
    }

    // 4. Si envía texto
    if (msgType === 'text') {
      const texto = message.text?.body?.trim() || ''
      const textoLower = texto.toLowerCase()

      // Confirmación
      if (['si', 'sí', 'correcto', 'está bien', 'esta bien', 'ok', 'de acuerdo'].includes(textoLower)) {
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
            observaciones: b.resumen,
            confirmado: true
          })

          await supabase.from('trabajadores').update({
            estado_conversacion: 'inactivo',
            borrador_reporte: null
          }).eq('id', trabajador.id)

          await enviarWhatsApp(
            from,
            '✅ Reporte registrado y consolidado en el sistema con éxito. ¡Muchas gracias y buen descanso!'
          )
          return NextResponse.json({ status: 'saved' })
        }
      }

      // Procesar nuevo borrador
      const interpretacion = interpretarReporteTexto(texto)

      await supabase.from('trabajadores').update({
        estado_conversacion: 'esperando_confirmacion',
        borrador_reporte: interpretacion
      }).eq('id', trabajador.id)

      await enviarWhatsApp(
        from,
        `📋 Entendido. Resumen de tu reporte:\n\n${interpretacion.resumen}\n\n⚠️ Recuerda adjuntar la foto de evidencia si no la has enviado.\n\n¿Los datos son correctos? Responde *SÍ* para registrar o escribe el dato a corregir.`
      )
      return NextResponse.json({ status: 'draft_created' })
    }

    return NextResponse.json({ status: 'ok' })
  } catch (err: any) {
    console.error('Error procesando webhook:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

function interpretarReporteTexto(t: string) {
  const tl = t.toLowerCase()

  if (tl.includes('lluvia') || tl.includes('llovió') || tl.includes('stand by') || tl.includes('standby') || tl.includes('paralizado')) {
    return {
      tipo: 'standby',
      resumen: `• Estado: STAND-BY / JORNADA SUSPENDIDA\n• Motivo: Clima adverso o lluvias\n• Detalle: "${t}"`
    }
  }

  if (tl.includes('sold') || tl.includes('motor') || tl.includes('torno') || tl.includes('agua') || tl.includes('instal')) {
    return {
      tipo: 'mantenimiento_instalacion',
      resumen: `• Actividad: LOGÍSTICA / MANTENIMIENTO\n• Detalle reportado: "${t}"`
    }
  }

  if (tl.includes('spt') || tl.includes('nq') || tl.includes('shelby') || tl.includes('sondeo')) {
    const sondeoMatch = t.match(/s-?\s*(\d+)/i)
    const sptMatch = t.match(/(\d+)\s*(spt|ensayos?)/i)
    const cotaMatch = t.match(/(\d+[.,]?\d*)\s*(m|metros)/i)

    return {
      tipo: 'estudio_suelo',
      sondeo: sondeoMatch ? `S-${sondeoMatch[1]}` : 'S-01',
      ensayos_spt: sptMatch ? parseInt(sptMatch[1]) : 1,
      metros_nq: cotaMatch ? parseFloat(cotaMatch[1].replace(',', '.')) : 0,
      resumen: `• Tipo: EXPLORACIÓN GEOTÉCNICA\n• Sondeo: ${sondeoMatch ? `S-${sondeoMatch[1]}` : 'General'}\n• Metros / Cota: ${cotaMatch ? cotaMatch[1] + ' m' : 'No especificado'}\n• Ensayos: ${sptMatch ? sptMatch[1] + ' SPT' : 'SPT/Muestreo'}\n• Observación: "${t}"`
    }
  }

  const piloteMatch = t.match(/p-?\s*(\d+)/i)
  const pqMatch = t.match(/(\d+[.,]?\d*)\s*(m|metros)?\s*(en\s*pq|pq)/i)
  const ensancheMatch = t.match(/(\d+[.,]?\d*)\s*(m|metros)?\s*(de\s*ensanche|ensanche|ensanch)/i)
  const encamisadoMatch = t.match(/(\d+[.,]?\d*)\s*(m|metros)?\s*(de\s*encamisado|encamis|camisa)/i)

  return {
    tipo: 'pilote',
    pilote: piloteMatch ? `P-${piloteMatch[1]}` : 'P-01',
    avance_pq: pqMatch ? parseFloat(pqMatch[1].replace(',', '.')) : 0,
    ensanche: ensancheMatch ? parseFloat(ensancheMatch[1].replace(',', '.')) : 0,
    encamisado: encamisadoMatch ? parseFloat(encamisadoMatch[1].replace(',', '.')) : 0,
    resumen: `• Tipo: PILOTAJE\n• Pilote: ${piloteMatch ? `P-${piloteMatch[1]}` : 'P-01'}\n• Preperforación PQ: ${pqMatch ? pqMatch[1] + ' m' : '0 m'}\n• Ensanche: ${ensancheMatch ? ensancheMatch[1] + ' m' : '0 m'}\n• Encamisado: ${encamisadoMatch ? encamisadoMatch[1] + ' m' : '0 m'}`
  }
}

async function enviarWhatsApp(to: string, text: string) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.error('[ERROR CRÍTICO] Faltan variables WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_ID en Vercel.')
    return
  }

  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`
  const res = await fetch(url, {
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

  const resData = await res.json()
  if (!res.ok) {
    console.error(`[ERROR META GRAPH API al enviar a ${to}]:`, JSON.stringify(resData))
  } else {
    console.log(`[WHATSAPP ENVIADO EXITOSAMENTE a ${to}]:`, resData.messages?.[0]?.id)
  }
}
