import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      // return new Response('Unauthorized', { status: 401 }) // Descomentar en producción estricta
    }

    const horaBogota = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Bogota" }))
    const hoyStr = horaBogota.toISOString().split('T')[0]
    
    // 1. Obtener personal activo
    const { data: trabajadores } = await supabase.from('trabajadores').select('*').eq('activo', true).not('proyecto_id', 'is', null)
    if (!trabajadores) return NextResponse.json({ status: 'no_workers' })

    // 2. Obtener reportes de hoy
    const { data: reportesHoy } = await supabase.from('reportes_operativos').select('trabajador_id').gte('created_at', `${hoyStr}T00:00:00`)
    const reportadosIds = new Set(reportesHoy?.map(r => r.trabajador_id) || [])

    // 3. Filtrar los que faltan
    const faltantes = trabajadores.filter(t => !reportadosIds.has(t.id))

    // 4. Enviar mensaje
    const token = (process.env.WHATSAPP_ACCESS_TOKEN || '').trim()
    for (const t of faltantes) {
      const msj = `🔔 ¡Hola ${t.nombre}! Pasaba a recordarte que aún no tenemos tu reporte de avance de hoy. Escríbeme cuando tengas un tiempito para dejar la bitácora al día.`
      await fetch('https://graph.facebook.com/v19.0/1370874296109664/messages', {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: `57${t.telefono}`, type: 'text', text: { body: msj } })
      })
      await supabase.from('trabajadores').update({ estado_conversacion: 'esperando_reporte' }).eq('id', t.id)
    }

    return NextResponse.json({ status: 'reminders_sent', count: faltantes.length })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
