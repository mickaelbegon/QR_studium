// Diagramme circulaire de la composition d'un examen : niveau cognitif, type, thème ou difficulté.
import { useState } from 'react'
import { LEVELS, levelOf } from './levels'
import { type Question, categoryParts, typeLabel } from './model'
import { DIFFICULTY } from './scores'

// Palette catégorielle validée (daltonisme, contraste) ; l'ordre est fixe, jamais recyclé.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
// Difficulté : une seule teinte, du clair (facile) au foncé (difficile).
const RAMP = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281']
const NONE = '#c3c8d0'
const TYPE_ORDER = ['multichoice', 'truefalse', 'matching', 'cloze', 'numerical', 'shortanswer', 'ddwtos', 'ddimageortext', 'essay', 'description']

type Slice = { key: string; label: string; color: string; n: number; points: number }
const MODES = [
  { key: 'level', label: 'Niveau' },
  { key: 'type', label: 'Type' },
  { key: 'theme', label: 'Thème' },
  { key: 'difficulty', label: 'Difficulté' },
] as const
type Mode = (typeof MODES)[number]['key']

/** Thème d'une question : le début de son titre (« Posture – … »), sinon sa catégorie. */
function themeOf(q: Question, depth: number): string {
  const name = (q.fields.find((f) => f.kind === 'text' && f.tag === 'name') as { rt: { text: string } } | undefined)?.rt.text ?? ''
  const m = /^\*?([^–—]{2,30}?)\s[–—]\s/.exec(name)
  if (m) return m[1].trim()
  const parts = categoryParts(q.category)
  return parts[Math.min(depth, parts.length - 1)] ?? '(sans thème)'
}

function slices(items: Question[], mode: Mode, points: (q: Question) => number): Slice[] {
  const add = (map: Map<string, Slice>, key: string, label: string, color: string, q: Question) => {
    const s = map.get(key) ?? { key, label, color, n: 0, points: 0 }
    s.n++
    s.points += points(q)
    map.set(key, s)
  }
  const map = new Map<string, Slice>()
  if (mode === 'level') {
    for (const l of LEVELS) map.set(l.key, { key: l.key, label: l.label, color: SERIES[LEVELS.indexOf(l)], n: 0, points: 0 })
    for (const q of items) {
      const k = levelOf(q)
      add(map, k || '-', k ? LEVELS.find((l) => l.key === k)!.label : 'Sans niveau', k ? SERIES[LEVELS.findIndex((l) => l.key === k)] : NONE, q)
    }
  } else if (mode === 'difficulty') {
    for (let d = 1; d <= 5; d++) map.set(String(d), { key: String(d), label: `${d} – ${DIFFICULTY[d]}`, color: RAMP[d - 1], n: 0, points: 0 })
    for (const q of items) {
      const d = q.meta.difficulty
      add(map, d ? String(d) : '-', d ? `${d} – ${DIFFICULTY[d]}` : 'Sans difficulté', d ? RAMP[d - 1] : NONE, q)
    }
  } else if (mode === 'type') {
    for (const q of items) {
      const i = TYPE_ORDER.indexOf(q.type)
      add(map, q.type, typeLabel(q.type), i >= 0 && i < SERIES.length ? SERIES[i] : NONE, q)
    }
  } else {
    const all = items.map((q) => categoryParts(q.category))
    let depth = 0
    while (all.length > 1 && all.every((p) => p.length > depth + 1 && p[depth] === all[0][depth])) depth++
    for (const q of items) add(map, themeOf(q, depth), themeOf(q, depth), NONE, q)
  }
  let list = [...map.values()].filter((s) => s.n > 0)
  if (mode === 'theme') {
    // Les plus gros thèmes gardent chacun une couleur ; au-delà de sept, le reste se regroupe.
    list.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'fr'))
    if (list.length > SERIES.length) {
      const rest = list.slice(SERIES.length - 1)
      list = [...list.slice(0, SERIES.length - 1), { key: '-', label: `Autres (${rest.length} thèmes)`, color: NONE, n: rest.reduce((s, x) => s + x.n, 0), points: rest.reduce((s, x) => s + x.points, 0) }]
    }
    const names = list.filter((s) => s.key !== '-').map((s) => s.label).sort((a, b) => a.localeCompare(b, 'fr'))
    list = list.map((s) => (s.key === '-' ? s : { ...s, color: SERIES[names.indexOf(s.label)] }))
  }
  return list
}

const R = 78
const C = 84
const arc = (a0: number, a1: number): string => {
  const p = (a: number) => `${(C + R * Math.sin(a)).toFixed(2)} ${(C - R * Math.cos(a)).toFixed(2)}`
  return `M ${C} ${C} L ${p(a0)} A ${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)} Z`
}

export function ExamChart({ items, points }: { items: Question[]; points: (q: Question) => number }) {
  const hasLevels = items.some((q) => levelOf(q))
  const [mode, setMode] = useState<Mode>(hasLevels ? 'level' : 'type')
  const [hover, setHover] = useState<string | null>(null)
  if (!items.length) return null
  const data = slices(items, mode, points)
  const total = data.reduce((s, x) => s + x.n, 0)
  const pct = (n: number) => Math.round((n / total) * 100)
  let angle = 0
  return (
    <div className="exam-chart">
      <div className="row">
        <strong className="grow">Composition de l’examen</strong>
        <div className="seg" role="tablist" aria-label="Critère de répartition">
          {MODES.map((m) => (
            <button key={m.key} role="tab" aria-selected={mode === m.key} className={mode === m.key ? 'on' : ''} onClick={() => setMode(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pie-wrap">
        <svg viewBox={`0 0 ${C * 2} ${C * 2}`} className="pie" role="img" aria-label={'Répartition des questions : ' + data.map((s) => `${s.label} ${pct(s.n)} %`).join(', ')}>
          {data.map((s) => {
            const a0 = angle
            const a1 = (angle += (s.n / total) * Math.PI * 2)
            const mid = (a0 + a1) / 2
            const tip = `${s.label} : ${s.n} question${s.n > 1 ? 's' : ''} (${pct(s.n)} %), ${+s.points.toFixed(2)} point${s.points > 1 ? 's' : ''}`
            return (
              <g key={s.key} className={hover && hover !== s.key ? 'dim' : ''} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
                {data.length === 1 ? <circle cx={C} cy={C} r={R} fill={s.color} /> : <path d={arc(a0, a1)} fill={s.color} />}
                <title>{tip}</title>
                {pct(s.n) >= 8 && (
                  <text x={C + R * 0.62 * Math.sin(mid)} y={C - R * 0.62 * Math.cos(mid)} className={'pie-label' + (s.color === NONE || s.color === '#eda100' || s.color === '#86b6ef' ? ' dark' : '')}>
                    {pct(s.n)} %
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        <table className="pie-legend">
          <tbody>
            {data.map((s) => (
              <tr key={s.key} className={hover === s.key ? 'on' : ''} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
                <td>
                  <span className="swatch" style={{ background: s.color }} />
                </td>
                <td className="name">{s.label}</td>
                <td className="num">{s.n}</td>
                <td className="num">{pct(s.n)} %</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
