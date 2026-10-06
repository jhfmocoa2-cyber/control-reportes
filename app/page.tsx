'use client'

export const dynamic = 'force-dynamic'

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

interface Reporte {
  id: string
  created_at: string
  trabajador_nombre: string
  proyecto_nombre: string
  pilote: string
  avance_pq: number
  ensanche: number
  encamisado: number
  observaciones: string
  confirmado: boolean
}

export default function ConsolaAdmin() {
  const [tab, setTab] = useState<'config' | 'reportes'>('config')
  const [proyectos, setProyectos] = useState<Proyecto[]>([])
  const [trabajadores, setTrabajadores] = useState<Trabajador[]>([])
  const [reportes, setReportes] = useState<Reporte[]>([])
  
  // Form proyecto
  const [editingProyectoId, setEditingProyectoId] = useState<string | null>(null)
  const [nombreProyecto, setNombreProyecto] = useState('')
  const [fechaInicio, setFechaInicio] = useState(new Date().toISOString().split('T')[0])
  const [fechaFin, setFechaFin] = useState('')

  // Form trabajador
  const [editingTrabajadorId, setEditingTrabajadorId] = useState<string | null>(null)
  const [nombreTrabajador, setNombreTrabajador] = useState('')
  const [telefonoTrabajador, setTelefonoTrabajador] = useState('')
  const [proyectoSeleccionado, setProyectoSeleccionado] = useState('')
  const [jornadaTrabajador, setJornadaTrabajador] = useState<'L-V' | 'L-S'>('L-V')

  useEffect(() => {
    cargarDatos()
  }, [])

  async function cargarDatos() {
    const { data: proys } = await supabase.from('proyectos').select('*').order('created_at', { ascending: false })
    const { data: trabs } = await supabase.from('trabajadores').select('*, proyectos(nombre)').order('created_at', { ascending: false })
    const { data: reps } = await supabase.from('reportes_operativos').select('*').order('created_at', { ascending: false })

    if (proys) setProyectos(proys)
    if (trabs) setTrabajadores(trabs as any)
    if (reps) setReportes(reps)
  }

  async function guardarProyecto(e: React.FormEvent) {
    e.preventDefault()
    if (!nombreProyecto) return

    if (editingProyectoId) {
      await supabase.from('proyectos').update({
        nombre: nombreProyecto,
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin || null
      }).eq('id', editingProyectoId)
      setEditingProyectoId(null)
    } else {
      await supabase.from('proyectos').insert({
        nombre: nombreProyecto,
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin || null,
        activo: true
      })
    }

    setNombreProyecto('')
    setFechaFin('')
    cargarDatos()
  }

  function prepararEdicionProyecto(p: Proyecto) {
    setEditingProyectoId(p.id)
    setNombreProyecto(p.nombre)
    setFechaInicio(p.fecha_inicio)
    setFechaFin(p.fecha_fin || '')
  }

  async function eliminarProyecto(id: string) {
    if (!confirm('¿Deseas eliminar este proyecto? Los reportes asociados podrían quedar sin referencia.')) return
    await supabase.from('proyectos').delete().eq('id', id)
    cargarDatos()
  }

  async function guardarTrabajador(e: React.FormEvent) {
    e.preventDefault()
    if (!nombreTrabajador || !telefonoTrabajador) return

    const cleanPhone = telefonoTrabajador.replace(/\D/g, '')

    if (editingTrabajadorId) {
      await supabase.from('trabajadores').update({
        nombre: nombreTrabajador,
        telefono: cleanPhone,
        proyecto_id: proyectoSeleccionado || null,
        jornada: jornadaTrabajador
      }).eq('id', editingTrabajadorId)
      setEditingTrabajadorId(null)
    } else {
      await supabase.from('trabajadores').insert({
        nombre: nombreTrabajador,
        telefono: cleanPhone,
        proyecto_id: proyectoSeleccionado || null,
        jornada: jornadaTrabajador,
        activo: true
      })
    }

    setNombreTrabajador('')
    setTelefonoTrabajador('')
    setProyectoSeleccionado('')
    cargarDatos()
  }

  function prepararEdicionTrabajador(t: Trabajador) {
    setEditingTrabajadorId(t.id)
    setNombreTrabajador(t.nombre)
    setTelefonoTrabajador(t.telefono)
    setProyectoSeleccionado(t.proyecto_id || '')
    setJornadaTrabajador(t.jornada)
  }

  async function eliminarTrabajador(id: string) {
    if (!confirm('¿Eliminar trabajador del directorio?')) return
    await supabase.from('trabajadores').delete().eq('id', id)
    cargarDatos()
  }

  function exportarCSV() {
    if (reportes.length === 0) return alert('No hay reportes para exportar')
    const cabecera = 'Fecha,Proyecto,Trabajador,Pilote,Metros PQ,Ensanche,Encamisado,Observaciones\n'
    const filas = reportes.map(r => 
      `"${r.created_at.slice(0,10)}","${r.proyecto_nombre}","${r.trabajador_nombre}","${r.pilote}",${r.avance_pq},${r.ensanche},${r.encamisado},"${r.observaciones || ''}"`
    ).join('\n')

    const blob = new Blob([cabecera + filas], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `reportes_perforacion_${new Date().toISOString().split('T')[0]}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10 font-sans">
      <header className="max-w-6xl mx-auto mb-8 pb-6 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Control Operativo de Frentes</h1>
          <p className="text-slate-400 mt-1">Supervisión de perforación, pilotes y recopilación por WhatsApp.</p>
        </div>
        <div className="flex gap-2 bg-slate-900 p-1 border border-slate-800 rounded-lg">
          <button
            onClick={() => setTab('config')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              tab === 'config' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Frentes y Personal
          </button>
          <button
            onClick={() => setTab('reportes')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition ${
              tab === 'reportes' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            Bitácora de Reportes
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto">
        {tab === 'config' ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* PROYECTOS */}
            <section className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold text-emerald-400">Proyectos y Obras</h2>
                {editingProyectoId && (
                  <button onClick={() => { setEditingProyectoId(null); setNombreProyecto(''); }} className="text-xs text-slate-400 underline">
                    Cancelar edición
                  </button>
                )}
              </div>
              
              <form onSubmit={guardarProyecto} className="space-y-4 mb-6 bg-slate-800/50 p-4 rounded-lg">
                <input
                  type="text"
                  placeholder="Nombre de la obra (Ej. Pilotes Medellín)"
                  value={nombreProyecto}
                  onChange={e => setNombreProyecto(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white"
                  required
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="date"
                    value={fechaInicio}
                    onChange={e => setFechaInicio(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white"
                    required
                  />
                  <input
                    type="date"
                    placeholder="Fecha fin"
                    value={fechaFin}
                    onChange={e => setFechaFin(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white"
                  />
                </div>
                <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2 rounded-md text-sm font-medium transition">
                  {editingProyectoId ? 'Guardar Cambios' : 'Registrar Proyecto'}
                </button>
              </form>

              <div className="space-y-3">
                {proyectos.map(p => (
                  <div key={p.id} className="p-3 bg-slate-950 border border-slate-800 rounded-lg flex justify-between items-center">
                    <div>
                      <p className="font-medium text-white">{p.nombre}</p>
                      <p className="text-xs text-slate-500">{p.fecha_inicio} {p.fecha_fin ? `al ${p.fecha_fin}` : '(En curso)'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => prepararEdicionProyecto(p)} className="text-xs text-slate-400 hover:text-white px-2 py-1">
                        Editar
                      </button>
                      <button
                        onClick={async () => {
                          await supabase.from('proyectos').update({ activo: !p.activo }).eq('id', p.id)
                          cargarDatos()
                        }}
                        className={`text-xs px-2.5 py-1 rounded-md font-medium ${
                          p.activo ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-red-950 text-red-400 border border-red-800'
                        }`}
                      >
                        {p.activo ? 'Activo' : 'Cerrado'}
                      </button>
                      <button onClick={() => eliminarProyecto(p.id)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1">
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* TRABAJADORES */}
            <section className="bg-slate-900 border border-slate-800 rounded-xl p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-semibold text-sky-400">Perforadores y Operadores</h2>
                {editingTrabajadorId && (
                  <button onClick={() => { setEditingTrabajadorId(null); setNombreTrabajador(''); setTelefonoTrabajador(''); }} className="text-xs text-slate-400 underline">
                    Cancelar edición
                  </button>
                )}
              </div>

              <form onSubmit={guardarTrabajador} className="space-y-4 mb-6 bg-slate-800/50 p-4 rounded-lg">
                <input
                  type="text"
                  placeholder="Nombre completo"
                  value={nombreTrabajador}
                  onChange={e => setNombreTrabajador(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white"
                  required
                />
                <input
                  type="text"
                  placeholder="WhatsApp (con país, ej: 573103953485)"
                  value={telefonoTrabajador}
                  onChange={e => setTelefonoTrabajador(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white"
                  required
                />
                <div className="grid grid-cols-2 gap-3">
                  <select
                    value={proyectoSeleccionado}
                    onChange={e => setProyectoSeleccionado(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white"
                  >
                    <option value="">Sin asignar</option>
                    {proyectos.filter(p => p.activo).map(p => (
                      <option key={p.id} value={p.id}>{p.nombre}</option>
                    ))}
                  </select>
                  <select
                    value={jornadaTrabajador}
                    onChange={e => setJornadaTrabajador(e.target.value as any)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white"
                  >
                    <option value="L-V">Lunes a Viernes</option>
                    <option value="L-S">Lunes a Sábado</option>
                  </select>
                </div>
                <button type="submit" className="w-full bg-sky-600 hover:bg-sky-500 text-white py-2 rounded-md text-sm font-medium transition">
                  {editingTrabajadorId ? 'Guardar Cambios' : 'Registrar Perforador'}
                </button>
              </form>

              <div className="space-y-3">
                {trabajadores.map(t => (
                  <div key={t.id} className="p-3 bg-slate-950 border border-slate-800 rounded-lg flex justify-between items-center">
                    <div>
                      <p className="font-medium text-white">{t.nombre}</p>
                      <p className="text-xs text-slate-500">+{t.telefono} | {t.proyectos?.nombre || 'Sin obra'} | <span className="text-sky-400">{t.jornada}</span></p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => prepararEdicionTrabajador(t)} className="text-xs text-slate-400 hover:text-white px-2 py-1">
                        Editar
                      </button>
                      <button
                        onClick={async () => {
                          await supabase.from('trabajadores').update({ activo: !t.activo }).eq('id', t.id)
                          cargarDatos()
                        }}
                        className={`text-xs px-2.5 py-1 rounded-md font-medium ${
                          t.activo ? 'bg-sky-950 text-sky-400 border border-sky-800' : 'bg-slate-800 text-slate-400 border border-slate-700'
                        }`}
                      >
                        {t.activo ? 'Activo' : 'Pausa'}
                      </button>
                      <button onClick={() => eliminarTrabajador(t.id)} className="text-xs text-red-400 hover:text-red-300 px-2 py-1">
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : (
          /* BITÁCORA DE REPORTES */
          <section className="bg-slate-900 border border-slate-800 rounded-xl p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
              <div>
                <h2 className="text-xl font-semibold text-white">Historial de Reportes Diarios</h2>
                <p className="text-xs text-slate-400 mt-0.5">Avances de PQ, ensanches y encamisados procesados.</p>
              </div>
              <button
                onClick={exportarCSV}
                className="bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-2 rounded-md text-xs font-semibold uppercase tracking-wider transition self-start sm:self-auto"
              >
                Descargar Excel (CSV)
              </button>
            </div>

            {reportes.length === 0 ? (
              <div className="text-center py-12 border border-dashed border-slate-800 rounded-lg text-slate-500 text-sm">
                Aún no hay reportes recibidos hoy. Los reportes validados por WhatsApp aparecerán aquí automáticamente.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="bg-slate-950 text-xs uppercase text-slate-400 border-b border-slate-800">
                    <tr>
                      <th className="p-3">Fecha</th>
                      <th className="p-3">Frente / Obra</th>
                      <th className="p-3">Perforador</th>
                      <th className="p-3">Pilote</th>
                      <th className="p-3">Avance PQ</th>
                      <th className="p-3">Ensanche</th>
                      <th className="p-3">Encamisado</th>
                      <th className="p-3">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {reportes.map(r => (
                      <tr key={r.id} className="hover:bg-slate-800/40">
                        <td className="p-3 text-xs">{r.created_at.slice(0, 10)}</td>
                        <td className="p-3 font-medium text-white">{r.proyecto_nombre}</td>
                        <td className="p-3">{r.trabajador_nombre}</td>
                        <td className="p-3 text-sky-400 font-semibold">{r.pilote}</td>
                        <td className="p-3">{r.avance_pq} m</td>
                        <td className="p-3">{r.ensanche} m</td>
                        <td className="p-3">{r.encamisado} m</td>
                        <td className="p-3">
                          <span className="text-xs px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                            Validado
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  )
}
