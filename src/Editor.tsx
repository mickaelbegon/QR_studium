import { useEffect, useRef, useState } from 'react'
import { type DragBox, dragBoxXml, dragBoxes, dropZones } from './dragbox'
import { fileUrl, readAsBase64, registerFile, renderRt, unresolve } from './files'
import { lintQuestion } from './lint'
import { type Answer, type Category, type Question, type RichText, emptyRt, getProp, getText, setProp, setText, typeLabel, uid } from './model'
import { Issues, QuestionPreview } from './Preview'
import { type Unit, getUnits, isUnits, setUnitMode, setUnits, unitMode } from './units'

// ---- Éditeur de texte enrichi (HTML conservé tel quel tant qu'on n'y touche pas) ----

export function RichTextEditor({ value, onChange, compact, placeholder }: { value: RichText; onChange: (rt: RichText) => void; compact?: boolean; placeholder?: string }) {
  const el = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [source, setSource] = useState(false)
  const val = useRef(value)
  val.current = value

  useEffect(() => {
    if (!source && el.current) el.current.innerHTML = renderRt(val.current, { math: false })
  }, [source])

  const emit = () => {
    let html = el.current!.innerHTML
    if (html === '<br>' || html === '<p><br></p>') html = ''
    const next = { ...val.current, text: unresolve(html, val.current) }
    val.current = next
    onChange(next)
  }
  const cmd = (name: string, arg?: string) => {
    el.current!.focus()
    document.execCommand(name, false, arg)
    emit()
  }
  const addImage = async (file: File) => {
    const hash = await registerFile(await readAsBase64(file))
    let name = file.name.replace(/[\\/]/g, '_')
    while (val.current.files.some((f) => f.name === name)) name = name.replace(/(\.[^.]*)?$/, '_1$1')
    const ref = { name, path: '/', encoding: 'base64', hash }
    val.current = { ...val.current, files: [...val.current.files, ref] }
    cmd('insertHTML', `<img src="${fileUrl(ref)}" alt="">`)
  }
  const btn = (label: string, title: string, action: () => void) => (
    <button type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={action}>
      {label}
    </button>
  )

  return (
    <div className={'rte' + (compact ? ' compact' : '')}>
      <div className="rte-bar">
        {!source && (
          <>
            {btn('G', 'Gras', () => cmd('bold'))}
            {btn('I', 'Italique', () => cmd('italic'))}
            {btn('S', 'Souligné', () => cmd('underline'))}
            {btn('x²', 'Exposant', () => cmd('superscript'))}
            {btn('x₂', 'Indice', () => cmd('subscript'))}
            {btn('• Liste', 'Liste à puces', () => cmd('insertUnorderedList'))}
            {btn('1. Liste', 'Liste numérotée', () => cmd('insertOrderedList'))}
            {btn('Image', 'Insérer une image', () => fileInput.current?.click())}
            {btn('Sans mise en forme', 'Retirer la mise en forme de la sélection', () => cmd('removeFormat'))}
          </>
        )}
        <span className="grow" />
        {btn(source ? 'Éditeur visuel' : 'HTML', 'Basculer entre l’éditeur visuel et le code HTML', () => setSource(!source))}
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && addImage(e.target.files[0]).then(() => (e.target.value = ''))} />
      </div>
      {source ? (
        <textarea className="rte-src" value={value.text} spellCheck={false} onChange={(e) => onChange({ ...value, text: e.target.value })} />
      ) : (
        <div ref={el} className="rte-body html" contentEditable suppressContentEditableWarning data-placeholder={placeholder ?? ''} onInput={emit} />
      )}
    </div>
  )
}

// ---- Éditeur de question ----

const FRACTIONS = ['100', '50', '33.33333', '25', '20', '0', '-25', '-33.33333', '-50', '-100']

function FractionSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const known = FRACTIONS.some((f) => parseFloat(f) === parseFloat(value))
  return (
    <select className="fraction" value={known ? String(FRACTIONS.find((f) => parseFloat(f) === parseFloat(value))) : value} onChange={(e) => onChange(e.target.value)} title="Fraction de la note">
      {!known && <option value={value}>{+(+value).toFixed(3)} %</option>}
      {FRACTIONS.map((f) => (
        <option key={f} value={f}>
          {+(+f).toFixed(2)} %
        </option>
      ))}
    </select>
  )
}

const TOL = /<tolerance>([^<]*)<\/tolerance>/
export const tolerance = (a: Answer): string => a.extra.map((x) => TOL.exec(x)?.[1]).find((t) => t !== undefined) ?? ''
function setTolerance(a: Answer, value: string) {
  const xml = `<tolerance>${value.replace(/[<&]/g, '')}</tolerance>`
  const i = a.extra.findIndex((x) => TOL.test(x))
  if (i >= 0) a.extra[i] = xml
  else a.extra.push(xml)
}

const newAnswer = (format: string | undefined): Answer => ({ k: uid(), fraction: '0', rt: emptyRt(format), feedback: emptyRt('html'), extra: [] })

export function QuestionEditor({ question, categories, onSave, onCancel, onDirty }: { question: Question; categories: Category[]; onSave: (q: Question, note: string) => void; onCancel: () => void; onDirty: () => void }) {
  const [d, setD] = useState<Question>(() => structuredClone(question))
  const [note, setNote] = useState('')
  const mut = (fn: (q: Question) => void) => {
    setD((prev) => {
      const c = structuredClone(prev)
      fn(c)
      return c
    })
    onDirty()
  }
  const latest = useRef({ d, note })
  latest.current = { d, note }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        onSave(latest.current.d, latest.current.note)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onSave])

  const prop = (tag: string, label: string, width = 90) =>
    getProp(d, tag) !== undefined && (
      <label>
        {label}
        <input style={{ width }} value={getProp(d, tag)} onChange={(e) => mut((q) => setProp(q, tag, e.target.value))} />
      </label>
    )
  const text = (tag: string, label: string, compact = false) => {
    const rt = getText(d, tag)
    return (
      rt && (
        <div className="field">
          <div className="label">{label}</div>
          <RichTextEditor compact={compact} value={rt} onChange={(v) => mut((q) => setText(q, tag, v))} />
        </div>
      )
    )
  }
  const check = (tag: string, label: string, on = 'true', off = 'false') =>
    getProp(d, tag) !== undefined && (
      <label className="check">
        <input type="checkbox" checked={getProp(d, tag) === on || getProp(d, tag) === '1'} onChange={(e) => mut((q) => setProp(q, tag, e.target.checked ? on : off))} />
        {label}
      </label>
    )

  const single = getProp(d, 'single') !== 'false'
  const markCorrect = (k: string) =>
    mut((q) => {
      for (const a of q.answers) {
        if (a.k === k) a.fraction = '100'
        else if (single || q.type === 'truefalse') a.fraction = '0'
      }
    })
  // ---- Glisser-déposer sur texte : choix à déposer ----
  const boxes = d.type === 'ddwtos' ? dragBoxes(d) : []
  const zones = d.type === 'ddwtos' ? dropZones(getText(d, 'questiontext')?.text ?? '') : []
  const setBox = (i: number, box: DragBox) => mut((q) => (q.extra[i] = dragBoxXml(box)))
  const addBox = () =>
    mut((q) => {
      const last = dragBoxes(q).pop()
      q.extra.splice(last ? last.i + 1 : q.extra.length, 0, dragBoxXml({ text: '', group: last?.box.group ?? '1', infinite: false }))
    })
  /** Retire un choix inutilisé et décale les numéros [[n]] qui le suivent dans l'énoncé. */
  const removeBox = (i: number, n: number) =>
    mut((q) => {
      q.extra.splice(i, 1)
      const rt = getText(q, 'questiontext')
      if (rt) setText(q, 'questiontext', { ...rt, text: rt.text.replace(/\[\[(\d+)\]\]/g, (m, k) => (+k > n ? `[[${+k - 1}]]` : m)) })
    })
  /** Réglage que l'éditeur ne sait pas encore modifier (conservé tel quel). */
  // ---- Question numérique : unités ----
  const units = d.type === 'numerical' ? getUnits(d) : []
  const uMode = d.type === 'numerical' ? unitMode(d) : 'none'
  const editUnits = (fn: (u: Unit[]) => void) =>
    mut((q) => {
      const u = getUnits(q)
      fn(u)
      setUnits(q, u)
    })
  const locked = d.extra.some((x) => !(d.type === 'ddwtos' && /^<dragbox[\s>]/.test(x)) && !(d.type === 'numerical' && isUnits(x))) || d.answers.some((a) => a.extra.some((x) => !TOL.test(x)))

  const positiveSum = d.answers.map((a) => parseFloat(a.fraction) || 0).filter((f) => f > 0).reduce((a, b) => a + b, 0)

  return (
    <div className="editor-wrap">
      <div className="editor">
        <div className="row">
          <label className="grow">
            Nom de la question
            <input value={getText(d, 'name')?.text ?? ''} onChange={(e) => mut((q) => setText(q, 'name', { ...(getText(q, 'name') ?? { files: [] }), text: e.target.value }))} />
          </label>
          <span className="type-tag">{typeLabel(d.type)}</span>
        </div>
        <div className="row">
          <label className="grow">
            Catégorie (chemin StudiUM)
            <input list="cats" value={d.category} onChange={(e) => mut((q) => (q.category = e.target.value))} />
          </label>
          <datalist id="cats">
            {categories.map((c) => (
              <option key={c.path} value={c.path} />
            ))}
          </datalist>
        </div>
        <div className="row">
          {prop('defaultgrade', 'Points')}
          {prop('penalty', 'Pénalité par essai')}
          {prop('idnumber', 'Numéro d’identification', 150)}
          <label className="grow">
            Étiquettes (séparées par des virgules)
            <input
              value={d.tags.join(', ')}
              onChange={(e) =>
                mut((q) => {
                  q.tags = e.target.value.split(',').map((t) => t.trimStart())
                })
              }
              onBlur={() => mut((q) => (q.tags = q.tags.map((t) => t.trim()).filter(Boolean)))}
            />
          </label>
        </div>

        {text('questiontext', 'Énoncé')}
        {d.type === 'cloze' && (
          <p className="hint">
            Syntaxe des trous : <code>{'{1:MULTICHOICE:=bonne réponse#rétroaction~mauvaise~%50%partielle}'}</code>, <code>{'{1:SHORTANSWER:=réponse}'}</code>,{' '}
            <code>{'{1:NUMERICAL:=9.81:0.1}'}</code>. Le chiffre initial est le poids du trou ; l’aperçu à droite se met à jour en direct.
          </p>
        )}

        {d.type === 'ddwtos' && (
          <div className="field">
            <div className="label">Choix à déposer</div>
            <p className="hint">
              Dans l’énoncé, <code>[[1]]</code> marque la zone qui attend le choix 1, <code>[[2]]</code> le choix 2, etc. Un choix sans zone sert de distracteur. Un choix ne se dépose que dans les zones de son groupe (une couleur par groupe dans StudiUM).
            </p>
            {boxes.map(({ i, box }, k) => {
              const n = k + 1
              const used = zones.includes(n)
              return (
                <div className="drag-row" key={i}>
                  <code className={used ? 'used' : ''} title={used ? 'Bonne réponse de la zone [[' + n + ']]' : 'Distracteur : aucune zone [[' + n + ']] dans l’énoncé'}>
                    [[{n}]]
                  </code>
                  <input className="grow" value={box.text} placeholder="Texte du choix" onChange={(e) => setBox(i, { ...box, text: e.target.value })} />
                  <select value={box.group} title="Groupe" onChange={(e) => setBox(i, { ...box, group: e.target.value })}>
                    {[...new Set(['1', '2', '3', '4', '5', '6', '7', '8', box.group])].map((g) => (
                      <option key={g} value={g}>
                        Groupe {g}
                      </option>
                    ))}
                  </select>
                  <label className="check" title="Le choix reste disponible après avoir été déposé : il peut servir dans plusieurs zones">
                    <input type="checkbox" checked={box.infinite} onChange={(e) => setBox(i, { ...box, infinite: e.target.checked })} />
                    Réutilisable
                  </label>
                  <button className="danger" disabled={used} title={used ? 'Retirez d’abord [[' + n + ']] de l’énoncé' : 'Supprimer ce choix (les numéros suivants sont décalés dans l’énoncé)'} onClick={() => removeBox(i, n)}>
                    ✕
                  </button>
                </div>
              )
            })}
            {zones.some((z) => z < 1 || z > boxes.length) && (
              <ul className="issues">
                <li className="error">L’énoncé contient {[...new Set(zones.filter((z) => z < 1 || z > boxes.length))].map((z) => `[[${z}]]`).join(', ')} sans choix correspondant.</li>
              </ul>
            )}
            <div>
              <button onClick={addBox}>+ Ajouter un choix</button>
            </div>
          </div>
        )}

        {d.type === 'multichoice' && (
          <div className="row">
            <label>
              Nombre de réponses
              <select value={single ? 'true' : 'false'} onChange={(e) => mut((q) => setProp(q, 'single', e.target.value))}>
                <option value="true">Une seule réponse</option>
                <option value="false">Plusieurs réponses</option>
              </select>
            </label>
            {getProp(d, 'answernumbering') !== undefined && (
              <label>
                Numérotation
                <select value={getProp(d, 'answernumbering')} onChange={(e) => mut((q) => setProp(q, 'answernumbering', e.target.value))}>
                  {['abc', 'ABCD', '123', 'iii', 'IIII', 'none'].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
            )}
            {check('shuffleanswers', 'Mélanger les choix')}
            {!single && <span className={'sum ' + (Math.abs(positiveSum - 100) > 0.5 ? 'bad' : 'good')}>Somme des fractions positives : {+positiveSum.toFixed(2)} %</span>}
          </div>
        )}

        {(d.type === 'multichoice' || d.type === 'shortanswer' || d.type === 'numerical') && (
          <div className="field">
            <div className="label">{d.type === 'multichoice' ? 'Choix de réponse' : 'Réponses acceptées'}</div>
            {d.answers.map((a, i) => (
              <div key={a.k} className={'answer-edit' + (parseFloat(a.fraction) >= 100 ? ' ok' : '')}>
                <div className="answer-head">
                  <button type="button" className={'tick' + (parseFloat(a.fraction) >= 100 ? ' on' : '')} title="Marquer comme bonne réponse (100 %)" onClick={() => markCorrect(a.k)}>
                    ✓
                  </button>
                  <strong>{i + 1}</strong>
                  <FractionSelect value={a.fraction} onChange={(v) => mut((q) => (q.answers[i].fraction = v))} />
                  <span className="grow" />
                  <button type="button" disabled={i === 0} title="Monter" onClick={() => mut((q) => q.answers.splice(i - 1, 0, ...q.answers.splice(i, 1)))}>
                    ↑
                  </button>
                  <button type="button" disabled={i === d.answers.length - 1} title="Descendre" onClick={() => mut((q) => q.answers.splice(i + 1, 0, ...q.answers.splice(i, 1)))}>
                    ↓
                  </button>
                  <button type="button" className="danger" title="Supprimer ce choix" onClick={() => mut((q) => q.answers.splice(i, 1))}>
                    ✕
                  </button>
                </div>
                {d.type === 'multichoice' ? (
                  <RichTextEditor compact placeholder="Texte du choix" value={a.rt} onChange={(v) => mut((q) => (q.answers[i].rt = v))} />
                ) : (
                  <div className="row">
                    <input className="grow" placeholder="Réponse" value={a.rt.text} onChange={(e) => mut((q) => (q.answers[i].rt.text = e.target.value))} />
                    {d.type === 'numerical' && (
                      <label>
                        Tolérance (±)
                        <input style={{ width: 90 }} value={tolerance(a)} onChange={(e) => mut((q) => setTolerance(q.answers[i], e.target.value))} />
                      </label>
                    )}
                  </div>
                )}
                <RichTextEditor compact placeholder="Rétroaction pour ce choix (facultative)" value={a.feedback ?? emptyRt('html')} onChange={(v) => mut((q) => (q.answers[i].feedback = v))} />
              </div>
            ))}
            <button type="button" onClick={() => mut((q) => q.answers.push(newAnswer(q.answers[0]?.rt.format ?? 'html')))}>
              + Ajouter une réponse
            </button>
          </div>
        )}

        {d.type === 'numerical' && (
          <div className="field">
            <div className="label">Unités</div>
            <div className="row">
              <label>
                Gestion des unités
                <select value={uMode} onChange={(e) => mut((q) => setUnitMode(q, e.target.value as 'none' | 'optional' | 'graded'))}>
                  <option value="none">Pas d’unité : le nombre seul</option>
                  <option value="optional">Unité facultative, non notée</option>
                  <option value="graded">Unité exigée et notée</option>
                </select>
              </label>
              {uMode === 'graded' && (
                <>
                  <label title="Part de la note retirée quand l’unité est absente (entre 0 et 1)">
                    Pénalité d’unité
                    <input style={{ width: 80 }} value={getProp(d, 'unitpenalty') ?? ''} onChange={(e) => mut((q) => setProp(q, 'unitpenalty', e.target.value))} />
                  </label>
                  <label>
                    Pénalité calculée sur
                    <select value={getProp(d, 'unitgradingtype') === '2' ? '2' : '1'} onChange={(e) => mut((q) => setProp(q, 'unitgradingtype', e.target.value))}>
                      <option value="1">la note obtenue</option>
                      <option value="2">la note de la question</option>
                    </select>
                  </label>
                  <label>
                    Saisie de l’unité
                    <select value={getProp(d, 'showunits') ?? '0'} onChange={(e) => mut((q) => setProp(q, 'showunits', e.target.value))}>
                      <option value="0">tapée après le nombre</option>
                      <option value="1">boutons radio</option>
                      <option value="2">menu déroulant</option>
                    </select>
                  </label>
                </>
              )}
              {uMode !== 'none' && (
                <label>
                  Position de l’unité
                  <select value={getProp(d, 'unitsleft') === '1' ? '1' : '0'} onChange={(e) => mut((q) => setProp(q, 'unitsleft', e.target.value))}>
                    <option value="0">à droite (9,81 m)</option>
                    <option value="1">à gauche ($ 9,81)</option>
                  </select>
                </label>
              )}
            </div>
            {uMode !== 'none' && (
              <>
                <p className="hint">
                  Les réponses acceptées ci-dessus sont exprimées dans l’unité de multiplicateur 1. Une autre unité convertit la réponse : pour une bonne réponse de 5 m, l’unité cm avec le multiplicateur 100 fait accepter « 500 cm ».
                </p>
                {units.map((u, i) => (
                  <div className="drag-row" key={i}>
                    <input style={{ width: 130 }} value={u.name} placeholder="Unité (ex. m)" onChange={(e) => editUnits((all) => (all[i].name = e.target.value))} />
                    <label className="check">
                      Multiplicateur
                      <input style={{ width: 100 }} value={u.multiplier} onChange={(e) => editUnits((all) => (all[i].multiplier = e.target.value))} />
                    </label>
                    <span className="grow" />
                    <button className="danger" title="Supprimer cette unité" onClick={() => editUnits((all) => all.splice(i, 1))}>
                      ✕
                    </button>
                  </div>
                ))}
                {(() => {
                  const bad = [!units.length && 'Aucune unité définie.', units.some((u) => !u.name.trim()) && 'Une unité n’a pas de nom.', units.some((u) => !(parseFloat(u.multiplier) > 0)) && 'Un multiplicateur doit être un nombre positif.', new Set(units.map((u) => u.name.trim())).size < units.length && 'Deux unités portent le même nom.'].filter(Boolean)
                  return bad.length > 0 && (
                    <ul className="issues">
                      {bad.map((b) => (
                        <li key={String(b)} className="error">
                          {b}
                        </li>
                      ))}
                    </ul>
                  )
                })()}
                <div>
                  <button onClick={() => editUnits((all) => all.push({ name: '', multiplier: all.length ? '' : '1' }))}>+ Ajouter une unité</button>
                </div>
              </>
            )}
          </div>
        )}

        {d.type === 'truefalse' && (
          <div className="field">
            <div className="label">Bonne réponse</div>
            {d.answers.map((a, i) => (
              <div key={a.k} className={'answer-edit' + (parseFloat(a.fraction) >= 100 ? ' ok' : '')}>
                <label className="check">
                  <input type="radio" name="tf" checked={parseFloat(a.fraction) >= 100} onChange={() => markCorrect(a.k)} />
                  <strong>{a.rt.text.trim() === 'true' ? 'Vrai' : 'Faux'}</strong>
                </label>
                <RichTextEditor compact placeholder="Rétroaction si l’étudiant choisit cette réponse" value={a.feedback ?? emptyRt('html')} onChange={(v) => mut((q) => (q.answers[i].feedback = v))} />
              </div>
            ))}
          </div>
        )}

        {d.type === 'matching' && (
          <div className="field">
            <div className="label">Paires (une réponse sans question sert de distracteur)</div>
            {d.subquestions.map((s, i) => (
              <div key={s.k} className="answer-edit pair">
                <RichTextEditor compact placeholder="Question" value={s.rt} onChange={(v) => mut((q) => (q.subquestions[i].rt = v))} />
                <span className="arrow">→</span>
                <input placeholder="Réponse" value={s.answer} onChange={(e) => mut((q) => (q.subquestions[i].answer = e.target.value))} />
                <button type="button" className="danger" title="Supprimer cette paire" onClick={() => mut((q) => q.subquestions.splice(i, 1))}>
                  ✕
                </button>
              </div>
            ))}
            <div className="row">
              <button type="button" onClick={() => mut((q) => q.subquestions.push({ k: uid(), rt: emptyRt(q.subquestions[0]?.rt.format ?? 'html'), answer: '', extra: [] }))}>
                + Ajouter une paire
              </button>
              {check('shuffleanswers', 'Mélanger les questions')}
            </div>
          </div>
        )}

        {text('generalfeedback', 'Rétroaction générale')}

        {getText(d, 'correctfeedback') && (
          <details>
            <summary>Rétroactions combinées (correct, partiel, incorrect)</summary>
            {text('correctfeedback', 'Réponse correcte', true)}
            {text('partiallycorrectfeedback', 'Réponse partiellement correcte', true)}
            {text('incorrectfeedback', 'Réponse incorrecte', true)}
          </details>
        )}
        {locked && <p className="hint">Cette question contient des réglages avancés non modifiables ici ; ils sont conservés tels quels à l’export.</p>}
      </div>

      <div className="editor-side">
        <div className="label">Aperçu en direct</div>
        <QuestionPreview q={d} />
        <Issues issues={lintQuestion(d)} />
      </div>

      <div className="editor-foot">
        <input className="grow" placeholder="Note de modification (facultative), ex. « distracteur c reformulé après l’intra »" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" onClick={onCancel}>
          Annuler
        </button>
        <button type="button" className="primary" onClick={() => onSave(d, note)} title="Ctrl+S">
          Enregistrer
        </button>
      </div>
    </div>
  )
}
