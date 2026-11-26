import { useState } from 'react'
import { parseCloze } from './cloze'
import { type Exam, type Question, getProp, getText, qName, typeShort, uid } from './model'
import { QuestionPreview } from './Preview'
import type { Bank } from './store'

/** Points de la question ; pour un cloze sans note explicite, c'est la somme des poids des trous. */
import { ExamChart } from './ExamChart'
import { LEVELS, levelCounts, levelInfo, levelOf } from './levels'
import { fmtMin, scoreLabel, stats } from './scores'
export function points(q: Question): number {
  const grade = getProp(q, 'defaultgrade')
  if (grade === undefined && q.type === 'cloze') return parseCloze(getText(q, 'questiontext')?.text ?? '').reduce((s, p) => s + p.weight, 0)
  return parseFloat(grade ?? '0') || 0
}

/** Assemblage d'examens : choisir, ordonner, exporter vers StudiUM ou imprimer. */
export function ExamsView({ bank, examId, setExamId, onExport, onPrint }: { bank: Bank; examId: string | null; setExamId: (id: string | null) => void; onExport: (e: Exam) => void; onPrint: (e: Exam, corrige: boolean) => void }) {
  const [sel, setSel] = useState<string | null>(null)
  const exam = bank.exams.find((e) => e.id === examId) ?? null
  const byId = new Map(bank.questions.map((q) => [q.id, q]))
  const items = exam ? exam.items.map((id) => byId.get(id)).filter((q): q is Question => !!q) : []
  const selected = items.find((q) => q.id === sel) ?? items[0] ?? null
  const total = items.reduce((s, q) => s + points(q), 0)
  const st = stats(items, points)
  const lv = levelCounts(items)

  const create = async () => {
    const name = prompt('Nom de l’examen :', 'Nouvel examen')
    if (!name) return
    const e: Exam = { id: uid(), name, items: [], created: Date.now() }
    await bank.saveExam(e)
    setExamId(e.id)
  }
  const move = (i: number, d: number) => {
    if (!exam) return
    const list = [...exam.items]
    list.splice(i + d, 0, ...list.splice(i, 1))
    bank.saveExam({ ...exam, items: list })
  }

  return (
    <main className="layout">
      <aside className="sidebar">
        <div className="side-title">Examens</div>
        {bank.exams.map((e) => (
          <button key={e.id} className={'cat' + (e.id === examId ? ' active' : '')} onClick={() => setExamId(e.id)}>
            <span className="grow">{e.name}</span>
            <span className="count">{e.items.length}</span>
          </button>
        ))}
        {!bank.exams.length && <p className="hint">Aucun examen pour l’instant.</p>}
        <button className="primary block" onClick={create}>
          + Nouvel examen
        </button>
      </aside>

      <section className="list">
        {exam ? (
          <>
            <div className="list-head">
              <div className="row">
                <strong className="grow exam-name">{exam.name}</strong>
                <button
                  onClick={() => {
                    const name = prompt('Nouveau nom :', exam.name)
                    if (name) bank.saveExam({ ...exam, name })
                  }}
                >
                  Renommer
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    if (confirm(`Supprimer l’examen « ${exam.name} » ? Les questions restent dans la banque.`)) {
                      bank.removeExam(exam.id)
                      setExamId(null)
                    }
                  }}
                >
                  Supprimer
                </button>
              </div>
              <div className="row">
                <span className="grow">
                  {items.length} question{items.length > 1 ? 's' : ''} · {+total.toFixed(2)} point{total > 1 ? 's' : ''}
                </span>
                <button disabled={!items.length} onClick={() => onPrint(exam, false)}>
                  Imprimer
                </button>
                <button disabled={!items.length} onClick={() => onPrint(exam, true)}>
                  Imprimer le corrigé
                </button>
                <button className="primary" disabled={!items.length} onClick={() => onExport(exam)}>
                  Exporter pour StudiUM
                </button>
              </div>
            </div>
            {items.length > 0 && (
              <div className="exam-summary">
                <div>
                  <strong>Difficulté moyenne : {st.mean !== null ? st.mean.toLocaleString('fr-CA', { maximumFractionDigits: 1 }) + ' / 5' : '—'}</strong>
                  {st.weighted !== null && st.mean !== null && Math.abs(st.weighted - st.mean) >= 0.05 && <span className="hint"> (pondérée par les points : {st.weighted.toLocaleString('fr-CA', { maximumFractionDigits: 1 })})</span>}
                  {st.noDifficulty > 0 && <span className="hint"> · {st.noDifficulty} question{st.noDifficulty > 1 ? 's' : ''} sans difficulté</span>}
                </div>
                <div>
                  <strong>Temps total estimé : {st.minutes ? fmtMin(st.minutes) : '—'}</strong>
                  {st.noMinutes > 0 && <span className="hint"> · {st.noMinutes} question{st.noMinutes > 1 ? 's' : ''} sans temps</span>}
                </div>
                {lv.none < items.length && (
                  <div className="levels" title="Nombre de questions par niveau cognitif">
                    {LEVELS.map((l, i) => (
                      <span key={l.key} className="level" title={l.hint}>
                        {l.label} : {lv.counts[i]}
                      </span>
                    ))}
                    {lv.none > 0 && <span className="hint">sans niveau : {lv.none}</span>}
                  </div>
                )}
                {st.mean !== null && (
                  <div className="levels" title="Nombre de questions par niveau de difficulté">
                    {[1, 2, 3, 4, 5].map((d) => (
                      <span key={d} className={'score d' + d}>
                        D{d} : {st.levels[d]}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            <ExamChart key={exam.id} items={items} points={points} />
            <div className="rows">
              {items.map((q, i) => (
                <div key={q.id} className={'q-row' + (selected?.id === q.id ? ' active' : '')} onClick={() => setSel(q.id)}>
                  <span className="num">{i + 1}</span>
                  <span className={'badge t-' + q.type}>{typeShort(q.type)}</span>
                  <span className="grow q-name">{qName(q)}</span>
                  {levelOf(q) && <span className="level">{levelInfo(levelOf(q))!.short}</span>}
                  {scoreLabel(q) && <span className={'score d' + (q.meta.difficulty ?? 0)}>{scoreLabel(q)}</span>}
                  <span className="count">{+points(q).toFixed(2)} pt</span>
                  <button disabled={i === 0} title="Monter" onClick={(e) => (e.stopPropagation(), move(i, -1))}>
                    ↑
                  </button>
                  <button disabled={i === items.length - 1} title="Descendre" onClick={(e) => (e.stopPropagation(), move(i, 1))}>
                    ↓
                  </button>
                  <button title="Retirer de l’examen" onClick={(e) => (e.stopPropagation(), bank.saveExam({ ...exam, items: exam.items.filter((id) => id !== q.id) }))}>
                    ✕
                  </button>
                </div>
              ))}
              {!items.length && <p className="hint pad">Dans l’onglet « Banque », cliquez sur « + » à côté d’une question pour l’ajouter à cet examen.</p>}
            </div>
          </>
        ) : (
          <p className="hint pad">Choisissez ou créez un examen.</p>
        )}
      </section>

      <section className="detail">
        {selected ? (
          <div className="detail-body">
            <h2>{qName(selected)}</h2>
            <QuestionPreview q={selected} />
          </div>
        ) : (
          <p className="hint pad">Sélectionnez une question pour la prévisualiser.</p>
        )}
      </section>
    </main>
  )
}

/** Version imprimable (masquée à l'écran, affichée par la boîte d'impression du navigateur). */
export function PrintSheet({ exam, questions, corrige }: { exam: Exam; questions: Question[]; corrige: boolean }) {
  let n = 0
  const total = questions.reduce((s, q) => s + points(q), 0)
  return (
    <div className="print-root">
      <h1>
        {exam.name}
        {corrige ? ' (corrigé)' : ''}
      </h1>
      <p className="print-meta">{corrige ? `Total : ${+total.toFixed(2)} points` : `Nom : ____________________________   Matricule : ______________   Total : ${+total.toFixed(2)} points`}</p>
      {questions.map((q) => (
        <div key={q.id} className="print-q">
          {q.type !== 'description' && (
            <div className="print-head">
              Question {++n} <span>({+points(q).toFixed(2)} pt)</span>
            </div>
          )}
          <QuestionPreview q={q} showAnswers={corrige} />
        </div>
      ))}
    </div>
  )
}
