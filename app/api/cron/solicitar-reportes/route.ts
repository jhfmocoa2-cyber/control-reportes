import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''

export async function GET() {
  try {
    const { data: trabajadores } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .eq('activo', true)

    if (!trabajadores || trabajadores.length === 0) {
      return NextResponse.json({ status: 'no_active_workers' })
    }

    const hoyStr = new Date().toISOString().split('T')[0]
    let enviados = 0

    for (const t of trabajadores) {
      const { data: reporteHoy } = await supabase
        .from('reportes_operativos')
        .select('id')
        .eq('trabajador_id', t.id)
        .gte('created_at', `${hoyStr}T00:00:00.000Z`)
        .limit(1)

      if (!reporteHoy || reporteHoy.length === 0) {
        const frente = t.proyectos?.nombre || 'su frente asignado'
        let mensaje = ''

        if (!t.bienvenida_enviada) {
          mensaje = 
            `👋 *Hola, ${t.nombre}.*\n` +
            `Te saluda el Sistema de Control Operativo de *JHF Perforaciones S.A.S.*\n\n` +
            `A partir de hoy, este es el canal oficial para registrar tu reporte diario de actividades y avance de tu frente (*${frente}*).\n\n` +
            `⚙️ *Instrucciones clave:*\n` +
            `1. Escribe tu avance en texto (metros en PQ, ensanche, encamisado o tramo de sondeo).\n` +
            `2. Si hubo lluvia, parada o falla mecánica, descríbela por escrito.\n` +
            `3. Envía la foto de la planilla, muestras o testigo.\n` +
            `⚠️ *Nota:* Este sistema automatizado *no procesa audios*. Por favor envía siempre tu reporte en mensaje escrito.\n\n` +
            `¿Cómo les fue hoy en el turno? Cuéntanos el reporte de la jornada.`

          await supabase.from('trabajadores').update({ bienvenida_enviada: true }).eq('id', t.id)
        } else {
          mensaje = 
            `👋 *Buenas tardes, ${t.nombre}.*\n\n` +
            `¿Cuál fue el avance del día de hoy en *${frente}*? Por favor envíanos los metros o novedades y las fotos de soporte para consolidar la bitácora.`
        }

        await enviarWhatsApp(t.telefono, mensaje)
        await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte_diario' }).eq('id', t.id)
        enviados++
      }
    }

    return NextResponse.json({ status: 'reminders_sent', count: enviados })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function enviarWhatsApp(to: string, text: string) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return
  const cleanTo = to.replace(/\D/g, '')
  const recipient = cleanTo.startsWith('57') ? cleanTo : `57${cleanTo}`

  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { body: text }
    })
  })
}
