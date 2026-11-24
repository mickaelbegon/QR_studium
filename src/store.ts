// État de la banque de questions, synchronisé avec le stockage local.
import { useCallback, useEffect, useRef, useState } from 'react'
import * as db from './db'
import { clearFiles, loadIntoMemory, registerFiles } from './files'
import { type Category, type Exam, type Question, getText, qName, setText, uid } from './model'
import { parseMoodleXml, signature } from './moodleXml'

export function useBank() {
  const [questions, setQuestions] = useState<Question[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [exams, setExams] = useState<Exam[]>([])
  const [loaded, setLoaded] = useState(false)
  const ref = useRef({ questions, categories, exams })
  ref.current = { questions, categories, exams }

  useEffect(() => {
    ;(async () => {
      const [qs, cs, fs, es] = await Promise.all([db.loadQuestions(), db.loadCategories(), db.loadFiles(), db.loadExams()])
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
    await db.putQuestions(added)
    await db.putCategories(cats)
    setQuestions([...ref.current.questions, ...added])
    setCategories(cats)
    return { added: added.length, skipped }
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
  }, [])

  return { questions, categories, exams, loaded, nextOrder, importXml, saveQuestion, updateMeta, duplicate, removeQuestion, saveExam, removeExam, clear }
}

export type Bank = ReturnType<typeof useBank>
