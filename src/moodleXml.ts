// Lecture et écriture du format Moodle XML (import/export de la banque de questions StudiUM).
import { type Answer, type Category, type FileRef, type Question, type RichText, type SubQuestion, getProp, getText, uid } from './model'

export interface ParsedBank {
  questions: Question[]
  categories: Category[]
  /** Contenu base64 des fichiers intégrés, indexé par clé de contenu. */
  files: Map<string, string>
}

/** Clé de contenu rapide (cyrb53 + longueur) : évite de dupliquer les images en mémoire et dans l'historique. */
export function contentKey(data: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < data.length; i++) {
    const ch = data.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '-' + data.length.toString(36)
}

const kids = (el: Element): Element[] => Array.from(el.children)
const child = (el: Element, tag: string): Element | undefined => kids(el).find((c) => c.tagName === tag)

export function parseMoodleXml(xml: string, source: string): ParsedBank {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`« ${source} » n'est pas un fichier XML valide.`)
  const quiz = doc.documentElement
  if (quiz.tagName !== 'quiz') throw new Error(`« ${source} » n'est pas un export Moodle XML (balise <quiz> absente).`)

  const files = new Map<string, string>()
  const serializer = new XMLSerializer()
  const raw = (el: Element) => serializer.serializeToString(el)

  const parseRt = (el: Element): RichText => {
    const rt: RichText = { text: child(el, 'text')?.textContent ?? '', files: [] }
    const format = el.getAttribute('format')
    if (format !== null) rt.format = format
    for (const f of kids(el)) {
      if (f.tagName !== 'file') continue
      const data = (f.textContent ?? '').replace(/\s+/g, '')
      const hash = contentKey(data)
      files.set(hash, data)
      rt.files.push({ name: f.getAttribute('name') ?? '', path: f.getAttribute('path') ?? '/', encoding: f.getAttribute('encoding') ?? 'base64', hash })
    }
    return rt
  }
  const isRt = (el: Element) => kids(el)[0]?.tagName === 'text' && kids(el).every((c) => c.tagName === 'text' || c.tagName === 'file')

  const parseQuestion = (el: Element): Question => {
    const now = Date.now()
    const q: Question = {
      id: uid(),
      type: el.getAttribute('type') ?? '',
      category: '',
      fields: [],
      answers: [],
      subquestions: [],
      tags: [],
      hasTags: false,
      extra: [],
      meta: { status: '', note: '', source, order: 0, created: now, modified: now },
    }
    for (const c of kids(el)) {
      const tag = c.tagName
      if (tag === 'answer') {
        const a: Answer = { k: uid(), fraction: c.getAttribute('fraction') ?? '0', rt: parseRt(c), extra: [] }
        for (const g of kids(c)) {
          if (g.tagName === 'feedback') a.feedback = parseRt(g)
          else if (g.tagName !== 'text' && g.tagName !== 'file') a.extra.push(raw(g))
        }
        q.answers.push(a)
      } else if (tag === 'subquestion') {
        const s: SubQuestion = { k: uid(), rt: parseRt(c), answer: '', extra: [] }
        for (const g of kids(c)) {
          if (g.tagName === 'answer') s.answer = child(g, 'text')?.textContent ?? ''
          else if (g.tagName !== 'text' && g.tagName !== 'file') s.extra.push(raw(g))
        }
        q.subquestions.push(s)
      } else if (tag === 'tags') {
        q.hasTags = true
        for (const t of kids(c)) q.tags.push(child(t, 'text')?.textContent ?? '')
      } else if (isRt(c)) q.fields.push({ kind: 'text', tag, rt: parseRt(c) })
      else if (!kids(c).length && !c.attributes.length) q.fields.push({ kind: 'prop', tag, value: (c.textContent ?? '').trim() })
      else q.extra.push(raw(c))
    }
    return q
  }

  const questions: Question[] = []
  const categories: Category[] = []
  let category = ''
  for (const el of kids(quiz)) {
    if (el.tagName !== 'question') continue
    const q = parseQuestion(el)
    if (q.type === 'category') {
      category = (getText(q, 'category')?.text ?? '').trim()
      if (!categories.some((c) => c.path === category)) categories.push({ path: category, info: getText(q, 'info'), idnumber: getProp(q, 'idnumber') })
      continue
    }
    q.category = category
    questions.push(q)
  }
  return { questions, categories, files }
}

