import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''

function obtenerInicioDiaColombiaUTC(): string {
  // Calcula las 00:00:00 de hoy en hora de Colombia (UTC-5) expresado en ISO UTC
  const ahora = new Date()
  const bogotaStr = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }) // YYYY-MM-DD
  return `${bogotaStr}T05:00:00.000Z`
}

export async function GET() {
  try {
    const { data: trabajadores } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .eq('activo', true)

    if (!trabajadores || trabajadores.length === 0) {
      return NextResponse.json({ status: 'no_active_workers', enviados: 0, errores: [] })
    }

    const inicioDiaColombia = obtenerInicioDiaColombiaUTC()
    let enviados = 0
    const errores: string[] = []

    for (const t of trabajadores) {
      const { data: reporteHoy } = await supabase
        .from('reportes_operativos')
        .select('id')
        .eq('trabajador_id', t.id)
        .gte('created_at', inicioDiaColombia)
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
            `1. Cuéntanos en qué sondeo o punto trabajaron y cuántos metros avanzaron.\n` +
            `2. Si hubo lluvia, trasteo, armado o falla mecánica, descríbela por escrito.\n` +
            `3. Envía la foto de la planilla, muestras o testigo.\n` +
            `⚠️ *Nota:* Este sistema automatizado *no procesa audios*. Por favor envía siempre tu reporte en mensaje escrito.\n\n` +
            `¿Cómo les fue hoy en el turno? Cuéntanos el reporte de la jornada.`
        } else {
          mensaje = 
            `👋 *Buenas tardes, ${t.nombre}.*\n\n` +
            `¿Cómo les fue hoy en *${frente}*? Cuéntanos qué avance tuvieron o qué actividad realizaron en la jornada y recuerda enviar las fotos de soporte.`
        }

        const resultado = await enviarWhatsAppConVerificacion(t.telefono, mensaje)

        if (resultado.ok) {
          await supabase.from('trabajadores').update({
            bienvenida_enviada: true,
            estado_conversacion: 'esperando_reporte_diario'
          }).eq('id', t.id)
          enviados++
        } else {
          errores.push(`${t.nombre} (+${t.telefono}): ${resultado.error}`)
        }
      }
    }

    return NextResponse.json({
      status: 'reminders_sent',
      count: enviados,
      errores
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function enviarWhatsAppConVerificacion(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    return { ok: false, error: 'Faltan credenciales de WhatsApp en Vercel' }
  }
  const cleanTo = to.replace(/\D/g, '')
  const recipient = cleanTo.startsWith('57') ? cleanTo : `57${cleanTo}`

  const res = await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
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

  const data = await res.json()
  if (!res.ok || data.error) {
    return { ok: false, error: data.error?.message || 'Error desconocido de Meta' }
  }
  return { ok: true }
}
