// État de la banque de questions, synchronisé avec le stockage local.
import { useCallback, useEffect, useRef, useState } from 'react'
import * as db from './db'
import { clearFiles, loadIntoMemory, registerFiles } from './files'
import { type Category, type Exam, type Question, getText, qName, setText, uid } from './model'
import { parseMoodleXml, serializeQuestion, signature } from './moodleXml'
import { type Report, applyReport, originId, parseReport } from './report'

/** Clé stable d'une question d'un fichier à l'autre : son identifiant d'origine, sinon son type et son nom. */
const matchKey = (q: Question): string => {
  const o = originId(q)
  return o !== null ? 'o' + o : 'n' + q.type + '\n' + qName(q)
}
/** Contenu d'une question, hors catégorie et étiquettes (qui restent celles de la banque). */
const body = (q: Question): string => serializeQuestion({ ...q, tags: [], hasTags: false }, (h) => h)

export interface UpdatePlan {
  /** Questions de la banque dont le contenu sera remplacé. */
  updates: Question[]
  same: number
  unknown: number
  files: Map<string, string>
}

export function useBank() {
  const [questions, setQuestions] = useState<Question[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [exams, setExams] = useState<Exam[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [loaded, setLoaded] = useState(false)
  const ref = useRef({ questions, categories, exams, reports })
  ref.current = { questions, categories, exams, reports }

  useEffect(() => {
    ;(async () => {
      const [qs, cs, fs, es, rs] = await Promise.all([db.loadQuestions(), db.loadCategories(), db.loadFiles(), db.loadExams(), db.loadReports()])
      setReports(rs)
      loadIntoMemory(fs.map((f) => [f.hash, f.data]))
      setQuestions(qs.sort((a, b) => a.meta.order - b.meta.order))
      setCategories(cs)
      setExams(es.sort((a, b) => a.created - b.created))
      setLoaded(true)
    })()
  }, [])

  const nextOrder = () => ref.current.questions.reduce((m, q) => Math.max(m, q.meta.order), 0) + 1

  const importXml = useCallback(async (files: File[]) => {
    const known = new Set(ref.current.questions.map(signature))
    const cats = [...ref.current.categories]
    const added: Question[] = []
    let skipped = 0
    let order = nextOrder()
    for (const file of files) {
      const parsed = parseMoodleXml(await file.text(), file.name)
      await registerFiles(parsed.files)
      for (const q of parsed.questions) {
        const sig = signature(q)
        if (known.has(sig)) {
          skipped++
          continue
        }
        known.add(sig)
        q.meta.order = order++
        added.push(q)
      }
      for (const c of parsed.categories) if (!cats.some((x) => x.path === c.path)) cats.push(c)
    }
    // Les rapports déjà importés s'appliquent aussi aux nouvelles questions.
    for (const r of ref.current.reports) for (const q of applyReport(added, r.data)) added[added.findIndex((x) => x.id === q.id)] = q
    await db.putQuestions(added)
    await db.putCategories(cats)
    setQuestions([...ref.current.questions, ...added])
    setCategories(cats)
    return { added: added.length, skipped }
  }, [])

  /**
   * Compare un fichier XML corrigé à la banque : les questions reconnues dont le contenu diffère
   * seront remplacées. Rien n'est écrit tant que `applyUpdate` n'est pas appelé.
   */
  const planUpdate = useCallback(async (file: File): Promise<UpdatePlan> => {
    const parsed = parseMoodleXml(await file.text(), file.name)
    // Une clé portée par deux questions de la banque est ambiguë : on n'y touche pas.
    const mine = new Map<string, Question | null>()
    for (const q of ref.current.questions) {
      const k = matchKey(q)
      mine.set(k, mine.has(k) ? null : q)
    }
    const updates: Question[] = []
    const seen = new Set<string>()
    let same = 0
    let unknown = 0
    for (const q of parsed.questions) {
      const k = matchKey(q)
      const cur = mine.get(k)
      if (!cur || seen.has(k)) {
        unknown++
        continue
      }
      seen.add(k)
      if (body(cur) === body(q)) same++
      else updates.push({ ...q, id: cur.id, category: cur.category, tags: cur.tags, hasTags: cur.hasTags, meta: cur.meta })
    }
    return { updates, same, unknown, files: parsed.files }
  }, [])

  /** Applique un plan de mise à jour ; chaque version remplacée va dans l'historique. */
  const applyUpdate = useCallback(async (plan: UpdatePlan, note: string) => {
    await registerFiles(plan.files)
    const now = Date.now()
    const next = new Map(plan.updates.map((q) => [q.id, { ...q, meta: { ...q.meta, modified: now } }]))
    for (const prev of ref.current.questions) if (next.has(prev.id)) await db.addVersion({ qid: prev.id, date: prev.meta.modified, note, snapshot: prev })
    await db.putQuestions([...next.values()])
    setQuestions(ref.current.questions.map((q) => next.get(q.id) ?? q))
    return next.size
  }, [])

  /** Rattache des propositions de distracteurs aux questions, par identifiant d'origine. */
  const importProposals = useCallback(async (proposals: Map<number, Question['meta']['proposal']>) => {
    const changed: Question[] = []
    for (const q of ref.current.questions) {
      const o = originId(q)
      const proposal = o === null ? undefined : proposals.get(o)
      if (proposal) changed.push({ ...q, meta: { ...q.meta, proposal } })
    }
    const byId = new Map(changed.map((q) => [q.id, q]))
    await db.putQuestions(changed)
    setQuestions(ref.current.questions.map((q) => byId.get(q.id) ?? q))
    return { matched: changed.length, total: proposals.size }
  }, [])

  /** Importe un rapport JSON et rattache ses notes aux questions (par l'étiquette id-origine-<ID>). */
  const importReport = useCallback(async (file: File) => {
    const report = parseReport(await file.text(), file.name)
    // Un fichier de notes sans analyse (sauvegarde d'une banque sans rapport) ne crée pas d'onglet « Rapport ».
    const d = report.data
    if (d.questions.length || d.defauts_recurrents?.length || d.lacunes?.length || d.questions_suggerees?.length) {
      await db.putReport(report)
      setReports([...ref.current.reports.filter((r) => r.name !== report.name), report])
    }
    const changed = applyReport(ref.current.questions, report.data)
    const byId = new Map(changed.map((q) => [q.id, q]))
    await db.putQuestions(changed)
    setQuestions(ref.current.questions.map((q) => byId.get(q.id) ?? q))
    return { matched: changed.length, total: report.data.questions.length }
  }, [])

  /** Enregistre une question ; l'état précédent est archivé dans l'historique. */
  const saveQuestion = useCallback(async (q: Question, note = '') => {
    const prev = ref.current.questions.find((x) => x.id === q.id)
    const next = { ...q, meta: { ...q.meta, modified: Date.now() } }
    if (prev) await db.addVersion({ qid: q.id, date: prev.meta.modified, note, snapshot: prev })
    await db.putQuestions([next])
    setQuestions(prev ? ref.current.questions.map((x) => (x.id === q.id ? next : x)) : [...ref.current.questions, next])
    if (next.category && !ref.current.categories.some((c) => c.path === next.category)) {
      const cats = [...ref.current.categories, { path: next.category }]
      await db.putCategories(cats)
      setCategories(cats)
    }
    return next
  }, [])

  /** Remplace les métadonnées d'une question (sans entrée d'historique). */
  const saveMeta = useCallback(async (id: string, meta: Question['meta']) => {
    const prev = ref.current.questions.find((x) => x.id === id)
    if (!prev) return
    const next = { ...prev, meta }
    await db.putQuestions([next])
    setQuestions(ref.current.questions.map((x) => (x.id === id ? next : x)))
  }, [])

  /** Statut et note privée : pas d'entrée d'historique, rien n'est exporté. */
  const updateMeta = useCallback(async (id: string, meta: Partial<Question['meta']>) => {
    const prev = ref.current.questions.find((x) => x.id === id)
    if (!prev) return
    const next = { ...prev, meta: { ...prev.meta, ...meta } }
    await db.putQuestions([next])
    setQuestions(ref.current.questions.map((x) => (x.id === id ? next : x)))
  }, [])

  const duplicate = useCallback(async (id: string) => {
    const src = ref.current.questions.find((x) => x.id === id)
    if (!src) return null
    const copy: Question = structuredClone(src)
    copy.id = uid()
    copy.answers.forEach((a) => (a.k = uid()))
    copy.subquestions.forEach((s) => (s.k = uid()))
    const name = getText(copy, 'name') ?? { text: '', files: [] }
    setText(copy, 'name', { ...name, text: qName(src) + ' (variante)' })
    const idn = copy.fields.find((f) => f.kind === 'prop' && f.tag === 'idnumber')
    if (idn && idn.kind === 'prop') idn.value = ''
    const now = Date.now()
    copy.meta = { ...copy.meta, status: 'brouillon', order: nextOrder(), created: now, modified: now }
    await db.putQuestions([copy])
    setQuestions([...ref.current.questions, copy])
    return copy
  }, [])

  const removeQuestion = useCallback(async (id: string) => {
    await db.deleteQuestions([id])
    setQuestions(ref.current.questions.filter((x) => x.id !== id))
    for (const e of ref.current.exams) if (e.items.includes(id)) await db.putExam({ ...e, items: e.items.filter((i) => i !== id) })
    setExams(ref.current.exams.map((e) => ({ ...e, items: e.items.filter((i) => i !== id) })))
  }, [])

  const removeQuestions = useCallback(async (ids: string[]) => {
    const gone = new Set(ids)
    await db.deleteQuestions(ids)
    setQuestions(ref.current.questions.filter((x) => !gone.has(x.id)))
    const exams = ref.current.exams.map((e) => (e.items.some((i) => gone.has(i)) ? { ...e, items: e.items.filter((i) => !gone.has(i)) } : e))
    for (const e of exams) if (e !== ref.current.exams.find((x) => x.id === e.id)) await db.putExam(e)
    setExams(exams)
  }, [])

  /** Annule une suppression : remet les questions et les examens tels qu'ils étaient. */
  const restore = useCallback(async (qs: Question[], exams: Exam[]) => {
    await db.putQuestions(qs)
    for (const e of exams) await db.putExam(e)
    const present = new Set(ref.current.questions.map((q) => q.id))
    setQuestions([...ref.current.questions, ...qs.filter((q) => !present.has(q.id))].sort((a, b) => a.meta.order - b.meta.order))
    setExams(exams)
  }, [])

  /** Recrée les examens décrits dans un fichier de notes de sauvegarde. */
  const restoreExams = useCallback(async (list: { nom: string; questions: { nom: string; id_origine: number | null }[] }[]) => {
    const byOrigin = new Map<number, string>()
    const byName = new Map<string, string>()
    for (const q of ref.current.questions) {
      const o = q.meta.review?.origine ?? originId(q)
      if (o != null) byOrigin.set(o, q.id)
      byName.set(qName(q), q.id)
    }
    const exams: Exam[] = list.map((e, i) => ({
      id: uid(),
      name: e.nom,
      created: Date.now() + i,
      items: e.questions.map((x) => (x.id_origine != null ? byOrigin.get(x.id_origine) : undefined) ?? byName.get(x.nom)).filter((id): id is string => !!id),
    }))
    for (const e of exams) await db.putExam(e)
    setExams([...ref.current.exams, ...exams])
    return exams.length
  }, [])

  const saveExam = useCallback(async (e: Exam) => {
    await db.putExam(e)
    const list = ref.current.exams
    setExams(list.some((x) => x.id === e.id) ? list.map((x) => (x.id === e.id ? e : x)) : [...list, e])
  }, [])

  const removeExam = useCallback(async (id: string) => {
    await db.deleteExam(id)
    setExams(ref.current.exams.filter((x) => x.id !== id))
  }, [])

  const clear = useCallback(async () => {
    await db.clearAll()
    clearFiles()
    setQuestions([])
    setCategories([])
    setExams([])
    setReports([])
  }, [])

  return { questions, categories, exams, reports, loaded, nextOrder, importXml, importReport, importProposals, planUpdate, applyUpdate, saveQuestion, updateMeta, saveMeta, duplicate, removeQuestion, removeQuestions, restore, restoreExams, saveExam, removeExam, clear }
}

export type Bank = ReturnType<typeof useBank>
