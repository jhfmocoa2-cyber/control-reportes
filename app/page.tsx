'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

interface Proyecto {
  id: string
  nombre: string
  fecha_inicio: string
  fecha_fin: string | null
  activo: boolean
}

interface Trabajador {
  id: string
  nombre: string
  telefono: string
  proyecto_id: string | null
  jornada: 'L-V' | 'L-S'
  activo: boolean
  proyectos?: { nombre: string }
}

export default function ConsolaAdmin() {
  const [proyectos, setProyectos] = useState<Proyecto[]>([])
  const [trabajadores, setTrabajadores] = useState<Trabajador[]>([])
  const [cargando, setCargando] = useState(true)

  // Estados formulario Proyecto
  const [nombreProyecto, setNombreProyecto] = useState('')
  const [fechaInicio, setFechaInicio] = useState(new Date().toISOString().split('T')[0])
  const [fechaFin, setFechaFin] = useState('')

  // Estados formulario Trabajador
  const [nombreTrabajador, setNombreTrabajador] = useState('')
  const [telefonoTrabajador, setTelefonoTrabajador] = useState('')
  const [proyectoSeleccionado, setProyectoSeleccionado] = useState('')
  const [jornadaTrabajador, setJornadaTrabajador] = useState<'L-V' | 'L-S'>('L-V')

  useEffect(() => {
    cargarDatos()
  }, [])

  async function cargarDatos() {
    setCargando(true)
    const { data: proys } = await supabase.from('proyectos').select('*').order('created_at', { ascending: false })
    const { data: trabs } = await supabase.from('trabajadores').select('*, proyectos(nombre)').order('created_at', { ascending: false })

    if (proys) setProyectos(proys)
    if (trabs) setTrabajadores(trabs as any)
    setCargando(false)
  }

  async function crearProyecto(e: React.FormEvent) {
    e.preventDefault()
    if (!nombreProyecto) return

    await supabase.from('proyectos').insert({
      nombre: nombreProyecto,
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin || null,
      activo: true
    })

    setNombreProyecto('')
    setFechaFin('')
    cargarDatos()
  }

  async function toggleProyecto(id: string, activoActual: boolean) {
    await supabase.from('proyectos').update({ activo: !activoActual }).eq('id', id)
    cargarDatos()
  }

  async function crearTrabajador(e: React.FormEvent) {
    e.preventDefault()
    if (!nombreTrabajador || !telefonoTrabajador) return

    // Limpiar número: quitar espacios y signos +
    const cleanPhone = telefonoTrabajador.replace(/\D/g, '')

    await supabase.from('trabajadores').insert({
      nombre: nombreTrabajador,
      telefono: cleanPhone,
      proyecto_id: proyectoSeleccionado || null,
      jornada: jornadaTrabajador,
      activo: true
    })

    setNombreTrabajador('')
    setTelefonoTrabajador('')
    cargarDatos()
  }

  async function toggleTrabajador(id: string, activoActual: boolean) {
    await supabase.from('trabajadores').update({ activo: !activoActual }).eq('id', id)
    cargarDatos()
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10 font-sans">
      <header className="max-w-6xl mx-auto mb-10 pb-6 border-b border-slate-800">
        <h1 className="text-3xl font-bold tracking-tight">Panel de Control: Reportes Operativos</h1>
        <p className="text-slate-400 mt-1">Administra proyectos, personal asignado y regímenes de jornada.</p>
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* SECCIÓN PROYECTOS */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-4 text-emerald-400">1. Gestión de Proyectos</h2>
          
          <form onSubmit={crearProyecto} className="space-y-4 mb-6 bg-slate-800/50 p-4 rounded-lg">
            <div>
              <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1">Nombre del Proyecto</label>
              <input
                type="text"
                placeholder="Ej. Sondeos Fase 2 Mocoa"
                value={nombreProyecto}
                onChange={e => setNombreProyecto(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1">Fecha Inicio</label>
                <input
                  type="date"
                  value={fechaInicio}
                  onChange={e => setFechaInicio(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1">Fecha Fin (Opcional)</label>
                <input
                  type="date"
                  value={fechaFin}
                  onChange={e => setFechaFin(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none"
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2 rounded-md transition text-sm"
            >
              Registrar Proyecto
            </button>
          </form>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Proyectos Existentes</h3>
            {proyectos.length === 0 ? (
              <p className="text-sm text-slate-500">No hay proyectos registrados aún.</p>
            ) : (
              proyectos.map(p => (
                <div key={p.id} className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-lg">
                  <div>
                    <p className="font-medium text-white">{p.nombre}</p>
                    <p className="text-xs text-slate-500">{p.fecha_inicio} {p.fecha_fin ? `al ${p.fecha_fin}` : '(Indefinido)'}</p>
                  </div>
                  <button
                    onClick={() => toggleProyecto(p.id, p.activo)}
                    className={`text-xs px-3 py-1 rounded-full font-medium transition ${
                      p.activo ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-red-950 text-red-400 border border-red-800'
                    }`}
                  >
                    {p.activo ? 'Activo' : 'Cerrado'}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        {/* SECCIÓN TRABAJADORES */}
        <section className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-4 text-sky-400">2. Trabajadores y Reglas de Envío</h2>

          <form onSubmit={crearTrabajador} className="space-y-4 mb-6 bg-slate-800/50 p-4 rounded-lg">
            <div>
              <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1">Nombre Completo</label>
              <input
                type="text"
                placeholder="Ej. Juan Pérez"
                value={nombreTrabajador}
                onChange={e => setNombreTrabajador(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                required
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1">WhatsApp (con código país)</label>
              <input
                type="text"
                placeholder="Ej. 573001234567"
                value={telefonoTrabajador}
                onChange={e => setTelefonoTrabajador(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1">Proyecto Asignado</label>
                <select
                  value={proyectoSeleccionado}
                  onChange={e => setProyectoSeleccionado(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none"
                >
                  <option value="">Sin asignar</option>
                  {proyectos.filter(p => p.activo).map(p => (
                    <option key={p.id} value={p.id}>{p.nombre}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1">Jornada</label>
                <select
                  value={jornadaTrabajador}
                  onChange={e => setJornadaTrabajador(e.target.value as 'L-V' | 'L-S')}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none"
                >
                  <option value="L-V">Lunes a Viernes</option>
                  <option value="L-S">Lunes a Sábado</option>
                </select>
              </div>
            </div>
            <button
              type="submit"
              className="w-full bg-sky-600 hover:bg-sky-500 text-white font-medium py-2 rounded-md transition text-sm"
            >
              Registrar Trabajador
            </button>
          </form>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Directorio Activo</h3>
            {trabajadores.length === 0 ? (
              <p className="text-sm text-slate-500">No hay trabajadores agregados.</p>
            ) : (
              trabajadores.map(t => (
                <div key={t.id} className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-lg">
                  <div>
                    <p className="font-medium text-white">{t.nombre}</p>
                    <p className="text-xs text-slate-500">
                      +{t.telefono} | {t.proyectos?.nombre || 'Sin proyecto'} | <span className="text-sky-400">{t.jornada}</span>
                    </p>
                  </div>
                  <button
                    onClick={() => toggleTrabajador(t.id, t.activo)}
                    className={`text-xs px-3 py-1 rounded-full font-medium transition ${
                      t.activo ? 'bg-sky-950 text-sky-400 border border-sky-800' : 'bg-slate-800 text-slate-400 border border-slate-700'
                    }`}
                  >
                    {t.activo ? 'Activo' : 'En pausa'}
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
