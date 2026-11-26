// Affichage d'une question « glisser-déposer sur image » : image de fond, zones de dépôt et étiquettes.
// Trois usages : vue étudiant (on dépose), aperçu avec corrigé (zones remplies), éditeur (on déplace les zones).
import { useEffect, useMemo, useRef, useState } from 'react'
import { type DdDrag, type DdDrop, type DdModel, dataUrl, dropGroup } from './ddimage'

const dragImage = (d: DdDrag): string => {
  const f = /^<file\b[^>]*\bname="([^"]*)"[^>]*>([^<]*)<\/file>$/.exec(d.file.trim())
  return f ? dataUrl(f[1], f[2]) : ''
}

/** Taille des zones d'un groupe : celle de sa plus longue étiquette, comme dans Moodle. */
function groupSizes(m: DdModel): Map<string, { w: number; h: number }> {
  const sizes = new Map<string, { w: number; h: number }>()
  for (const d of m.drags) {
    const s = sizes.get(d.group) ?? { w: 44, h: 26 }
    sizes.set(d.group, { w: Math.max(s.w, Math.round(d.text.length * 7.4) + 18), h: d.file ? Math.max(s.h, 60) : s.h })
  }
  return sizes
}

function Label({ d }: { d: DdDrag }) {
  const src = d.file ? dragImage(d) : ''
  return src ? <img src={src} alt={d.text} style={{ maxHeight: 56, maxWidth: 120 }} /> : <>{d.text}</>
}

export function DdBoard({
  model,
  placed = {},
  held = null,
  done = false,
  order,
  mode,
  onHold,
  onPlace,
  onMove,
}: {
  model: DdModel
  /** Numéro de zone → numéro d'étiquette déposée. */
  placed?: Record<number, number>
  held?: number | null
  done?: boolean
  /** Ordre d'affichage des étiquettes (numéros), pour le mélange. */
  order?: number[]
  mode: 'student' | 'answers' | 'edit'
  onHold?: (no: number | null) => void
  onPlace?: (drop: number, drag: number | null) => void
  onMove?: (drop: number, x: number, y: number) => void
}) {
  const outer = useRef<HTMLDivElement>(null)
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null)
  const [scale, setScale] = useState(1)
  const bg = useMemo(() => dataUrl(model.bgName, model.bgData), [model.bgName, model.bgData])
  const sizes = useMemo(() => groupSizes(model), [model])
  const byNo = useMemo(() => new Map(model.drags.map((d) => [d.no, d])), [model])

  useEffect(() => {
    if (!nat || !outer.current) return
    const el = outer.current
    const fit = () => setScale(Math.min(1, el.clientWidth / nat.w))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [nat])

  const shown = mode === 'student' ? placed : Object.fromEntries(model.drops.map((d) => [d.no, d.choice]))
  const used = new Set(Object.values(placed))
  const palette = (order ?? model.drags.map((d) => d.no))
    .map((no) => byNo.get(no))
    .filter((d): d is DdDrag => !!d)
    .filter((d) => (mode === 'student' ? d.infinite || !used.has(d.no) : true))
  const groups = [...new Set(model.drags.map((d) => d.group))].sort()
  const heldGroup = held !== null ? byNo.get(held)?.group : undefined

  // Éditeur : déplacer une zone à la souris.
  const startMove = (drop: DdDrop) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== 'edit' || !onMove) return
    e.preventDefault()
    const el = e.currentTarget
    const x0 = e.clientX
    const y0 = e.clientY
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      el.style.left = Math.max(0, drop.x + (ev.clientX - x0) / scale) + 'px'
      el.style.top = Math.max(0, drop.y + (ev.clientY - y0) / scale) + 'px'
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      onMove(drop.no, Math.max(0, Math.round(drop.x + (ev.clientX - x0) / scale)), Math.max(0, Math.round(drop.y + (ev.clientY - y0) / scale)))
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  if (!bg) return <p className="hint">Image de fond absente : la question ne peut pas être affichée.</p>
  return (
    <div className={'ddi ddi-' + mode}>
      <div ref={outer} className="ddi-outer" style={{ height: nat ? nat.h * scale : undefined }}>
        <div className="ddi-inner" style={nat ? { width: nat.w, height: nat.h, transform: `scale(${scale})` } : undefined}>
          <img src={bg} alt="" draggable={false} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {nat &&
            model.drops.map((drop) => {
              const group = dropGroup(model, drop)
              const size = sizes.get(group) ?? { w: 60, h: 26 }
              const got = shown[drop.no]
              const d = got !== undefined ? byNo.get(got) : undefined
              const ok = done && mode === 'student' ? got !== undefined && (got === drop.choice || (byNo.get(got)?.text.trim() === byNo.get(drop.choice)?.text.trim() && byNo.get(got)?.group === group)) : null
              const can = mode === 'student' && !done
              return (
                <div
                  key={drop.no}
                  className={'ddi-drop g' + group + (d ? ' filled' : '') + (ok === true ? ' ok' : ok === false ? ' bad' : '') + (can && heldGroup === group ? ' target' : '')}
                  style={{ left: drop.x, top: drop.y, width: size.w, height: size.h }}
                  title={mode === 'edit' ? `Zone ${drop.no} : ${drop.label} (glisser pour déplacer)` : done ? 'Réponse attendue : ' + (byNo.get(drop.choice)?.text ?? '') : drop.label}
                  onPointerDown={startMove(drop)}
                  onClick={() => {
                    if (!can || !onPlace) return
                    if (held !== null && heldGroup === group) {
                      onPlace(drop.no, held)
                      onHold?.(null)
                    } else if (d) onPlace(drop.no, null)
                  }}
                  onDragOver={(e) => can && heldGroup === group && e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (can && held !== null && heldGroup === group && onPlace) {
                      onPlace(drop.no, held)
                      onHold?.(null)
                    }
                  }}
                >
                  {d ? <Label d={d} /> : mode === 'edit' ? drop.no : ''}
                </div>
              )
            })}
        </div>
      </div>

      {mode !== 'edit' && (
        <div className="ddi-palette">
          {groups.map((g) => (
            <div key={g} className="ddi-group">
              {palette
                .filter((d) => d.group === g)
                .map((d) => {
                  const spare = mode === 'answers' && !model.drops.some((z) => z.choice === d.no)
                  return (
                    <button
                      key={d.no}
                      type="button"
                      className={'ddi-drag g' + g + (held === d.no ? ' held' : '') + (spare ? ' spare' : '')}
                      style={{ minWidth: sizes.get(g)?.w }}
                      draggable={mode === 'student' && !done}
                      disabled={mode === 'student' && done}
                      title={spare ? 'Leurre : aucune zone n’attend cette étiquette' : d.infinite ? 'Étiquette réutilisable' : undefined}
                      onClick={() => mode === 'student' && onHold?.(held === d.no ? null : d.no)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', String(d.no))
                        onHold?.(d.no)
                      }}
                      onDragEnd={() => onHold?.(null)}
                    >
                      <Label d={d} />
                    </button>
                  )
                })}
            </div>
          ))}
        </div>
      )}
      {mode === 'student' && !done && <p className="hint">Glissez une étiquette sur une zone, ou cliquez l’étiquette puis la zone. Cliquez une zone remplie pour la vider.</p>}
    </div>
  )
}