// ---- Écriture ----

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;')
const cdata = (s: string) => (/[<>&]/.test(s) ? '<![CDATA[' + s.replace(/]]>/g, ']]]]><![CDATA[>') + ']]>' : s)

type GetData = (hash: string) => string

function rtXml(tag: string, rt: RichText, data: GetData, pad: string, inner = ''): string {
  const fmt = rt.format !== undefined ? ` format="${escAttr(rt.format)}"` : ''
  const files = rt.files.map((f: FileRef) => `${pad}  <file name="${escAttr(f.name)}" path="${escAttr(f.path)}" encoding="${escAttr(f.encoding)}">${data(f.hash)}</file>\n`).join('')
  return `${pad}<${tag}${fmt}>\n${pad}  <text>${cdata(rt.text)}</text>\n${files}${inner}${pad}</${tag}>\n`
}

export function serializeQuestion(q: Question, data: GetData): string {
  let s = `  <question type="${escAttr(q.type)}">\n`
  for (const f of q.fields) {
    if (f.kind === 'prop') s += `    <${f.tag}>${esc(f.value)}</${f.tag}>\n`
    else s += rtXml(f.tag, f.rt, data, '    ')
  }
  for (const x of q.extra) s += `    ${x}\n`
  for (const a of q.answers) {
    const fmt = a.rt.format !== undefined ? ` format="${escAttr(a.rt.format)}"` : ''
    s += `    <answer fraction="${escAttr(a.fraction)}"${fmt}>\n      <text>${cdata(a.rt.text)}</text>\n`
    for (const f of a.rt.files) s += `      <file name="${escAttr(f.name)}" path="${escAttr(f.path)}" encoding="${escAttr(f.encoding)}">${data(f.hash)}</file>\n`
    if (a.feedback) s += rtXml('feedback', a.feedback, data, '      ')
    for (const x of a.extra) s += `      ${x}\n`
    s += `    </answer>\n`
  }
  for (const sub of q.subquestions) {
    const inner = `      <answer>\n        <text>${cdata(sub.answer)}</text>\n      </answer>\n` + sub.extra.map((x) => `      ${x}\n`).join('')
    s += rtXml('subquestion', sub.rt, data, '    ', inner)
  }
  if (q.hasTags || q.tags.length) {
    s += `    <tags>\n` + q.tags.map((t) => `      <tag><text>${cdata(t)}</text></tag>\n`).join('') + `    </tags>\n`
  }
  return s + `  </question>\n`
}

function categoryXml(c: Category, data: GetData): string {
  let s = `  <question type="category">\n    <category>\n      <text>${cdata(c.path)}</text>\n    </category>\n`
  s += rtXml('info', c.info ?? { format: 'html', text: '', files: [] }, data, '    ')
  return s + `    <idnumber>${esc(c.idnumber ?? '')}</idnumber>\n  </question>\n`
}

export function serializeBank(questions: Question[], categories: Category[], data: GetData): string {
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n`
  let current: string | null = null
  for (const q of questions) {
    if (q.category !== current) {
      current = q.category
      if (current) s += categoryXml(categories.find((c) => c.path === current) ?? { path: current }, data)
    }
    s += serializeQuestion(q, data)
  }
  return s + `</quiz>\n`
}

/** Signature d'une question (sans les données d'image) : sert à ignorer les doublons exacts à l'import. */
export const signature = (q: Question): string => q.category + '\n' + serializeQuestion(q, (h) => h)
