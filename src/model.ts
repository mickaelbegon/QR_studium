// Modèle de données : une représentation fidèle du format Moodle XML.
// Tout ce qui n'est pas compris est conservé tel quel (`extra`) pour être réécrit à l'export.

export interface FileRef {
  name: string
  path: string
  encoding: string
  /** Clé du contenu (base64) dans le magasin de fichiers. */
  hash: string
}

export interface RichText {
  format?: string
  text: string
  files: FileRef[]
}

export type Field =
  | { kind: 'prop'; tag: string; value: string }
  | { kind: 'text'; tag: string; rt: RichText }

export interface Answer {
  k: string
  fraction: string
  rt: RichText
  feedback?: RichText
  extra: string[]
}

export interface SubQuestion {
  k: string
  rt: RichText
  answer: string
  extra: string[]
}

export type Status = '' | 'brouillon' | 'a_reviser' | 'validee'

export interface QuestionMeta {
  status: Status
  note: string
  source?: string
  order: number
  created: number
  modified: number
}

export interface Question {
  id: string
  type: string
  category: string
  fields: Field[]
  answers: Answer[]
  subquestions: SubQuestion[]
  tags: string[]
  hasTags: boolean
  extra: string[]
  meta: QuestionMeta
}

export interface Category {
  path: string
  info?: RichText
  idnumber?: string
}

export interface Exam {
  id: string
  name: string
  items: string[]
  created: number
}

export interface Version {
  vid?: number
  qid: string
  date: number
  note: string
  snapshot: Question
}

