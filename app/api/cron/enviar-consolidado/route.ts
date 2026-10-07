import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID || ''
const ADMIN_PHONES = process.env.ADMIN_PHONES || '573103953485,573125211170'

export async function GET() {
  try {
    const { data: trabajadores } = await supabase
      .from('trabajadores')
      .select('*, proyectos(nombre)')
      .eq('activo', true)
      .order('nombre', { ascending: true })

    const hoyStr = new Date().toISOString().split('T')[0]
    const { data: reportesHoy } = await supabase
      .from('reportes_operativos')
      .select('*')
      .gte('created_at', `${hoyStr}T00:00:00.000Z`)
      .order('created_at', { ascending: false })

    const { data: cfg } = await supabase
      .from('sistema_config')
      .select('valor')
      .eq('clave', 'bienvenida_admin_enviada')
      .single()

    const esPrimeraVez = !cfg || cfg.valor !== 'true'
    const fechaFormateada = new Date().toLocaleDateString('es-CO', { dateStyle: 'long' })
    let texto = ''

    if (esPrimeraVez) {
      texto += 
        `👷‍♂️ *Buenas noches, Don Jaime y Miguel.*\n` +
        `Le saluda el Sistema de Control Operativo de *JHF Perforaciones S.A.S.*\n\n` +
        `A partir de hoy, este canal consolidará diariamente las bitácoras técnicas de todos los frentes activos (estudios de suelos, sondeos, pilotaje y novedades en obra) de forma automática.\n\n` +
        `A continuación, el consolidado de la jornada de hoy:\n\n`
    }

    texto += `📊 *JHF PERFORACIONES - CONSOLIDADO DIARIO*\n📅 *Fecha:* ${fechaFormateada}\n\n`

    trabajadores?.forEach((t, i) => {
      const rep = reportesHoy?.find(r => r.trabajador_id === t.id)
      const frente = t.proyectos?.nombre || 'General'

      texto += `${i + 1}️⃣ *${t.nombre}* (${frente}):\n`

      if (rep) {
        if (rep.tipo_operacion === 'estudio_suelo') {
          const sptTxt = rep.ensayos_spt ? ` | ${rep.ensayos_spt} SPT` : ''
          texto += `   • *Sondeo ${rep.sondeo || 'S-01'}:* Avance ${rep.metros_nq || 0} m${sptTxt}\n`
          if (rep.observaciones) texto += `   • *Nota:* ${rep.observaciones}\n`
        } else if (rep.tipo_operacion === 'pilote') {
          texto += `   • *Pilote ${rep.pilote || 'P-01'}:* PQ ${rep.avance_pq}m | Ensanche ${rep.ensanche}m | Camisa ${rep.encamisado}m\n`
        } else {
          texto += `   • *Novedad / Actividad:* ${rep.observaciones}\n`
        }
      } else {
        texto += `   • ⚠️ *Sin reporte registrado en la jornada*\n`
      }
      texto += `\n`
    })

    const telefonos = ADMIN_PHONES.split(',').map(p => p.trim()).filter(Boolean)
    for (const tel of telefonos) {
      await enviarWhatsApp(tel, texto)
    }

    if (esPrimeraVez) {
      await supabase.from('sistema_config').upsert({ clave: 'bienvenida_admin_enviada', valor: 'true' })
    }

    return NextResponse.json({ status: 'consolidated_report_sent', recipients: telefonos.length })
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
