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
  estado_conversacion?: string
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
  const [tab, setTab] = useState<'monitor' | 'bitacora' | 'configuracion'>('configuracion')
  const [proyectos, setProyectos] = useState<Proyecto[]>([])
  const [trabajadores, setTrabajadores] = useState<Trabajador[]>([])
  const [reportes, setReportes] = useState<ReporteOperativo[]>([])
  const [ejecutando, setEjecutando] = useState(false)
  const [mensajeEstado, setMensajeEstado] = useState('')

  // Formulario nuevo trabajador
  const [nombre, setNombre] = useState('')
  const [telefono, setTelefono] = useState('')
  const [proyectoId, setProyectoId] = useState('')
  const [jornada, setJornada] = useState('L-S')
  const [cargo, setCargo] = useState('Perforador')
  const [mostrarDirectorio, setMostrarDirectorio] = useState(false)

  // Directorio Único (sin duplicados de teléfono)
  const directorioUnico = Array.from(new Map(trabajadores.map(t => [t.telefono, t])).values())

  // Formulario nuevo proyecto
  const [nombreProyecto, setNombreProyecto] = useState('')
  const [ubicacionProyecto, setUbicacionProyecto] = useState('')

  // Modal de edición
  const [editandoTrabajador, setEditandoTrabajador] = useState<Trabajador | null>(null)

  useEffect(() => {
    cargarDatos()
  }, [])

  async function cargarDatos() {
    try {
      const { data: proys } = await supabase.from('proyectos').select('*').order('created_at', { ascending: false })
      const { data: trabs } = await supabase.from('trabajadores').select('*, proyectos(*)').order('nombre', { ascending: true })
      const { data: reps } = await supabase.from('reportes_operativos').select('*').order('created_at', { ascending: false })

      if (proys) setProyectos(proys)
      if (trabs) setTrabajadores(trabs)
      if (reps) setReportes(reps)
    } catch (err) {
      console.error('Error general:', err)
    }
  }

  function haReportadoHoy(trabajadorId: string) {
    const hoyStr = new Date().toISOString().split('T')[0]
    return reportes.find(r => r.trabajador_id === trabajadorId && r.created_at.startsWith(hoyStr))
  }

  async function toggleActivoTrabajador(id: string, estadoActual: boolean) {
    await supabase.from('trabajadores').update({ activo: !estadoActual }).eq('id', id)
    cargarDatos()
  }

  async function crearProyecto(e: React.FormEvent) {
    e.preventDefault()
    if (!nombreProyecto.trim()) return

    const { error } = await supabase.from('proyectos').insert({
      nombre: nombreProyecto.trim(),
      ubicacion: ubicacionProyecto.trim() || 'General'
    })

    if (error) {
      alert(`❌ Error al guardar la obra: ${error.message}`)
      return
    }

    alert('✅ ¡Obra guardada exitosamente!')
    setNombreProyecto('')
    setUbicacionProyecto('')
    cargarDatos()
  }

  async function finalizarObra(id: string, nombreObra: string) {
    const totalTrabs = trabajadores.filter(t => t.proyecto_id === id).length
    const confirmar = confirm(
      `¿Deseas finalizar y cerrar la obra "${nombreObra}"?\n\n` +
      `⚠️ Acción:\n` +
      `• Se darán de baja los ${totalTrabs} operarios asignados a este frente.\n` +
      `• El bot no volverá a escribirles ni a incluirlos en los consolidados.\n` +
      `• El historial en la Bitácora se mantiene intacto.`
    )

    if (!confirmar) return

    const { error: errTrabs } = await supabase.from('trabajadores').delete().eq('proyecto_id', id)
    if (errTrabs) {
      await supabase.from('trabajadores').update({ activo: false }).eq('proyecto_id', id)
    }

    const { error: errProy } = await supabase.from('proyectos').delete().eq('id', id)
    if (errProy) {
      console.warn('Error al borrar obra:', errProy)
    }

    alert(`🏁 Obra "${nombreObra}" finalizada con éxito.`)
    cargarDatos()
  }

  async function crearTrabajador(e: React.FormEvent) {
    e.preventDefault()
    if (!nombre.trim() || !telefono.trim() || !proyectoId) {
      alert('⚠️ Por favor completa todos los campos requeridos.')
      return
    }

    const telLimpio = telefono.replace(/\D/g, '')

    // 1. Buscamos si el trabajador ya existe en el directorio
    const { data: existente } = await supabase.from('trabajadores').select('id').eq('telefono', telLimpio).maybeSingle()

    if (existente) {
      // 2. Si existe, lo REASIGNAMOS (Update)
      const { error } = await supabase.from('trabajadores').update({
        nombre: nombre.trim(),
        proyecto_id: proyectoId,
        cargo,
        jornada,
        activo: true,
        estado_conversacion: 'inactivo'
      }).eq('id', existente.id)
      
      if (error) { alert(`❌ Error al reasignar: ${error.message}`); return }
    } else {
      // 3. Si es nuevo, lo INSERTAMOS
      const { error } = await supabase.from('trabajadores').insert({
        nombre: nombre.trim(),
        telefono: telLimpio,
        proyecto_id: proyectoId,
        cargo,
        jornada,
        activo: true,
        estado_conversacion: 'inactivo'
      })
      if (error) { alert(`❌ Error al registrar: ${error.message}`); return }
    }

    alert('✅ ¡Operador registrado y asignado a la obra exitosamente!')
    setNombre('')
    setTelefono('')
    cargarDatos()
  }

  async function guardarEdicionTrabajador(e: React.FormEvent) {
    e.preventDefault()
    if (!editandoTrabajador) return

    const { error } = await supabase
      .from('trabajadores')
      .update({
        nombre: editandoTrabajador.nombre,
        telefono: editandoTrabajador.telefono.replace(/\D/g, ''),
        proyecto_id: editandoTrabajador.proyecto_id,
        cargo: editandoTrabajador.cargo,
        jornada: editandoTrabajador.jornada
      })
      .eq('id', editandoTrabajador.id)

    if (error) {
      alert(`❌ Error al actualizar: ${error.message}`)
      return
    }

    alert('✅ Operador actualizado correctamente.')
    setEditandoTrabajador(null)
    cargarDatos()
  }

  async function eliminarTrabajador(id: string, nombreTrabajador: string) {
    if (!confirm(`¿Estás seguro de que deseas eliminar permanentemente a ${nombreTrabajador} del directorio?`)) return
    const { error } = await supabase.from('trabajadores').delete().eq('id', id)
    if (error) { alert(`❌ No se pudo eliminar: ${error.message}`); return }
    alert('🗑️ Operador eliminado del directorio.')
    cargarDatos()
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
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
            📋 Bitácora ({reportes.length})
          </button>
          <button
            onClick={() => setTab('configuracion')}
            className={`px-3 py-1.5 rounded-md transition ${tab === 'configuracion' ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
          >
            ⚙️ Personal y Obras ({trabajadores.length})
          </button>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-7xl w-full mx-auto">
        
        {/* MODAL EDITAR OPERADOR (Se mantiene igual) */}
        {editandoTrabajador && (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 z-50">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 max-w-md w-full text-xs shadow-2xl">
              <h3 className="text-sm font-bold text-white mb-1">Editar Operador</h3>
              <form onSubmit={guardarEdicionTrabajador} className="space-y-3">
                <div>
                  <label className="block text-slate-400 mb-1">Nombre</label>
                  <input type="text" required value={editandoTrabajador.nombre} onChange={e => setEditandoTrabajador({ ...editandoTrabajador, nombre: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"/>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Teléfono</label>
                    <input type="text" required value={editandoTrabajador.telefono} onChange={e => setEditandoTrabajador({ ...editandoTrabajador, telefono: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"/>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Cargo</label>
                    <select value={editandoTrabajador.cargo} onChange={e => setEditandoTrabajador({ ...editandoTrabajador, cargo: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500">
                      <option value="Perforador">Perforador</option>
                      <option value="Auxiliar">Auxiliar</option>
                      <option value="Residente">Residente</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Frente de Obra</label>
                    <select required value={editandoTrabajador.proyecto_id} onChange={e => setEditandoTrabajador({ ...editandoTrabajador, proyecto_id: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500">
                      {proyectos.map(p => (<option key={p.id} value={p.id}>{p.nombre}</option>))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Jornada</label>
                    <select value={editandoTrabajador.jornada} onChange={e => setEditandoTrabajador({ ...editandoTrabajador, jornada: e.target.value })} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500">
                      <option value="L-S">Lunes a Sábado</option>
                      <option value="L-V">Lunes a Viernes</option>
                      <option value="Todos">Domingos incluidos</option>
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <button type="submit" className="flex-1 bg-sky-600 hover:bg-sky-500 text-white font-medium py-2 rounded transition">Guardar</button>
                  <button type="button" onClick={() => setEditandoTrabajador(null)} className="px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 py-2 rounded transition">Cancelar</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* MONITOR */}
        {tab === 'monitor' && (
          <div className="space-y-6">
            <div className="flex flex-wrap justify-between items-center gap-3">
              <div>
                <h2 className="text-base font-semibold text-white">Control de Jornada Diaria</h2>
              </div>
              <button onClick={cargarDatos} className="text-xs bg-slate-800 px-3 py-1.5 rounded-md">🔄 Actualizar</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {trabajadores.map(t => {
                const reporteHoy = haReportadoHoy(t.id)
                return (
                  <div key={t.id} className={`border rounded-xl p-4 bg-slate-900/60 transition ${!t.activo ? 'border-slate-800 opacity-60' : reporteHoy ? 'border-emerald-500/40 bg-emerald-950/10' : 'border-amber-500/40 bg-amber-950/10'}`}>
                    <div>
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <div>
                          <h3 className="font-semibold text-sm text-white">{t.nombre}</h3>
                          <p className="text-xs text-slate-400">+{t.telefono} • {t.cargo}</p>
                        </div>
                        {!t.activo ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">Pausado</span> : reporteHoy ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800">Reportado</span> : <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-950 text-amber-400 border border-amber-800">Pendiente</span>}
                      </div>
                      <div className="text-xs text-slate-300 mt-2 bg-slate-950/40 p-2.5 rounded border border-slate-800/80">
                        <div className="text-[11px] text-slate-400">Frente:</div>
                        <div className="font-medium text-sky-400">{t.proyectos?.nombre || 'General'}</div>
                        {reporteHoy && <div className="mt-2 pt-2 border-t border-slate-800/60"><div className="text-[11px] text-emerald-400 font-medium">Avance:</div><div className="text-[11px] text-slate-300 truncate mt-0.5">{reporteHoy.observaciones}</div></div>}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* BITACORA */}
        {tab === 'bitacora' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-base font-semibold text-white">Bitácora Oficial</h2>
              <button onClick={cargarDatos} className="text-xs bg-slate-800 px-3 py-1.5 rounded-md">🔄 Refrescar</button>
            </div>
            <div className="overflow-x-auto border border-slate-800 rounded-xl bg-slate-900/30">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/80 border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="p-3">Fecha/Hora</th><th className="p-3">Operador</th><th className="p-3">Obra</th><th className="p-3">Tipo</th><th className="p-3">Punto</th><th className="p-3">Avance</th><th className="p-3">Observaciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {reportes.map(r => (
                    <tr key={r.id} className="hover:bg-slate-800/20">
                      <td className="p-3 text-slate-400">{new Date(r.created_at).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td className="p-3 font-medium text-white">{r.trabajador_nombre}</td>
                      <td className="p-3 text-sky-400">{r.proyecto_nombre}</td>
                      <td className="p-3"><span className="px-2 py-0.5 rounded text-[10px] uppercase font-semibold bg-slate-800 text-slate-300">{r.tipo_operacion}</span></td>
                      <td className="p-3 font-bold text-amber-400">{r.pilote || r.sondeo || '—'}</td>
                      <td className="p-3">{r.tipo_operacion === 'pilote' ? `PQ: ${r.avance_pq}m | Ens: ${r.ensanche}m | Camisa: ${r.encamisado}m` : r.tipo_operacion === 'estudio_suelo' ? `NQ: ${r.metros_nq}m | SPT: ${r.ensayos_spt}` : 'Logística'}</td>
                      <td className="p-3 text-slate-300 truncate max-w-xs">{r.observaciones}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CONFIGURACIÓN */}
        {tab === 'configuracion' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              
              {/* CREAR OBRA */}
              <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40">
                <h3 className="text-sm font-semibold text-white mb-1">1. Crear Frente de Trabajo / Proyecto</h3>
                <p className="text-xs text-slate-400 mb-4">Crea la obra para poder asignarla al personal.</p>
                <form onSubmit={crearProyecto} className="space-y-3 text-xs">
                  <div>
                    <label className="block text-slate-400 mb-1">Nombre del Proyecto / Obra *</label>
                    <input type="text" required value={nombreProyecto} onChange={e => setNombreProyecto(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500" />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Ubicación / Tramo</label>
                    <input type="text" value={ubicacionProyecto} onChange={e => setUbicacionProyecto(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500" />
                  </div>
                  <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2 rounded transition mt-2 shadow">➕ Guardar Proyecto</button>
                </form>
              </div>

              {/* REGISTRAR OPERADOR (CON AUTOCOMPLETADO) */}
              <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40">
                <h3 className="text-sm font-semibold text-white mb-1">2. Asignar Operador a Proyecto</h3>
                <p className="text-xs text-slate-400 mb-4">Usa el directorio para cargar operarios antiguos o crea uno nuevo.</p>

                <form onSubmit={crearTrabajador} className="space-y-3 text-xs">
                  <div className="relative">
                    <div className="flex justify-between items-end mb-1">
                      <label className="block text-slate-400">Nombre Completo *</label>
                      {directorioUnico.length > 0 && (
                        <button 
                          type="button" 
                          onClick={() => setMostrarDirectorio(!mostrarDirectorio)}
                          className="text-sky-400 hover:text-sky-300 underline font-medium flex items-center gap-1"
                        >
                          📘 {mostrarDirectorio ? 'Cerrar Directorio' : 'Abrir Directorio'}
                        </button>
                      )}
                    </div>
                    
                    <input
                      type="text"
                      required
                      value={nombre}
                      onChange={e => setNombre(e.target.value)}
                      onFocus={() => setMostrarDirectorio(true)}
                      placeholder="Ej: Sofia Florez"
                      className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500"
                    />

                    {/* CAJA FLOTANTE DEL DIRECTORIO */}
                    {mostrarDirectorio && (
                      <div className="absolute z-10 w-full mt-1 bg-slate-900 border border-slate-700 rounded-lg shadow-2xl max-h-48 overflow-y-auto">
                        <div className="sticky top-0 bg-slate-800 px-3 py-2 text-[10px] uppercase font-bold text-slate-400 border-b border-slate-700">
                          Personal Guardado en Directorio
                        </div>
                        {directorioUnico.filter(t => t.nombre.toLowerCase().includes(nombre.toLowerCase())).map(t => (
                          <div
                            key={t.telefono}
                            onClick={() => {
                              setNombre(t.nombre)
                              setTelefono(t.telefono)
                              setCargo(t.cargo || 'Perforador')
                              setJornada(t.jornada || 'L-S')
                              setMostrarDirectorio(false)
                            }}
                            className="px-3 py-2 border-b border-slate-800/50 hover:bg-slate-800 cursor-pointer transition flex justify-between items-center"
                          >
                            <div>
                              <div className="font-bold text-white text-xs">{t.nombre}</div>
                              <div className="text-slate-400 text-[10px]">+{t.telefono} • {t.cargo}</div>
                            </div>
                            <span className="text-[10px] bg-sky-900/50 text-sky-300 px-2 py-1 rounded">Autocompletar</span>
                          </div>
                        ))}
                        {directorioUnico.filter(t => t.nombre.toLowerCase().includes(nombre.toLowerCase())).length === 0 && (
                          <div className="p-3 text-slate-500 text-center text-xs">No se encontraron coincidencias.</div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Teléfono WhatsApp *</label>
                      <input type="text" required value={telefono} onChange={e => setTelefono(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500" />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Cargo</label>
                      <select value={cargo} onChange={e => setCargo(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500">
                        <option value="Perforador">Perforador</option><option value="Auxiliar">Auxiliar</option><option value="Residente">Residente</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Frente Asignado *</label>
                      <select required value={proyectoId} onChange={e => setProyectoId(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500">
                        <option value="">Selecciona obra...</option>
                        {proyectos.map(p => (<option key={p.id} value={p.id}>{p.nombre}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Jornada</label>
                      <select value={jornada} onChange={e => setJornada(e.target.value)} className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-white outline-none focus:border-sky-500">
                        <option value="L-S">Lunes a Sábado</option><option value="L-V">Lunes a Viernes</option><option value="Todos">Domingos incluidos</option>
                      </select>
                    </div>
                  </div>

                  <button type="submit" className="w-full bg-sky-600 hover:bg-sky-500 text-white font-medium py-2 rounded transition mt-2 shadow">
                    ➕ Guardar / Reasignar Personal
                  </button>
                </form>
              </div>
            </div>

            {/* FRENTES DE OBRA */}
            <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40">
              <h3 className="text-sm font-semibold text-white mb-3">Frentes de Obra en Ejecución ({proyectos.length})</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {proyectos.map(p => {
                  const trabsEnObra = trabajadores.filter(t => t.proyecto_id === p.id)
                  return (
                    <div key={p.id} className="p-3 bg-slate-950 rounded-lg border border-slate-800 flex flex-col justify-between">
                      <div>
                        <div className="font-semibold text-sky-400 text-xs">{p.nombre}</div>
                        <div className="mt-2 text-[11px] text-slate-400">👥 Operadores en este frente: <span className="font-bold text-white">{trabsEnObra.length}</span></div>
                      </div>
                      <div className="mt-3 pt-2 border-t border-slate-800/60 flex justify-end">
                        <button onClick={() => finalizarObra(p.id, p.nombre)} className="text-[11px] px-2.5 py-1 rounded bg-red-950/60 text-red-300 border border-red-800/60 font-medium">
                          🏁 Cerrar Obra
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* LISTA MAESTRA DE OPERARIOS */}
            <div className="border border-slate-800 rounded-xl p-5 bg-slate-900/40">
              <h3 className="text-sm font-semibold text-white mb-3">Lista Maestra de Personal ({trabajadores.length})</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950 border-b border-slate-800 text-slate-400">
                    <tr><th className="p-2.5">Nombre</th><th className="p-2.5">Teléfono</th><th className="p-2.5">Cargo</th><th className="p-2.5">Frente Actual</th><th className="p-2.5 text-right">Acciones</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/40">
                    {trabajadores.map(t => (
                      <tr key={t.id} className="hover:bg-slate-800/20">
                        <td className="p-2.5 font-medium text-white">{t.nombre} {!t.activo && <span className="text-[9px] bg-slate-800 px-1 rounded ml-1 text-slate-400">Inactivo</span>}</td>
                        <td className="p-2.5 text-slate-300">+{t.telefono}</td>
                        <td className="p-2.5 text-slate-400">{t.cargo}</td>
                        <td className="p-2.5 font-semibold text-sky-400">{t.proyectos?.nombre || 'Bolsa de Empleo (Sin Obra)'}</td>
                        <td className="p-2.5 text-right space-x-2">
                          <button onClick={() => setEditandoTrabajador(t)} className="text-sky-400 hover:text-sky-300 font-medium px-2 py-1 rounded bg-sky-950/50 border border-sky-800/50">✏️ Editar</button>
                          <button onClick={() => eliminarTrabajador(t.id, t.nombre)} className="text-red-400 hover:text-red-300 font-medium px-2 py-1 rounded bg-red-950/50 border border-red-800/50">🗑️ Borrar</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  )
}