export const uid = (): string => {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export const emptyRt = (format: string | undefined = 'html', text = ''): RichText => ({ format, text, files: [] })

export function getProp(q: Question, tag: string): string | undefined {
  const f = q.fields.find((f) => f.kind === 'prop' && f.tag === tag)
  return f && f.kind === 'prop' ? f.value : undefined
}

export function setProp(q: Question, tag: string, value: string): void {
  const f = q.fields.find((f) => f.kind === 'prop' && f.tag === tag)
  if (f && f.kind === 'prop') f.value = value
  else q.fields.push({ kind: 'prop', tag, value })
}

export function getText(q: Question, tag: string): RichText | undefined {
  const f = q.fields.find((f) => f.kind === 'text' && f.tag === tag)
  return f && f.kind === 'text' ? f.rt : undefined
}

export function setText(q: Question, tag: string, rt: RichText): void {
  const f = q.fields.find((f) => f.kind === 'text' && f.tag === tag)
  if (f && f.kind === 'text') f.rt = rt
  else q.fields.push({ kind: 'text', tag, rt })
}

export const qName = (q: Question): string => getText(q, 'name')?.text ?? ''

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', rsquo: '’', laquo: '«', raquo: '»' }

/** Texte brut d'un fragment HTML (pour la recherche, les extraits et la détection de doublons). */
export function plain(html: string | undefined): string {
  if (!html) return ''
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Minuscules sans accents, pour une recherche tolérante. */
export const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function allTexts(q: Question): RichText[] {
  const out: RichText[] = []
  for (const f of q.fields) if (f.kind === 'text') out.push(f.rt)
  for (const a of q.answers) {
    out.push(a.rt)
    if (a.feedback) out.push(a.feedback)
  }
  for (const s of q.subquestions) out.push(s.rt)
  return out
}

export function searchText(q: Question): string {
  const parts = allTexts(q).map((rt) => plain(rt.text))
  parts.push(...q.subquestions.map((s) => s.answer), ...q.tags, getProp(q, 'idnumber') ?? '', q.meta.note)
  return fold(parts.join(' '))
}

// ---- Fichiers référencés dans le HTML (@@PLUGINFILE@@/nom.png) ----

const PLUGINFILE = /@@PLUGINFILE@@\/([^"'\s<>)?#]+)/g

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function fileRefs(text: string): string[] {
  return [...text.matchAll(PLUGINFILE)].map((m) => safeDecode(m[1]))
}

export const filePathName = (f: FileRef): string => (f.path + f.name).replace(/^\/+/, '')

export function replaceFileRefs(html: string, rt: RichText, url: (f: FileRef) => string): string {
  return html.replace(PLUGINFILE, (m, p) => {
    const name = safeDecode(p)
    const f = rt.files.find((f) => filePathName(f) === name)
    return f ? url(f) : m
  })
}

export const pluginUrl = (f: FileRef): string =>
  '@@PLUGINFILE@@' + (f.path.startsWith('/') ? f.path : '/' + f.path) + encodeURIComponent(f.name)

// ---- Catégories ----

/** Découpe un chemin Moodle (« / » sépare, « // » est une barre oblique littérale). */
export function splitCategory(path: string): string[] {
  const parts: string[] = []
  let cur = ''
  for (let i = 0; i < path.length; i++) {
    if (path[i] === '/') {
      if (path[i + 1] === '/') {
        cur += '/'
        i++
      } else {
        parts.push(cur)
        cur = ''
      }
    } else cur += path[i]
  }
  parts.push(cur)
  return parts.map((s) => s.trim())
}

/** Niveaux affichés : sans le préfixe technique `$module$/top`. */
export function categoryParts(path: string): string[] {
  if (!path) return ['(Sans catégorie)']
  let parts = splitCategory(path)
  if (/^\$\w+\$$/.test(parts[0] ?? '')) parts = parts.slice(1)
  if (parts[0] === 'top') parts = parts.slice(1)
  return parts.length ? parts : ['(Racine)']
}

export const SEP = '\u0001'
export const categoryKey = (path: string): string => categoryParts(path).join(SEP)
export const categoryLabel = (path: string): string => categoryParts(path).join(' › ')

// ---- Types de questions ----

export const TYPES: Record<string, { label: string; short: string }> = {
  multichoice: { label: 'Choix multiple', short: 'QCM' },
  truefalse: { label: 'Vrai / Faux', short: 'V/F' },
  matching: { label: 'Appariement', short: 'APP' },
  cloze: { label: 'Cloze (réponses intégrées)', short: 'CLOZE' },
  shortanswer: { label: 'Réponse courte', short: 'RC' },
  numerical: { label: 'Numérique', short: 'NUM' },
  essay: { label: 'Composition', short: 'COMP' },
  description: { label: 'Description', short: 'DESC' },
}
export const typeLabel = (t: string): string => TYPES[t]?.label ?? t
export const typeShort = (t: string): string => TYPES[t]?.short ?? t.slice(0, 5).toUpperCase()

export const STATUS: Record<Status, string> = { '': 'Aucun statut', brouillon: 'Brouillon', a_reviser: 'À réviser', validee: 'Validée' }

export const CREATABLE = ['multichoice', 'truefalse', 'matching', 'cloze', 'shortanswer', 'description']

const answer = (fraction: string, text: string, format: string | undefined = 'html'): Answer => ({
  k: uid(),
  fraction,
  rt: emptyRt(format, text),
  feedback: emptyRt('html'),
  extra: [],
})

export function newQuestion(type: string, category: string, order: number): Question {
  const now = Date.now()
  const q: Question = {
    id: uid(),
    type,
    category,
    fields: [
      { kind: 'text', tag: 'name', rt: { text: 'Nouvelle question', files: [] } },
      { kind: 'text', tag: 'questiontext', rt: emptyRt() },
      { kind: 'text', tag: 'generalfeedback', rt: emptyRt() },
      { kind: 'prop', tag: 'defaultgrade', value: type === 'description' ? '0' : '1' },
      { kind: 'prop', tag: 'penalty', value: type === 'truefalse' ? '1' : type === 'description' ? '0' : '0.3333333' },
      { kind: 'prop', tag: 'hidden', value: '0' },
      { kind: 'prop', tag: 'idnumber', value: '' },
    ],
    answers: [],
    subquestions: [],
    tags: [],
    hasTags: false,
    extra: [],
    meta: { status: 'brouillon', note: '', order, created: now, modified: now },
  }
  const combined = () => {
    setText(q, 'correctfeedback', emptyRt('html', 'Votre réponse est correcte.'))
    setText(q, 'partiallycorrectfeedback', emptyRt('html', 'Votre réponse est partiellement correcte.'))
    setText(q, 'incorrectfeedback', emptyRt('html', 'Votre réponse est incorrecte.'))
    setProp(q, 'shownumcorrect', '')
  }
  if (type === 'multichoice') {
    setProp(q, 'single', 'true')
    setProp(q, 'shuffleanswers', 'true')
    setProp(q, 'answernumbering', 'abc')
    setProp(q, 'showstandardinstruction', '0')
    combined()
    q.answers = [answer('100', ''), answer('0', ''), answer('0', ''), answer('0', '')]
  } else if (type === 'truefalse') {
    q.answers = [answer('100', 'true', 'moodle_auto_format'), answer('0', 'false', 'moodle_auto_format')]
  } else if (type === 'matching') {
    setProp(q, 'shuffleanswers', 'true')
    combined()
    q.subquestions = [0, 1, 2].map(() => ({ k: uid(), rt: emptyRt(), answer: '', extra: [] }))
  } else if (type === 'shortanswer') {
    setProp(q, 'usecase', '0')
    q.answers = [answer('100', '', 'moodle_auto_format')]
  }
  return q
}

/** Copie sans les identifiants internes : sert à comparer deux questions. */
export function comparable(q: Question): unknown {
  return {
    type: q.type,
    category: q.category,
    fields: q.fields,
    answers: q.answers.map(({ k: _k, ...a }) => a),
    subquestions: q.subquestions.map(({ k: _k, ...s }) => s),
    tags: q.tags,
    extra: q.extra,
  }
}
