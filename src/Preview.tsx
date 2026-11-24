import { useMemo } from 'react'
import { renderRt } from './files'
import type { Issue } from './lint'
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
  const known = ['multichoice', 'truefalse', 'matching', 'cloze', 'description', 'shortanswer', 'numerical', 'essay'].includes(q.type)

  return (
    <div className="preview">
      <Html rt={getText(q, 'questiontext')} cloze={q.type === 'cloze'} showAnswers={showAnswers} />

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
                  <div className="html">{a.rt.text}</div>
                  {plain(a.feedback?.text) && <Html className="fb" rt={a.feedback} />}
                </div>
                <span className="frac">{pct(a.fraction)} %</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="blank">Réponse : ______________________</p>
        ))}

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
