import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const horaBogota = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }))
    const hoyStr = horaBogota.toISOString().split('T')[0]
    const fechaLimpia = horaBogota.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' })

    const { data: reportes } = await supabase.from('reportes_operativos').select('*').gte('created_at', `${hoyStr}T00:00:00`)
    const { data: trabajadores } = await supabase.from('trabajadores').select('*, proyectos(nombre)').eq('activo', true).not('proyecto_id', 'is', null)

    if (!reportes || !trabajadores) return NextResponse.json({ status: 'no_data' })

    // 1. Agrupar por Obra
    const obras: Record<string, any[]> = {}
    reportes.forEach(r => {
      if (!obras[r.proyecto_nombre]) obras[r.proyecto_nombre] = []
      obras[r.proyecto_nombre].push(r)
    })

    // 2. Formatear Texto
    let msj = `*📊 REPORTE CONSOLIDADO DE OBRA*\n📅 ${fechaLimpia}\n\n`

    for (const [obra, reps] of Object.entries(obras)) {
      msj += `*🏗️ FRENTE: ${obra.toUpperCase()}*\n`
      reps.forEach(r => {
        const puntoInfo = (r.pilote || r.sondeo) ? `(${r.pilote || r.sondeo})` : ''
        msj += `👤 *${r.trabajador_nombre}* ${puntoInfo}\n`
        
        let avanceTexto = ''
        if (r.tipo_operacion === 'logistica' || r.tipo_operacion === 'standby') {
          avanceTexto = `0 metros (Logística/Standby)`
        } else if (r.tipo_operacion === 'estudio_suelo') {
          avanceTexto = `NQ: ${r.metros_nq}m | SPT: ${r.ensayos_spt}`
        } else {
          avanceTexto = `PQ: ${r.avance_pq}m | Ens: ${r.ensanche}m | Camisa: ${r.encamisado}m`
        }
        
        msj += `📏 *Avance:* ${avanceTexto}\n`
        msj += `📝 *Detalle:* ${r.observaciones}\n\n`
      })
    }

    // 3. Faltantes
    const reportadosIds = new Set(reportes.map(r => r.trabajador_id))
    const faltantes = trabajadores.filter(t => !reportadosIds.has(t.id))
    
    if (faltantes.length > 0) {
      msj += `*⚠️ PENDIENTES POR REPORTAR HOY:*\n`
      faltantes.forEach(f => {
        msj += `- ${f.nombre} (${f.proyectos?.nombre || 'Sin obra'})\n`
      })
    } else {
      msj += `*✅ Todo el personal activo reportó hoy.*`
    }

    // 4. Enviar a Jefatura
    const token = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim()
    const numerosJefatura = ['573103953485', '573219641803'] // Añade o modifica los números aquí

    for (const num of numerosJefatura) {
      await fetch('https://graph.facebook.com/v19.0/1370874296109664/messages', {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: num, type: 'text', text: { body: msj } })
      })
    }

    return NextResponse.json({ status: 'consolidado_sent', recipients: numerosJefatura.length })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
