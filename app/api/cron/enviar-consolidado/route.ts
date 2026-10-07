import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''
// Por defecto en pruebas solo envía a Miguel (573103953485)
const ADMIN_PHONES = process.env.ADMIN_PHONES || '573103953485'

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
      .order('nombre', { ascending: true })

    const inicioDiaColombia = obtenerInicioDiaColombiaUTC()
    const { data: reportesHoy } = await supabase
      .from('reportes_operativos')
      .select('*')
      .gte('created_at', inicioDiaColombia)
      .order('created_at', { ascending: false })

    const fechaFormateada = new Date().toLocaleDateString('es-CO', {
      timeZone: 'America/Bogota',
      dateStyle: 'long'
    })

    let texto = `📊 *JHF PERFORACIONES - CONSOLIDADO DIARIO*\n📅 *Fecha:* ${fechaFormateada}\n\n`

    trabajadores?.forEach((t, i) => {
      const rep = reportesHoy?.find(r => r.trabajador_id === t.id)
      const frente = t.proyectos?.nombre || 'General'

      texto += `${i + 1}️⃣ *${t.nombre}* (${frente}):\n`

      if (rep) {
        if (rep.tipo_operacion === 'estudio_suelo') {
          const sptTxt = rep.ensayos_spt ? ` | ${rep.ensayos_spt} SPT` : ''
          texto += `   • *Sondeo ${rep.sondeo || 'S-01'}:* Avance ${rep.metros_nq || 0} m${sptTxt}\n`
          if (rep.observaciones) texto += `   • *Detalle:* ${rep.observaciones}\n`
        } else if (rep.tipo_operacion === 'pilote') {
          texto += `   • *Pilote ${rep.pilote || 'P-01'}:* PQ ${rep.avance_pq}m | Ensanche ${rep.ensanche}m | Camisa ${rep.encamisado}m\n`
          if (rep.observaciones) texto += `   • *Detalle:* ${rep.observaciones}\n`
        } else {
          texto += `   • *Novedad / Actividad:* ${rep.observaciones}\n`
        }
      } else {
        texto += `   • ⚠️ *Sin reporte registrado en la jornada*\n`
      }
      texto += `\n`
    })

    const telefonos = ADMIN_PHONES.split(',').map(p => p.trim()).filter(Boolean)
    let enviados = 0

    for (const tel of telefonos) {
      const ok = await enviarWhatsApp(tel, texto)
      if (ok) enviados++
    }

    return NextResponse.json({ status: 'consolidated_report_sent', recipients: enviados })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

async function enviarWhatsApp(to: string, text: string): Promise<boolean> {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return false
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
  return res.ok
}
