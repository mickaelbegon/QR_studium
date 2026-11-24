// Stockage local (IndexedDB du navigateur) : rien ne quitte le poste.
import type { Category, Exam, Question, Version } from './model'
import type { Report } from './report'

const NAME = 'qr_studium'
let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      const has = (s: string) => db.objectStoreNames.contains(s)
      if (!has('questions')) db.createObjectStore('questions', { keyPath: 'id' })
      if (!has('categories')) db.createObjectStore('categories', { keyPath: 'path' })
      if (!has('files')) db.createObjectStore('files', { keyPath: 'hash' })
      if (!has('exams')) db.createObjectStore('exams', { keyPath: 'id' })
      if (!has('versions')) db.createObjectStore('versions', { keyPath: 'vid', autoIncrement: true }).createIndex('qid', 'qid')
      if (!has('reports')) db.createObjectStore('reports', { keyPath: 'name' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

async function run<T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => T): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode)
    const result = fn(tx)
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

const all = async <T>(store: string): Promise<T[]> => {
  let req!: IDBRequest<T[]>
  await run([store], 'readonly', (tx) => (req = tx.objectStore(store).getAll()))
  return req.result
}

const putAll = (store: string, items: unknown[]) => run([store], 'readwrite', (tx) => items.forEach((i) => tx.objectStore(store).put(i)))
const del = (store: string, keys: string[]) => run([store], 'readwrite', (tx) => keys.forEach((k) => tx.objectStore(store).delete(k)))

export const loadQuestions = () => all<Question>('questions')
export const loadCategories = () => all<Category>('categories')
export const loadFiles = () => all<{ hash: string; data: string }>('files')
export const loadExams = () => all<Exam>('exams')
export const loadReports = () => all<Report>('reports')
export const putReport = (r: Report) => putAll('reports', [r])
export const deleteReport = (name: string) => del('reports', [name])

export const putQuestions = (qs: Question[]) => putAll('questions', qs)
export const deleteQuestions = (ids: string[]) => del('questions', ids)
export const putCategories = (cs: Category[]) => putAll('categories', cs)
export const putFiles = (fs: { hash: string; data: string }[]) => putAll('files', fs)
export const putExam = (e: Exam) => putAll('exams', [e])
export const deleteExam = (id: string) => del('exams', [id])
export const addVersion = (v: Version) => putAll('versions', [v])

export async function getVersions(qid: string): Promise<Version[]> {
  let req!: IDBRequest<Version[]>
  await run(['versions'], 'readonly', (tx) => (req = tx.objectStore('versions').index('qid').getAll(qid)))
  return req.result.sort((a, b) => b.date - a.date)
}

export const clearAll = () =>
  run(['questions', 'categories', 'files', 'exams', 'versions', 'reports'], 'readwrite', (tx) => {
    for (const s of ['questions', 'categories', 'files', 'exams', 'versions', 'reports']) tx.objectStore(s).clear()
  })
