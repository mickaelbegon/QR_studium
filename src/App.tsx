import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as db from './db'
import { QuestionEditor } from './Editor'
import { ExamsView, PrintSheet, points } from './Exams'
import { fileData } from './files'
import { type Issue, findDuplicates, lintQuestion, worst } from './lint'
import { CREATABLE, type Exam, type Question, SEP, emptyRt, setProp, setText, uid, STATUS, type Status, type Version, categoryKey, categoryLabel, categoryParts, fold, getProp, getText, newQuestion, plain, qName, searchText, typeLabel, typeShort } from './model'
import { serializeBank } from './moodleXml'
import { Issues, QuestionPreview } from './Preview'
import { type Report, type Suggestion, exportReport } from './report'
import { DIRECTIONS, PERTINENCES, ReportView, ReviewBox, directionClass } from './ReviewPanel'
import { useBank } from './store'

function download(name: string, xml: string, type = 'application/xml') {
  const url = URL.createObjectURL(new Blob([xml], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Horodatage en heure locale pour les noms de fichiers exportés. */
const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
const fileSafe = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'questions'
const AUTO_KEY = 'qr.auto'
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

export default function App() {
  const bank = useBank()
  const { questions, categories, exams, reports } = bank
  const [view, setView] = useState<'bank' | 'exams' | 'report'>('bank')
  const [fPert, setFPert] = useState('')
  const [fDir, setFDir] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const dirty = useRef(false)
  const [tab, setTab] = useState<'preview' | 'history'>('preview')
  const [query, setQuery] = useState('')
  const [fType, setFType] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fIssues, setFIssues] = useState(false)
  const [cat, setCat] = useState<string | null>(null)
  const [examId, setExamIdRaw] = useState<string | null>(() => {
    try {
      return localStorage.getItem('qr.exam')
    } catch {
      return null
    }
  })
  const [print, setPrint] = useState<{ exam: Exam; corrige: boolean } | null>(null)
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  const setExamId = (id: string | null) => {
    setExamIdRaw(id)
    try {
      id ? localStorage.setItem('qr.exam', id) : localStorage.removeItem('qr.exam')
    } catch {
      /* préférence non mémorisée */
    }
  }
  const say = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 5000)
  }

  // ---- Index de recherche, alertes, arborescence ----
  const index = useMemo(() => new Map(questions.map((q) => [q.id, searchText(q)])), [questions])
  const issues = useMemo(() => {
    const dup = findDuplicates(questions)
    return new Map<string, Issue[]>(questions.map((q) => [q.id, lintQuestion(q, dup)]))
  }, [questions])

  const tree = useMemo(() => {
    const nodes = new Map<string, { key: string; label: string; depth: number; count: number }>()
    for (const path of [...categories.map((c) => c.path), ...questions.map((q) => q.category)]) {
      const parts = categoryParts(path)
      parts.forEach((label, i) => {
        const key = parts.slice(0, i + 1).join(SEP)
        if (!nodes.has(key)) nodes.set(key, { key, label, depth: i, count: 0 })
      })
    }
    for (const q of questions) {
      const parts = categoryParts(q.category)
      parts.forEach((_, i) => nodes.get(parts.slice(0, i + 1).join(SEP))!.count++)
    }
    return [...nodes.values()].sort((a, b) => a.key.localeCompare(b.key, 'fr'))
  }, [questions, categories])

  const filtered = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean)
    return questions.filter((q) => {
      if (fType && q.type !== fType) return false
      if (fStatus && (q.meta.status || 'aucun') !== fStatus) return false
      if (fIssues && !worst(issues.get(q.id) ?? [])) return false
      if (fPert && (q.meta.review?.pertinence ?? '') !== fPert) return false
      if (fDir && (q.meta.review?.direction ?? '') !== fDir) return false
      if (cat !== null) {
        const key = categoryKey(q.category)
        if (key !== cat && !key.startsWith(cat + SEP)) return false
      }
      const text = index.get(q.id) ?? ''
      return words.every((w) => text.includes(w))
    })
  }, [questions, query, fType, fStatus, fIssues, fPert, fDir, cat, index, issues])

  const current = questions.find((q) => q.id === sel) ?? null
  const exam = exams.find((e) => e.id === examId) ?? null
  const types = useMemo(() => [...new Set(questions.map((q) => q.type))], [questions])

  // ---- Actions ----
  const leaveEdit = () => {
    if (editing && dirty.current && !confirm('Abandonner les modifications non enregistrées ?')) return false
    setEditing(false)
    dirty.current = false
    return true
  }
  const select = (id: string) => {
    if (id === sel || !leaveEdit()) return
    setSel(id)
    setTab('preview')
  }

  const importFiles = async (files: File[]) => {
    const xml = files.filter((f) => f.name.toLowerCase().endsWith('.xml'))
    const json = files.filter((f) => f.name.toLowerCase().endsWith('.json'))
    if (!xml.length && !json.length) return say('Aucun fichier .xml ou .json à importer.')
    setBusy(true)
    try {
      const msgs: string[] = []
      if (xml.length) {
        const r = await bank.importXml(xml)
        msgs.push(`${r.added} question${r.added > 1 ? 's' : ''} importée${r.added > 1 ? 's' : ''}` + (r.skipped ? `, ${r.skipped} déjà présente${r.skipped > 1 ? 's' : ''} ignorée${r.skipped > 1 ? 's' : ''}` : ''))
      }
      // Le rapport passe après le XML pour retrouver ses questions.
      for (const f of json) {
        const r = await bank.importReport(f)
        msgs.push(`rapport « ${f.name} » : ${r.matched} note${r.matched > 1 ? 's' : ''} rattachée${r.matched > 1 ? 's' : ''} sur ${r.total}`)
      }
      say(msgs.join(' · ') + '.')
    } catch (e) {
      alert('Import impossible : ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  // Au lancement : charge les fichiers .xml et .json posés dans data_prive/ (nouveaux ou modifiés).
  const autoLoaded = useRef(false)
  useEffect(() => {
    if (!bank.loaded || autoLoaded.current) return
    autoLoaded.current = true
    ;(async () => {
      try {
        const list: { name: string; size: number; mtime: number }[] = await (await fetch('/api/data-prive')).json()
        let seen: Record<string, string> = {}
        try {
          seen = JSON.parse(localStorage.getItem(AUTO_KEY) ?? '{}')
        } catch {
          /* aucun fichier mémorisé */
        }
        // Une banque vide recharge tout, même si les fichiers n'ont pas changé.
        const todo = list.filter((f) => !questions.length || seen[f.name] !== `${f.size}-${f.mtime}`)
        if (!todo.length) return
        setBusy(true)
        say(`Chargement de ${todo.map((f) => f.name).join(', ')}…`)
        const files: File[] = []
        for (const f of todo) {
          const r = await fetch('/api/data-prive?name=' + encodeURIComponent(f.name))
          if (r.ok) files.push(new File([await r.blob()], f.name))
        }
        await importFiles(files)
        for (const f of todo) seen[f.name] = `${f.size}-${f.mtime}`
        try {
          localStorage.setItem(AUTO_KEY, JSON.stringify(seen))
        } catch {
          /* les fichiers seront simplement relus au prochain lancement */
        }
      } catch {
        // Pas de dossier data_prive/ accessible (version compilée, par exemple) : import manuel.
        setBusy(false)
      }
    })()
  }, [bank.loaded])

  const exportXml = (qs: Question[], label: string) => {
    if (!qs.length) return say('Aucune question à exporter.')
    download(`questions-${fileSafe(label)}-${stamp()}.xml`, serializeBank(qs, categories, fileData))
    say(`${qs.length} question${qs.length > 1 ? 's' : ''} exportée${qs.length > 1 ? 's' : ''} au format Moodle XML.`)
  }
  const examQuestions = (e: Exam) => e.items.map((id) => questions.find((q) => q.id === id)).filter((q): q is Question => !!q)
  const exportExam = (e: Exam) => {
    // Une catégorie au nom de l'examen : dans StudiUM, il suffit d'ajouter au test toutes les questions de cette catégorie.
    const prefix = /^\$\w+\$/.exec(questions[0]?.category ?? '')?.[0] ?? '$course$'
    const category = `${prefix}/top/${e.name.replace(/\//g, '//')}`
    exportXml(examQuestions(e).map((q) => ({ ...q, category })), e.name)
  }
  const doPrint = (e: Exam, corrige: boolean) => {
    setPrint({ exam: e, corrige })
    setTimeout(() => {
      window.print()
      setPrint(null)
    }, 400)
  }

  const createSuggestion = async (s: Suggestion) => {
    const prefix = /^\$\w+\$/.exec(questions[0]?.category ?? '')?.[0] ?? '$course$'
    const q = newQuestion('multichoice', `${prefix}/top/Questions suggérées/${(s.theme ?? 'Divers').replace(/\//g, '//')}`, bank.nextOrder())
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const short = s.enonce.length > 60 ? s.enonce.slice(0, 60).replace(/\s+\S*$/, '') + '…' : s.enonce
    setText(q, 'name', { text: `${s.theme ?? 'Suggestion'} – ${short}`, files: [] })
    setText(q, 'questiontext', emptyRt('html', `<p>${esc(s.enonce)}</p>`))
    q.answers = s.options.map((o, i) => ({ k: uid(), fraction: i === s.bonne_reponse ? '100' : '0', rt: emptyRt('html', `<p>${esc(o)}</p>`), feedback: emptyRt('html'), extra: [] }))
    q.meta.review = { pertinence: s.pertinence_visee ?? '', direction: '', theme: s.theme ?? '', probleme: '', correction: '', cle: '', doublons: [], edited: true }
    setProp(q, 'single', 'true')
    const saved = await bank.saveQuestion(q)
    setCat(null)
    setView('bank')
    setSel(saved.id)
    setEditing(true)
  }
  /** Question de la banque dont l'énoncé est celui de la suggestion (déjà créée). */
  const byStatement = useMemo(() => new Map(questions.map((q) => [fold(plain(getText(q, 'questiontext')?.text)), q.id])), [questions])
  const existing = (s: Suggestion) => byStatement.get(fold(plain(s.enonce))) ?? null
  const exportNotes = (r: Report) => {
    download(r.name.replace(/\.json$/i, '') + `-notes-${stamp()}.json`, exportReport(r, questions), 'application/json')
    say('Notes exportées au format JSON.')
  }

  const create = async (type: string) => {
    if (!leaveEdit()) return
    const category = current?.category ?? categories[0]?.path ?? ''
    const q = await bank.saveQuestion(newQuestion(type, category, bank.nextOrder()))
    setView('bank')
    setSel(q.id)
    setEditing(true)
  }
  const toggleExam = async (q: Question) => {
    let e = exam
    if (!e) {
      const name = prompt('Aucun examen en cours. Nom du nouvel examen :', 'Nouvel examen')
      if (!name) return
      e = { id: crypto.randomUUID(), name, items: [], created: Date.now() }
      setExamId(e.id)
    }
    await bank.saveExam({ ...e, items: e.items.includes(q.id) ? e.items.filter((i) => i !== q.id) : [...e.items, q.id] })
  }
  const save = useCallback(
    async (q: Question, note: string) => {
      await bank.saveQuestion(q, note)
      dirty.current = false
      setEditing(false)
      say('Question enregistrée (version précédente conservée dans l’historique).')
    },
    [bank.saveQuestion],
  )

  // ---- Clavier ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== 'bank' || editing || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const i = filtered.findIndex((q) => q.id === sel)
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        const n = filtered[Math.min(i + 1, filtered.length - 1)]
        if (n) select(n.id)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        const n = filtered[Math.max(i - 1, 0)]
        if (n) select(n.id)
      } else if (e.key === 'e' && current) {
        e.preventDefault()
        setEditing(true)
      } else if (e.key === 'a' && current) toggleExam(current)
      else if (e.key === '/') {
        e.preventDefault()
        searchInput.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    document.querySelector('.q-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  if (!bank.loaded) return <div className="splash">Chargement de la banque…</div>

  return (
    <>
      <div
        className="app"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          importFiles([...e.dataTransfer.files])
        }}
      >
        <header>
          <span className="brand">QR StudiUM</span>
          <nav>
            <button className={view === 'bank' ? 'on' : ''} onClick={() => leaveEdit() && setView('bank')}>
              Banque <span className="count">{questions.length}</span>
            </button>
            <button className={view === 'exams' ? 'on' : ''} onClick={() => leaveEdit() && setView('exams')}>
              Examens <span className="count">{exams.length}</span>
            </button>
            {reports.length > 0 && (
              <button className={view === 'report' ? 'on' : ''} onClick={() => leaveEdit() && setView('report')}>
                Rapport
              </button>
            )}
          </nav>
          <span className="grow" />
          {view === 'bank' && (
            <label className="current-exam">
              Examen en cours
              <select value={examId ?? ''} onChange={(e) => setExamId(e.target.value || null)}>
                <option value="">(aucun)</option>
                {exams.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.items.length})
                  </option>
                ))}
              </select>
            </label>
          )}
          <button onClick={() => fileInput.current?.click()} disabled={busy}>
            {busy ? 'Import en cours…' : 'Importer (XML, JSON)'}
          </button>
          <input ref={fileInput} type="file" accept=".xml,.json" multiple hidden onChange={(e) => importFiles([...(e.target.files ?? [])]).then(() => (e.target.value = ''))} />
          <details className="menu">
            <summary>Nouvelle question</summary>
            <div>
              {CREATABLE.map((t) => (
                <button key={t} onClick={(e) => ((e.currentTarget.closest('details') as HTMLDetailsElement).open = false, create(t))}>
                  {typeLabel(t)}
                </button>
              ))}
            </div>
          </details>
          <details className="menu">
            <summary>Exporter</summary>
            <div>
              <button onClick={() => exportXml(filtered, cat ? cat.split(SEP).pop()! : 'selection')}>Les {filtered.length} questions affichées</button>
              <button onClick={() => exportXml(questions, 'banque')}>Toute la banque ({questions.length})</button>
              {reports.map((r) => (
                <button key={r.name} onClick={() => exportNotes(r)}>
                  Notes de révision (JSON)
                </button>
              ))}
              {exam && <button onClick={() => exportExam(exam)}>L’examen « {exam.name} »</button>}
              <hr />
              <button
                className="danger"
                onClick={() => {
                  if (confirm('Vider complètement la banque locale (questions, examens, historique) ? Vos fichiers XML d’origine ne sont pas touchés.')) {
                    bank.clear()
                    setSel(null)
                  }
                }}
              >
                Vider la banque locale
              </button>
            </div>
          </details>
        </header>

        {view === 'exams' ? (
          <ExamsView bank={bank} examId={examId} setExamId={setExamId} onExport={exportExam} onPrint={doPrint} />
        ) : view === 'report' ? (
          <ReportView
            reports={reports}
            questions={questions}
            onCreate={createSuggestion}
            existing={existing}
            onOpen={(id) => {
              setFDir('')
              setFPert('')
              setFType('')
              setFStatus('')
              setFIssues(false)
              setQuery('')
              setCat(null)
              setView('bank')
              setSel(id)
            }}
            onExport={exportNotes}
            onShow={(d) => {
              setFDir(d)
              setFPert('')
              setCat(null)
              setView('bank')
            }}
          />
        ) : !questions.length ? (
          <div className="empty">
            <h1>Aucune question pour l’instant</h1>
            <p>
              Dans StudiUM : <em>Banque de questions › Exporter › Format Moodle XML</em>, puis déposez le fichier ici (avec son rapport JSON s’il y en a un).
            </p>
            <button className="primary" onClick={() => fileInput.current?.click()}>
              Importer un fichier Moodle XML
            </button>
            <p className="hint">Les questions restent sur cet ordinateur (stockage local du navigateur). Rien n’est envoyé sur Internet.</p>
          </div>
        ) : (
          <main className="layout">
            <aside className="sidebar">
              <div className="side-title">Catégories</div>
              <button className={'cat' + (cat === null ? ' active' : '')} onClick={() => setCat(null)}>
                <span className="grow">Toutes les questions</span>
                <span className="count">{questions.length}</span>
              </button>
              {tree.map((n) => (
                <button key={n.key} className={'cat' + (cat === n.key ? ' active' : '')} style={{ paddingLeft: 10 + n.depth * 14 }} onClick={() => setCat(n.key)} title={n.label}>
                  <span className="grow">{n.label}</span>
                  <span className="count">{n.count}</span>
                </button>
              ))}
              <div className="side-title">Filtres</div>
              <select value={fType} onChange={(e) => setFType(e.target.value)}>
                <option value="">Tous les types</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {typeLabel(t)}
                  </option>
                ))}
              </select>
              <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                <option value="">Tous les statuts</option>
                <option value="aucun">Sans statut</option>
                <option value="brouillon">Brouillon</option>
                <option value="a_reviser">À réviser</option>
                <option value="validee">Validée</option>
              </select>
              {questions.some((q) => q.meta.review) && (
                <>
                  <select value={fDir} onChange={(e) => setFDir(e.target.value)}>
                    <option value="">Toutes les directions</option>
                    {DIRECTIONS.map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                  </select>
                  <select value={fPert} onChange={(e) => setFPert(e.target.value)}>
                    <option value="">Toutes les pertinences</option>
                    {PERTINENCES.map((d) => (
                      <option key={d} value={d}>
                        Pertinence {d.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <label className="check">
                <input type="checkbox" checked={fIssues} onChange={(e) => setFIssues(e.target.checked)} />
                Avec alertes seulement
              </label>
              <p className="hint keys">
                Clavier : ↑ ↓ naviguer · <kbd>e</kbd> modifier · <kbd>a</kbd> ajouter à l’examen · <kbd>/</kbd> rechercher
              </p>
            </aside>

            <section className="list">
              <div className="list-head">
                <input ref={searchInput} type="search" placeholder="Rechercher dans les énoncés, réponses, étiquettes…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()} />
                <div className="list-count">
                  {filtered.length} question{filtered.length > 1 ? 's' : ''} · {+filtered.reduce((s, q) => s + points(q), 0).toFixed(2)} points
                </div>
              </div>
              <div className="rows">
                {filtered.map((q) => {
                  const level = worst(issues.get(q.id) ?? [])
                  const inExam = !!exam?.items.includes(q.id)
                  return (
                    <div key={q.id} className={'q-row' + (q.id === sel ? ' active' : '')} onClick={() => select(q.id)}>
                      <span className={'badge t-' + q.type}>{typeShort(q.type)}</span>
                      <div className="grow q-main">
                        <div className="q-name">
                          {q.meta.status && <span className={'dot s-' + q.meta.status} title={STATUS[q.meta.status]} />}
                          {qName(q) || '(sans nom)'}
                        </div>
                        <div className="q-snippet">{plain(getText(q, 'questiontext')?.text).slice(0, 140)}</div>
                      </div>
                      {q.meta.review?.pertinence && <span className="pert" title={'Pertinence ' + q.meta.review.pertinence.toLowerCase()}>{q.meta.review.pertinence[0]}</span>}
                      {(q.meta.review?.direction === 'Améliorer' || q.meta.review?.direction === 'Corriger avant usage') && (
                        <span className={'chip ' + directionClass(q.meta.review.direction)} title={q.meta.review.probleme}>
                          {q.meta.review.direction === 'Améliorer' ? 'Améliorer' : 'À corriger'}
                        </span>
                      )}
                      {level && <span className={'flag ' + level} title={(issues.get(q.id) ?? []).map((i) => i.msg).join('\n')}>!</span>}
                      <button className={'add' + (inExam ? ' on' : '')} title={inExam ? 'Retirer de l’examen en cours' : 'Ajouter à l’examen en cours'} onClick={(e) => (e.stopPropagation(), toggleExam(q))}>
                        {inExam ? '✓' : '+'}
                      </button>
                    </div>
                  )
                })}
                {!filtered.length && <p className="hint pad">Aucune question ne correspond aux filtres.</p>}
              </div>
            </section>

            <section className="detail">
              {!current ? (
                <p className="hint pad">Sélectionnez une question dans la liste.</p>
              ) : editing ? (
                <QuestionEditor key={current.id} question={current} categories={categories} onSave={save} onCancel={() => leaveEdit()} onDirty={() => (dirty.current = true)} />
              ) : (
                <div className="detail-body">
                  <div className="detail-bar">
                    <button className="primary" onClick={() => setEditing(true)}>
                      Modifier
                    </button>
                    <button onClick={async () => { const c = await bank.duplicate(current.id); if (c) { setSel(c.id); setEditing(true) } }}>Dupliquer en variante</button>
                    <button onClick={() => toggleExam(current)}>{exam?.items.includes(current.id) ? 'Retirer de l’examen' : 'Ajouter à l’examen'}</button>
                    <span className="grow" />
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm(`Supprimer définitivement « ${qName(current)} » de la banque locale ?`)) {
                          bank.removeQuestion(current.id)
                          setSel(null)
                        }
                      }}
                    >
                      Supprimer
                    </button>
                  </div>
                  <h2>{qName(current) || '(sans nom)'}</h2>
                  <div className="meta">
                    <span className={'badge t-' + current.type}>{typeLabel(current.type)}</span>
                    <span>{+points(current).toFixed(2)} pt</span>
                    <span title={current.category}>{categoryLabel(current.category)}</span>
                    {getProp(current, 'idnumber') && <span>ID : {getProp(current, 'idnumber')}</span>}
                    {current.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className="meta">
                    <select value={current.meta.status} onChange={(e) => bank.updateMeta(current.id, { status: e.target.value as Status })}>
                      {Object.entries(STATUS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <input key={current.id} className="grow" placeholder="Note privée (non exportée)" defaultValue={current.meta.note} onBlur={(e) => e.target.value !== current.meta.note && bank.updateMeta(current.id, { note: e.target.value })} />
                  </div>
                  {exams.some((e) => e.items.includes(current.id)) && (
                    <div className="meta">
                      Utilisée dans :{' '}
                      {exams
                        .filter((e) => e.items.includes(current.id))
                        .map((e) => e.name)
                        .join(', ')}
                    </div>
                  )}
                  <ReviewBox q={current} onChange={(review) => bank.updateMeta(current.id, { review })} />
                  <Issues issues={issues.get(current.id) ?? []} />
                  <div className="tabs">
                    <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>
                      Aperçu avec corrigé
                    </button>
                    <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
                      Historique
                    </button>
                  </div>
                  {tab === 'preview' ? <QuestionPreview q={current} /> : <History q={current} onRestore={(snap) => bank.saveQuestion({ ...snap, meta: { ...current.meta } }, 'Restauration d’une version antérieure')} />}
                </div>
              )}
            </section>
          </main>
        )}
        {toast && <div className="toast">{toast}</div>}
      </div>
      {print && <PrintSheet exam={print.exam} questions={examQuestions(print.exam)} corrige={print.corrige} />}
    </>
  )
}

function History({ q, onRestore }: { q: Question; onRestore: (snapshot: Question) => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    setVersions(null)
    setOpen(null)
    db.getVersions(q.id).then(setVersions)
  }, [q.id, q.meta.modified])

  if (!versions) return <p className="hint">Chargement…</p>
  if (!versions.length) return <p className="hint">Aucune version antérieure : la question n’a pas été modifiée dans l’application.</p>
  return (
    <div className="history">
      {versions.map((v) => (
        <div key={v.vid} className="version">
          <div className="row">
            <button onClick={() => setOpen(open === v.vid ? null : v.vid!)}>{open === v.vid ? 'Masquer' : 'Voir'}</button>
            <span className="grow">
              Version du {new Date(v.date).toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' })}
              {v.note && <em> — remplacée avec la note : {v.note}</em>}
            </span>
            <button onClick={() => confirm('Restaurer cette version ? La version actuelle sera conservée dans l’historique.') && onRestore(v.snapshot)}>Restaurer</button>
          </div>
          {open === v.vid && <QuestionPreview q={v.snapshot} />}
        </div>
      ))}
    </div>
  )
}
