// Vue étudiant : la question telle qu'elle se présente dans un test StudiUM (Moodle),
// avec des réponses que l'on peut choisir, puis « Vérifier » pour voir note et rétroactions.
import { useMemo, useRef, useState } from 'react'
import { type ClozePart, parseCloze } from './cloze'
import { points } from './Exams'
import { dragBoxes } from './dragbox'
import { renderRt } from './files'
import { getUnits, gradeNumerical, unitChoice } from './units'
import { type Answer, type Question, type RichText, getProp, getText, plain } from './model'
import { Html } from './Preview'

const fr = (n: number) => n.toFixed(2).replace('.', ',')
const isOn = (v: string | undefined) => v === 'true' || v === '1'

function shuffle<T>(a: T[]): T[] {
  const b = [...a]
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[b[i], b[j]] = [b[j], b[i]]
  }
  return b
}

function roman(n: number): string {
  const map: [number, string][] = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let s = ''
  for (const [v, r] of map) while (n >= v) {
    s += r
    n -= v
  }
  return s
}

/** Numérotation des choix selon le réglage Moodle « answernumbering ». */
function numbering(style: string | undefined, i: number): string {
  switch (style) {
    case 'none':
      return ''
    case 'ABCD':
      return String.fromCharCode(65 + i) + '.'
    case '123':
      return i + 1 + '.'
    case 'iii':
      return roman(i + 1) + '.'
    case 'IIII':
      return roman(i + 1).toUpperCase() + '.'
    default:
      return String.fromCharCode(97 + i) + '.'
  }
}

/** Réponse courte : insensible à la casse, « * » remplace n'importe quelle suite de caractères. */
function textMatches(pattern: string, given: string): boolean {
  const re = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp('^' + re + '$', 'i').test(given.trim())
}
const toNumber = (s: string) => parseFloat(s.trim().replace(',', '.'))
const tolerance = (a: Answer) => parseFloat(/<tolerance>([^<]*)<\/tolerance>/.exec(a.extra.join(''))?.[1] ?? '0') || 0

/** Choix à déposer d'une question « glisser-déposer sur texte ». */
function dragChoices(q: Question): string[] {
  return dragBoxes(q).map((b) => b.box.text)
}

function gradeClozePart(p: ClozePart, root: HTMLElement, i: number): { fraction: number; answered: boolean; feedback: string } {
  const el = root.querySelector<HTMLElement>(`[data-cz="${i}"]`)
  if (!el) return { fraction: 0, answered: false, feedback: '' }
  if (el instanceof HTMLInputElement) {
    const v = el.value
    if (!v.trim()) return { fraction: 0, answered: false, feedback: '' }
    const hit = p.options.find((o) => {
      if (p.kind !== 'nm') return textMatches(o.text, v)
      const [val, tol] = o.text.split(':')
      return o.text.trim() === '*' || Math.abs(toNumber(v) - toNumber(val)) <= (parseFloat(tol ?? '0') || 0) + 1e-9
    })
    return { fraction: (hit?.fraction ?? 0) / 100, answered: true, feedback: hit?.feedback ?? '' }
  }
  if (el instanceof HTMLSelectElement) {
    const o = p.options[+el.value]
    return el.value === '' || !o ? { fraction: 0, answered: false, feedback: '' } : { fraction: o.fraction / 100, answered: true, feedback: o.feedback }
  }
  const picked = [...el.querySelectorAll<HTMLInputElement>('input:checked')].map((x) => p.options[+x.value]).filter(Boolean)
  const sum = picked.reduce((s, o) => s + o.fraction, 0) / 100
  return { fraction: Math.max(0, Math.min(1, sum)), answered: picked.length > 0, feedback: picked.map((o) => o.feedback).filter(Boolean).join(' ') }
}

export function StudentView({ q, number = 1 }: { q: Question; number?: number }) {
  const [attempt, setAttempt] = useState(0)
  return <Attempt key={attempt} q={q} number={number} onRetry={() => setAttempt(attempt + 1)} />
}

