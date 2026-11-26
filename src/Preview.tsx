import { useMemo } from 'react'
import { DdBoard } from './DdBoard'
import { readDd } from './ddimage'
import { dragBoxes, dropZones } from './dragbox'
import { renderRt } from './files'
import type { Issue } from './lint'
import { getUnits, unitMode } from './units'
import { type Question, type RichText, getProp, getText, plain, typeLabel } from './model'

export function Html({ rt, cloze, showAnswers, className }: { rt?: RichText; cloze?: boolean; showAnswers?: boolean; className?: string }) {
  const html = useMemo(() => renderRt(rt, { cloze, showAnswers }), [rt, cloze, showAnswers])
  if (!html) return null
  return <div className={'html ' + (className ?? '')} dangerouslySetInnerHTML={{ __html: html }} />
}

const pct = (f: string) => +(parseFloat(f) || 0).toFixed(2)
const TF: Record<string, string> = { true: 'Vrai', false: 'Faux' }

/** Aperçu d'une question telle que l'étudiant la voit, avec ou sans le corrigé. */
export function QuestionPreview({ q, showAnswers = true }: { q: Question; showAnswers?: boolean }) {
  const single = getProp(q, 'single') !== 'false'
  const general = getText(q, 'generalfeedback')
  const known = ['multichoice', 'truefalse', 'matching', 'cloze', 'description', 'shortanswer', 'numerical', 'essay', 'ddwtos', 'ddimageortext'].includes(q.type)
  // Glisser-déposer sur texte : chaque zone [[n]] montre le choix attendu.
  const statement = getText(q, 'questiontext')
  const drags = useMemo(() => (q.type === 'ddwtos' ? dragBoxes(q).map((b) => b.box) : []), [q])
  const body = useMemo(
    () =>
      q.type === 'ddwtos' && statement
        ? { ...statement, text: statement.text.replace(/\[\[(\d+)\]\]/g, (m, n) => (!drags[+n - 1] ? m : showAnswers ? `<span class="cloze"><span class="cloze-opt ok">${drags[+n - 1].text}</span></span>` : '<span class="cloze blank">__________</span>')) }
        : statement,
    [q, showAnswers],
  )
  const zones = q.type === 'ddwtos' ? dropZones(statement?.text ?? '') : []

  return (
    <div className="preview">
      <Html rt={body} cloze={q.type === 'cloze'} showAnswers={showAnswers} />

      {q.type === 'ddimageortext' && <DdImagePreview q={q} showAnswers={showAnswers} />}

      {q.type === 'ddwtos' && drags.length > 0 && (
        <p className="choices">
          Choix à déposer :{' '}
          {drags.map((b, i) => (
            <span key={i} className={'drag-chip' + (showAnswers && !zones.includes(i + 1) ? ' off' : '')} title={`Groupe ${b.group}` + (b.infinite ? ' · réutilisable' : '') + (zones.includes(i + 1) ? '' : ' · distracteur')}>
              <span dangerouslySetInnerHTML={{ __html: renderRt({ format: 'html', text: b.text, files: [] }) }} />
              {drags.some((x) => x.group !== b.group) && <small> g{b.group}</small>}
            </span>
          ))}
        </p>
      )}

      {(q.type === 'multichoice' || q.type === 'truefalse') && (
        <ul className="answers">
          {q.answers.map((a, i) => {
            const f = pct(a.fraction)
            const cls = !showAnswers ? '' : f >= 100 ? 'ok' : f > 0 ? 'part' : f < 0 ? 'neg' : ''
            return (
              <li key={a.k} className={cls}>
                <span className="mark">{q.type === 'truefalse' || single ? '○' : '☐'}</span>
                <span className="letter">{String.fromCharCode(97 + i)}.</span>
                <div className="grow">
                  {q.type === 'truefalse' ? <div className="html">{TF[a.rt.text.trim()] ?? a.rt.text}</div> : <Html rt={a.rt} />}
                  {showAnswers && plain(a.feedback?.text) && <Html className="fb" rt={a.feedback} />}
                </div>
                {showAnswers && f !== 0 && <span className="frac">{f} %</span>}
              </li>
            )
          })}
        </ul>
      )}

      {q.type === 'matching' && (
        <>
          <table className="matching">
            <tbody>
              {q.subquestions
                .filter((s) => plain(s.rt.text) || s.rt.files.length || showAnswers)
                .map((s) => (
                  <tr key={s.k}>
                    <td>
                      <Html rt={s.rt} />
                    </td>
                    <td className={showAnswers ? 'ok' : 'blank'}>{showAnswers ? s.answer : '______________'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!showAnswers && (
            <p className="choices">
              Choix : {[...new Set(q.subquestions.map((s) => s.answer.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr')).join(' · ')}
            </p>
          )}
        </>
      )}

      {(q.type === 'shortanswer' || q.type === 'numerical') &&
        (showAnswers ? (
          <ul className="answers">
            {q.answers.map((a) => (
              <li key={a.k} className={pct(a.fraction) >= 100 ? 'ok' : pct(a.fraction) > 0 ? 'part' : ''}>
                <div className="grow">
                  <div className="html">
                    {a.rt.text}
                    {q.type === 'numerical' && ` ± ${/<tolerance>([^<]*)<\/tolerance>/.exec(a.extra.join(''))?.[1] ?? '0'}`}
                  </div>
                  {plain(a.feedback?.text) && <Html className="fb" rt={a.feedback} />}
                </div>
                <span className="frac">{pct(a.fraction)} %</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="blank">Réponse : ______________________</p>
        ))}

      {q.type === 'numerical' && showAnswers && unitMode(q) !== 'none' && (
        <p className="choices">
          Unités :{' '}
          {getUnits(q)
            .map((u) => u.name + (parseFloat(u.multiplier) === 1 ? '' : ` (× ${u.multiplier})`))
            .join(' · ') || '(aucune)'}
          {unitMode(q) === 'graded' ? ` — exigée, pénalité ${+(parseFloat(getProp(q, 'unitpenalty') ?? '0') || 0).toFixed(3)}` : ' — facultative'}
        </p>
      )}

      {!known && <p className="hint">Type « {typeLabel(q.type)} » : aperçu partiel. La question est conservée telle quelle à l’export.</p>}

      {showAnswers && plain(general?.text) && (
        <div className="general">
          <div className="label">Rétroaction générale</div>
          <Html rt={general} />
        </div>
      )}
    </div>
  )
}

/** Glisser-déposer sur image : l'image avec ses zones, remplies quand le corrigé est affiché. */
function DdImagePreview({ q, showAnswers }: { q: Question; showAnswers: boolean }) {
  const model = useMemo(() => readDd(q), [q.extra])
  return <DdBoard model={model} mode={showAnswers ? 'answers' : 'student'} done={!showAnswers} />
}

export function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null
  return (
    <ul className="issues">
      {issues.map((i, k) => (
        <li key={k} className={i.level}>
          {i.msg}
        </li>
      ))}
    </ul>
  )
}
