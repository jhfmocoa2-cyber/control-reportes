import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''

function obtenerInicioDiaColombiaUTC(): string {
  const ahora = new Date()
  const bogotaStr = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })
  return `${bogotaStr}T05:00:00.000Z`
}

export async function GET() {
  try {
    const { data: trabajadores } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .eq('activo', true)

    if (!trabajadores || trabajadores.length === 0) {
      return NextResponse.json({ status: 'no_active_workers', count: 0, errores: [] })
    }

    const inicioDiaColombia = obtenerInicioDiaColombiaUTC()
    let enviados = 0
    const errores: string[] = []

    for (const t of trabajadores) {
      // Verificar si ya reportó hoy
      const { data: reporteHoy } = await supabase
        .from('reportes_operativos')
        .select('id')
        .eq('trabajador_id', t.id)
        .gte('created_at', inicioDiaColombia)
        .limit(1)

      if (!reporteHoy || reporteHoy.length === 0) {
        const frente = t.proyectos?.nombre || 'su frente asignado'
        
        // Enviar plantilla oficial aprobada por Meta (Abre la ventana proactivamente)
        const resultado = await enviarPlantillaWhatsApp(t.telefono, t.nombre, frente)

        if (resultado.ok) {
          await supabase.from('trabajadores').update({
            estado_conversacion: 'esperando_reporte_diario',
            bienvenida_enviada: true
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

async function enviarPlantillaWhatsApp(
  to: string,
  nombreOperador: string,
  frenteNombre: string
): Promise<{ ok: boolean; error?: string }> {
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
      type: 'template',
      template: {
        name: 'solicitud_reporte_diario',
        language: {
          code: 'es'
        },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: nombreOperador },
              { type: 'text', text: frenteNombre }
            ]
          }
        ]
      }
    })
  })

  const data = await res.json()
  if (!res.ok || data.error) {
    return { ok: false, error: data.error?.message || 'Error en plantilla Meta' }
  }
  return { ok: true }
}
