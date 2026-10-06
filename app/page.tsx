'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

interface Proyecto {
  id: string
  nombre: string
  ubicacion: string
}

interface Trabajador {
  id: string
  nombre: string
  telefono: string
  proyecto_id: string
  cargo: string
  activo: boolean
  jornada: string
  proyectos?: Proyecto
}

interface ReporteOperativo {
  id: string
  created_at: string
  trabajador_id: string
  trabajador_nombre: string
  proyecto_nombre: string
  tipo_operacion: string
  pilote?: string
  sondeo?: string
  avance_pq: number
  ensanche: number
  encamisado: number
  metros_nq: number
  ensayos_spt: number
  observaciones: string
  confirmado: boolean
}

export default function Home() {
  const [tab, setTab] = useState<'monitor' | 'bitacora' | 'configuracion'>('monitor')
  const [proyectos, setProyectos] = useState<Proyecto[]>([])
  const [trabajadores, setTrabajadores] = useState<Trabajador[]>([])
  const [reportes, setReportes] = useState<ReporteOperativo[]>([])
  const [cargando, setCargando] = useState(true)

  // Formulario nuevo trabajador
  const [nombre, setNombre] = useState('')
  const [telefono, setTelefono] = useState('')
  const [proyectoId, setProyectoId] = useState('')
  const [jornada, setJornada] = useState('L-S')
  const [cargo, setCargo] = useState('Perforador')

  // Formulario nuevo proyecto
  const [nombreProyecto, setNombreProyecto] = useState('')
  const [ubicacionProyecto, setUbicacionProyecto] = useState('')

  useEffect(() => {
    cargarDatos()
  }, [])

  async function cargarDatos() {
    setCargando(true)
    try {
      const { data: proys } = await supabase.from('proyectos').select('*').order('created_at', { ascending: false })
      const { data: trabs } = await supabase.from('trabajadores').select('*, proyectos(*)').order('nombre', { ascending: true })
      const { data: reps } = await supabase.from('reportes_operativos').select('*').order('created_at', { ascending: false })

      if (proys) setProyectos(proys)
      if (trabs) setTrabajadores(trabs)
      if (reps) setReportes(reps)
    } catch (err) {
      console.error('Error cargando datos:', err)
    } finally {
      setCargando(false)
    }
  }

  // Verifica si el trabajador ya reportó el día de hoy
  function haReportadoHoy(trabajadorId: string) {
    const hoyStr = new Date().toISOString().split('T')[0]
    return reportes.find(r => r.trabajador_id === trabajadorId && r.created_at.startsWith(hoyStr))
  }

  async function toggleActivoTrabajador(id: string, estadoActual: boolean) {
    await supabase.from('trabajadores').update({ activo: !estadoActual }).eq('id', id)
    cargarDatos()
  }

  async function crearTrabajador(e: React.FormEvent) {
    e.preventDefault()
    if (!nombre || !telefono || !proyectoId) return
    const telLimpio = telefono.replace(/\D/g, '')

    await supabase.from('trabajadores').insert({
      nombre,
      telefono: telLimpio,
      proyecto_id: proyectoId,
      cargo,
      jornada,
      activo: true,
      estado_conversacion: 'inactivo'
    })

    setNombre('')
    setTelefono('')
    cargarDatos()
  }

  async function crearProyecto(e: React.FormEvent) {
    e.preventDefault()
    if (!nombreProyecto) return

    await supabase.from('proyectos').insert({
      nombre: nombreProyecto,
      ubicacion: ubicacionProyecto || 'General'
    })

    setNombreProyecto('')
    setUbicacionProyecto('')
    cargarDatos()
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur px-6 py-4 flex flex-wrap justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 font-bold">
            JHF
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white">JHF Perforaciones S.A.S.</h1>
            <p className="text-xs text-slate-400">Control Operativo & Minuta Diaria</p>
          </div>
        </div>

        {/* Pestañas */}
        <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-1 text-xs font-medium">
          <button
            onClick={() => setTab('monitor')}
            className={`px-3 py-1.5 rounded-md transition ${tab === 'monitor' ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
          >
            📊 Monitor de Hoy
          </button>
          <button
            onClick={() => setTab('bitacora')}
            className={`px-3 py-1.5 rounded-md transition ${tab === 'bitacora' ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
          >
            📋 Bitácora de Reportes ({reportes.length})
          </button>
          <button
            onClick={() => setTab('configuracion')}
            className={`px-3 py-1.5 rounded-md transition ${tab === 'configuracion' ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
          >
            ⚙️ Personal y Obras
          </button>
        </div>
      </header>

      {/* Contenido Principal */}
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
        {/* PESTAÑA 1: MONITOR DE HOY */}
        {tab === 'monitor' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-base font-semibold text-white">Estado de Reportes de Hoy</h2>
                <p className="text-xs text-slate-400">Monitoreo en tiempo real de frentes activos y pendientes</p>
              </div>
              <button
                onClick={cargarDatos}
                className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-md transition"
              >
                🔄 Actualizar
              </button>
            </div>

            {/* Tarjetas de estado */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {trabajadores.map(t => {
                const reporteHoy = haReportadoHoy(t.id)
                return (
                  <div
                    key={t.id}
                    className={`border rounded-xl p-4 bg-slate-900/60 flex flex-col justify-between transition ${
                      !t.activo
                        ? 'border-slate-800 opacity-60'
                        : reporteHoy
                        ? 'border-emerald-500/40 bg-emerald-950/10'
                        : 'border-amber-500/40 bg-amber-950/10'
                    }`}
                  >
                    <div>
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <div>
                          <h3 className="font-semibold text-sm text-white">{t.nombre}</h3>
                          <p className="text-xs text-slate-400">+{t.telefono} • {t.cargo}</p>
                        </div>
                        {/* Estado */}
                        {!t.activo ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                            En pausa hoy
                          </span>
                        ) : reporteHoy ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Reportado
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950 text-amber-400 border border-amber-800 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Pendiente
                          </span>
                        )}
                      </div>

                      <div className="text-xs text-slate-300 mt-2 bg-slate-950/40 p-2.5 rounded border border-slate-800/80">
                        <div className="text-[11px] text-slate-400">Frente de Obra:</div>
                        <div className="font-medium text-sky-400">{t.proyectos?.nombre || 'General'}</div>

                        {reporteHoy && (
                          <div className="mt-2 pt-2 border-t border-slate-800/60">
                            <div className="text-[11px] text-emerald-400 font-medium">Último reporte:</div>
                            <div className="text-[11px] text-slate-300 line-clamp-2 mt-0.5">
                              {reporteHoy.observaciones || 'Reporte asentado'}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-800/80 flex justify-between items-center text-xs">
                      <span className="text-[11px] text-slate-500">Jornada: {t.jornada}</span>
                      <button
                        onClick={() => toggleActivoTrabajador(t.id, t.activo)}
                        className={`text-[11px] px-2.5 py-1 rounded transition font-medium ${
                          t.activo
                            ? 'bg-red-950/40 hover:bg-red-900/50 text-red-300 border border-red-800/50'
                            : 'bg-emerald-950/40 hover:bg-emerald-900/50 text-emerald-300 border border-emerald-800/50'
                        }`}
                      >
                        {t.activo ? 'Pausar envío' : 'Activar envío'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* PESTAÑA 2: BITÁCORA DE REPORTES */}
        {tab === 'bitacora' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-base font-semibold text-white">Bitácora Oficial de Perforación</h2>
                <p className="text-xs text-slate-400">Historial consolidado recibido vía WhatsApp</p>
              </div>
              <button
                onClick={cargarDatos}
                className="text-xs bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 rounded-md transition"
              >
                🔄 Refrescar
              </button>
            </div>

            {reportes.length === 0 ? (
              <div className="p-12 text-center text-slate-500 border border-slate-800 rounded-xl bg-slate-900/20">
                Aún no hay reportes confirmados registrados en el sistema.
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-900/30">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900/80 border-b border-slate-800 text-slate-400">
                    <tr>
                      <th className="p-3">Fecha/Hora</th>
                      <th className="p-3">Operador</th>
                      <th className="p-3">Obra</th>
                      <th className="p-3">Tipo</th>
                      <th className="p-3">Pilote / Sondeo</th>
                      <th className="p-3">Avance</th>
                      <th className="p-3">Observaciones / Detalle</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {reportes.map(r => (
                      <tr key={r.id} className="hover:bg-slate-800/20 transition">
                        <td className="p-3 whitespace-nowrap text-slate-400">
                          {new Date(r.created_at).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}
                        </td>
                        <td className="p-3 font-medium text-white">{r.trabajador_nombre}</td>
                        <td className="p-3 text-sky-400">{r.proyecto_nombre}</td>
                        <td className="p-3">
                          <span className="px-2 py-0.5 rounded text-[10px] uppercase font-semibold bg-slate-800 text-slate-300">
                            {r.tipo_operacion}
                          </span>
                        </td>
                        <td className="p-3 font-bold text-amber-400">{r.pilote || r.sondeo || '—'}</td>
                        <td className="p-3 whitespace-nowrap">
                          {r.tipo_operacion === 'pilote'
                            ? `PQ: ${r.avance_pq}m | Ens: ${r.ensanche}m`
                            : r.tipo_operacion === 'estudio_suelo'
                            ? `NQ: ${r.metros_nq}m | SPT: ${r.ensayos_spt}`
                            : 'Logística'}
                        </td>
                        <td className="p-3 text-slate-300 max-w-xs truncate" title={r.observaciones}>
                          {r.observaciones}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* PESTAÑA 3: CONFIGURACIÓN DE PERSONAL Y OBRAS */}
        {tab === 'configuracion' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Registro de Trabajador */}
            <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40">
              <h3 className="text-sm font-semibold text-white mb-1">Registrar Operador en WhatsApp</h3>
              <p className="text-xs text-slate-400 mb-4">El bot solo responderá a números autorizados en esta lista.</p>

              <form onSubmit={crearTrabajador} className="space-y-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">Nombre Completo</label>
                  <input
                    type="text"
                    required
                    value={nombre}
                    onChange={e => setNombre(e.target.value)}
                    placeholder="Ej: Wilson Mocoa"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Teléfono (con indicativo o local)</label>
                    <input
                      type="text"
                      required
                      value={telefono}
                      onChange={e => setTelefono(e.target.value)}
                      placeholder="Ej: 3209511767 o 57320..."
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Cargo</label>
                    <select
                      value={cargo}
                      onChange={e => setCargo(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"
                    >
                      <option value="Perforador">Perforador</option>
                      <option value="Auxiliar">Auxiliar</option>
                      <option value="Residente">Residente</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Frente Asignado</label>
                    <select
                      required
                      value={proyectoId}
                      onChange={e => setProyectoId(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"
                    >
                      <option value="">Selecciona obra...</option>
                      {proyectos.map(p => (
                        <option key={p.id} value={p.id}>{p.nombre}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Jornada</label>
                    <select
                      value={jornada}
                      onChange={e => setJornada(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"
                    >
                      <option value="L-S">Lunes a Sábado</option>
                      <option value="L-V">Lunes a Viernes</option>
                      <option value="Todos">Domingos incluidos</option>
                    </select>
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-sky-600 hover:bg-sky-500 text-white font-medium py-2 rounded transition mt-2"
                >
                  Registrar Personal
                </button>
              </form>
            </div>

            {/* Crear Obra */}
            <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40">
              <h3 className="text-sm font-semibold text-white mb-1">Crear Frente de Trabajo / Proyecto</h3>
              <p className="text-xs text-slate-400 mb-4">Proyectos activos para asociación en bitácora.</p>

              <form onSubmit={crearProyecto} className="space-y-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">Nombre del Proyecto</label>
                  <input
                    type="text"
                    required
                    value={nombreProyecto}
                    onChange={e => setNombreProyecto(e.target.value)}
                    placeholder="Ej: Pilotaje Autopista Norte / Ubaque"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Ubicación / Tramo</label>
                  <input
                    type="text"
                    value={ubicacionProyecto}
                    onChange={e => setUbicacionProyecto(e.target.value)}
                    placeholder="Ej: Bogotá D.C. / K16+000"
                    className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-slate-800 hover:bg-slate-700 text-white font-medium py-2 rounded transition mt-2 border border-slate-700"
                >
                  Crear Proyecto
                </button>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
