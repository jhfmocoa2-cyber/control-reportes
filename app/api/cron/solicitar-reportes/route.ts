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
      return NextResponse.json({ status: 'no_workers' })
    }

    const diagnostico: any[] = []

    for (const t of trabajadores) {
      const cleanTo = t.telefono.replace(/\D/g, '')
      const recipient = cleanTo.startsWith('57') ? cleanTo : `57${cleanTo}`

      // Intento directo con la plantilla
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
            name: 'bienvenida_operativa',
            language: { code: 'es' }
          }
        })
      })

      const data = await res.json()
      diagnostico.push({
        operador: t.nombre,
        telefono: recipient,
        http_status: res.status,
        meta_response: data
      })
    }

    return NextResponse.json({ diagnostico })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