function Attempt({ q, number, onRetry }: { q: Question; number: number; onRetry: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [pairs, setPairs] = useState<Record<string, string>>({})
  const [typed, setTyped] = useState('')
  const [unit, setUnit] = useState('')
  const [result, setResult] = useState<{ fraction: number | null; answered: boolean } | null>(null)
  const inline = useRef<HTMLDivElement>(null)

  const type = q.type
  const single = getProp(q, 'single') !== 'false'
  const mix = isOn(getProp(q, 'shuffleanswers'))
  const max = points(q)
  const text = getText(q, 'questiontext')
  const interactiveText = type === 'cloze' || type === 'ddwtos'

  // L'ordre est tiré une fois par tentative, comme pour un étudiant.
  const answers = useMemo(() => (type === 'truefalse' ? [...q.answers].sort((a) => (a.rt.text.trim() === 'true' ? -1 : 1)) : mix ? shuffle(q.answers) : q.answers), [])
  const rows = useMemo(() => {
    const filled = q.subquestions.filter((s) => plain(s.rt.text) || s.rt.files.length)
    return mix ? shuffle(filled) : filled
  }, [])
  const choices = useMemo(() => shuffle([...new Set(q.subquestions.map((s) => s.answer.trim()).filter(Boolean))]), [])
  const drags = useMemo(() => (type === 'ddwtos' ? dragChoices(q) : []), [])
  const parts = useMemo(() => (type === 'cloze' ? parseCloze(text?.text ?? '') : []), [])

  const inlineHtml = useMemo(() => {
    if (type === 'cloze') return renderRt(text, { cloze: true, interactive: true })
    if (type !== 'ddwtos') return ''
    // Les choix sont mélangés seulement si la question le demande (sinon : ordre de l'éditeur).
    const order = drags.map((d, k) => ({ d, k }))
    const options = (mix ? shuffle(order) : order).map(({ d, k }) => `<option value="${k + 1}">${plain(d).replace(/</g, '&lt;')}</option>`).join('')
    const rt: RichText = { ...(text ?? { text: '', files: [] }), text: (text?.text ?? '').replace(/\[\[(\d+)\]\]/g, (_, n) => `<select class="cz" data-dd="${n}"><option value=""></option>${options}</select>`) }
    return renderRt(rt)
  }, [])

  const check = () => {
    let fraction: number | null = null
    let answered = true
    if (type === 'multichoice' || type === 'truefalse') {
      const chosen = q.answers.filter((a) => picked.has(a.k))
      answered = chosen.length > 0
      const sum = chosen.reduce((s, a) => s + (parseFloat(a.fraction) || 0), 0) / 100
      fraction = Math.max(0, Math.min(1, sum))
    } else if (type === 'matching') {
      answered = rows.some((s) => pairs[s.k])
      fraction = rows.length ? rows.filter((s) => pairs[s.k] === s.answer.trim()).length / rows.length : 0
    } else if (type === 'shortanswer' || type === 'numerical') {
      answered = typed.trim() !== ''
      if (type === 'numerical') fraction = answered ? gradeNumerical(q, typed, unit).fraction : 0
      else fraction = answered ? (parseFloat(q.answers.find((a) => textMatches(a.rt.text, typed))?.fraction ?? '0') || 0) / 100 : 0
    } else if (type === 'cloze' && inline.current) {
      const root = inline.current
      let got = 0
      let total = 0
      answered = false
      parts.forEach((p, i) => {
        const g = gradeClozePart(p, root, i)
        got += g.fraction * p.weight
        total += p.weight
        answered ||= g.answered
        const el = root.querySelector<HTMLElement>(`[data-cz="${i}"]`)
        if (el) {
          el.classList.add(g.fraction >= 1 ? 'cz-ok' : g.fraction > 0 ? 'cz-part' : 'cz-bad')
          const right = p.options.filter((o) => o.fraction >= 100).map((o) => plain(o.text))
          el.title = [g.feedback && plain(g.feedback), right.length && 'Réponse attendue : ' + right.join(' ou ')].filter(Boolean).join(' — ')
        }
      })
      fraction = total ? got / total : 0
    } else if (type === 'ddwtos' && inline.current) {
      const selects = [...inline.current.querySelectorAll<HTMLSelectElement>('select[data-dd]')]
      answered = selects.some((s) => s.value)
      for (const s of selects) s.classList.add(s.value === s.dataset.dd ? 'cz-ok' : 'cz-bad')
      fraction = selects.length ? selects.filter((s) => s.value === s.dataset.dd).length / selects.length : 0
    }
    inline.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((el) => (el.disabled = true))
    setResult({ fraction, answered })
  }

  const done = result !== null
  const f = result?.fraction ?? null
  const state = !done ? 'Pas encore répondu' : f === null ? 'Terminé' : !result!.answered ? 'Non répondue' : f >= 0.999 ? 'Correct' : f > 0 ? 'Partiellement correct' : 'Incorrect'
  const stateClass = !done || f === null ? '' : f >= 0.999 ? 'ok' : f > 0 ? 'part' : 'bad'
  const combined = !done || f === null ? undefined : getText(q, f >= 0.999 ? 'correctfeedback' : f > 0 ? 'partiallycorrectfeedback' : 'incorrectfeedback')
  const rightAnswers = q.answers.filter((a) => (parseFloat(a.fraction) || 0) > 0)
  const answerLabel = (a: Answer) => (type === 'truefalse' ? (a.rt.text.trim() === 'true' ? 'Vrai' : 'Faux') : plain(a.rt.text))
  // Question numérique dont l'unité se choisit dans une liste.
  const unitSelect = type === 'numerical' && unitChoice(q) && (
    <select className="cz" value={unit} disabled={done} onChange={(e) => setUnit(e.target.value)}>
      <option value="">Unité…</option>
      {getUnits(q).map((u) => (
        <option key={u.name}>{u.name}</option>
      ))}
    </select>
  )
  const toggle = (a: Answer) => {
    if (done) return
    const next = new Set(type === 'truefalse' || single ? [] : picked)
    picked.has(a.k) && !(type === 'truefalse' || single) ? next.delete(a.k) : next.add(a.k)
    setPicked(next)
  }

  if (type === 'description')
    return (
      <div className="stu">
        <div className="stu-info">
          <div className="stu-no">Description</div>
        </div>
        <div className="stu-content">
          <div className="stu-formulation">
            <Html rt={text} />
          </div>
        </div>
      </div>
    )

  return (
    <div className="stu">
      <div className="stu-info">
        <div className="stu-no">
          Question <strong>{number}</strong>
        </div>
        <div className={'stu-state ' + stateClass}>{state}</div>
        <div className="stu-grade">{done && f !== null ? `Note de ${fr(f * max)} sur ${fr(max)}` : `Noté sur ${fr(max)}`}</div>
      </div>

      <div className="stu-content">
        <div className="stu-formulation">
          {interactiveText ? <div ref={inline} className="html" dangerouslySetInnerHTML={{ __html: inlineHtml }} /> : <Html rt={text} />}

          {(type === 'multichoice' || type === 'truefalse') && (
            <>
              {(type === 'truefalse' || isOn(getProp(q, 'showstandardinstruction'))) && <div className="stu-prompt">{type === 'truefalse' || single ? 'Veuillez choisir une réponse.' : 'Veuillez choisir au moins une réponse.'}</div>}
              <div className="stu-answers">
                {answers.map((a, i) => {
                  const on = picked.has(a.k)
                  const frac = parseFloat(a.fraction) || 0
                  return (
                    <label key={a.k} className={'stu-answer' + (done && on ? (frac > 0 ? ' ok' : ' bad') : '')}>
                      <input type={type === 'truefalse' || single ? 'radio' : 'checkbox'} checked={on} disabled={done} onChange={() => toggle(a)} />
                      {type !== 'truefalse' && numbering(getProp(q, 'answernumbering'), i) && <span className="stu-num">{numbering(getProp(q, 'answernumbering'), i)}</span>}
                      <div className="grow">
                        {type === 'truefalse' ? answerLabel(a) : <Html rt={a.rt} />}
                        {done && on && plain(a.feedback?.text) && <Html className="stu-specific" rt={a.feedback} />}
                      </div>
                      {done && on && <span className="stu-icon">{frac > 0 ? '✓' : '✗'}</span>}
                    </label>
                  )
                })}
              </div>
            </>
          )}

          {type === 'matching' && (
            <table className="stu-match">
              <tbody>
                {rows.map((s) => {
                  const good = pairs[s.k] === s.answer.trim()
                  return (
                    <tr key={s.k}>
                      <td>
                        <Html rt={s.rt} />
                      </td>
                      <td>
                        <select className={done ? (good ? 'cz-ok' : 'cz-bad') : ''} value={pairs[s.k] ?? ''} disabled={done} onChange={(e) => setPairs({ ...pairs, [s.k]: e.target.value })}>
                          <option value="">Choisir…</option>
                          {choices.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                        {done && <span className="stu-icon">{good ? ' ✓' : ' ✗'}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {(type === 'shortanswer' || type === 'numerical') && (
            <div className="stu-typed">
              <label>
                Réponse : {unitSelect && getProp(q, 'unitsleft') === '1' && unitSelect}
                <input className={done ? (f! >= 0.999 ? 'cz-ok' : f! > 0 ? 'cz-part' : 'cz-bad') : ''} value={typed} disabled={done} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && check()} />
                {unitSelect && getProp(q, 'unitsleft') !== '1' && unitSelect}
              </label>
            </div>
          )}

          {type === 'essay' && <textarea className="stu-essay" rows={8} disabled={done} placeholder="L’étudiant rédige sa réponse ici (correction manuelle)." />}
        </div>

        {done && (
          <div className="stu-outcome">
            {f !== null && <div className={'stu-verdict ' + stateClass}>{!result!.answered ? 'Aucune réponse donnée.' : state + '.'}</div>}
            {plain(combined?.text) && <Html rt={combined} />}
            {plain(getText(q, 'generalfeedback')?.text) && <Html rt={getText(q, 'generalfeedback')} />}
            {(type === 'multichoice' || type === 'truefalse') && rightAnswers.length > 0 && (
              <div className="stu-right">
                {rightAnswers.length > 1 ? 'Les réponses correctes sont : ' : 'La réponse correcte est : '}
                {rightAnswers.map(answerLabel).join(' ; ')}
              </div>
            )}
            {type === 'matching' && <div className="stu-right">La réponse correcte est : {rows.map((s) => `${plain(s.rt.text)} → ${s.answer}`).join(' ; ')}</div>}
            {(type === 'shortanswer' || type === 'numerical') && rightAnswers[0] && <div className="stu-right">La réponse correcte est : {rightAnswers[0].rt.text}</div>}
            {type === 'ddwtos' && <div className="stu-right">La réponse correcte est : {drags.map((d) => `[${plain(d)}]`).join(' ')}</div>}
            {type === 'cloze' && <div className="stu-right">Survolez chaque champ pour voir sa rétroaction et la réponse attendue.</div>}
          </div>
        )}

        <div className="stu-actions">
          {!done ? (
            <button className="primary" onClick={check}>
              Vérifier
            </button>
          ) : (
            <button onClick={onRetry}>Recommencer{mix ? ' (nouvel ordre)' : ''}</button>
          )}
          <span className="hint">Aperçu approché du rendu StudiUM : l’habillage exact dépend du thème et des réglages du test.</span>
        </div>
      </div>
    </div>
  )
}
