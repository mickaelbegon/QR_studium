import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as db from './db'
import { QuestionEditor } from './Editor'
import { ExamsView, PrintSheet, points } from './Exams'
import { fileData } from './files'
import { type Issue, findDuplicates, lintQuestion, worst } from './lint'
import { CREATABLE, type Exam, type Question, type Review, SEP, emptyReview, emptyRt, setProp, setText, uid, STATUS, type Status, type Version, categoryKey, categoryLabel, categoryParts, mapCategory, fold, getProp, getText, newQuestion, plain, qName, searchText, typeLabel, typeShort } from './model'
import { serializeBank } from './moodleXml'
import { Issues, QuestionPreview } from './Preview'
import { type Report, type Suggestion, backupNotes, correctedCategory, exportReport, sameTags, syncTags } from './report'
import { DIRECTIONS, PERTINENCES, ReportView, ReviewBox, directionClass } from './ReviewPanel'
import { ProposalBox, parseProposals } from './Proposals'
import { useBank } from './store'
import { StudentView } from './Student'
import { ClaudePanel } from './Claude'

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
/** Table de titres d'un fichier JSON [{ id_origine, nouveau }] ; `null` si le fichier est autre chose. */
function parseTitles(text: string): Map<number, string> | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(data) || !data.length || !data.every((x) => x && typeof x === 'object' && 'id_origine' in x && typeof (x as { nouveau?: unknown }).nouveau === 'string')) return null
  const out = new Map<number, string>()
  for (const x of data as { id_origine: string | number; nouveau: string }[]) {
    const id = parseInt(String(x.id_origine), 10)
    if (Number.isFinite(id) && x.nouveau.trim()) out.set(id, x.nouveau.trim())
  }
  return out
}
const NEW_CATEGORY = '\u0000nouvelle'
const AUTO_KEY = 'qr.auto'
const FRESH_KEY = 'qr.fresh'
// Une case à cocher ne bloque pas les raccourcis clavier.
// Largeurs des colonnes, réglables à la souris et mémorisées d'un lancement à l'autre.
const COLS_KEY = 'qr.cols'
const COLS = { side: { def: 240, min: 130, max: 520 }, list: { def: 380, min: 220, max: 900 }, claude: { def: 440, min: 320, max: 1000 } }
export type Col = keyof typeof COLS
const defaultCols = (): Record<Col, number> => ({ side: COLS.side.def, list: COLS.list.def, claude: COLS.claude.def })
const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && !(t instanceof HTMLInputElement && t.type === 'checkbox') && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

export default function App() {
  const bank = useBank()
  const { questions, categories, exams, reports } = bank
  const [view, setView] = useState<'bank' | 'exams' | 'report'>('bank')
  const [fPert, setFPert] = useState('')
  const [fDir, setFDir] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const dirty = useRef(false)
  const [tab, setTab] = useState<'preview' | 'student' | 'history'>('preview')
  const [query, setQuery] = useState('')
  const [fType, setFType] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fIssues, setFIssues] = useState(false)
  const [fProp, setFProp] = useState(false)
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
  const [undo, setUndo] = useState<(() => void) | null>(null)
  const toastTimer = useRef(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const lastPick = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [claude, setClaude] = useState(false)
  const [cols, setCols] = useState<Record<Col, number>>(() => {
    try {
      return { ...defaultCols(), ...JSON.parse(localStorage.getItem(COLS_KEY) ?? '{}') }
    } catch {
      return defaultCols()
    }
  })
  useEffect(() => {
    for (const k of Object.keys(COLS) as Col[]) document.documentElement.style.setProperty('--w-' + k, cols[k] + 'px')
  }, [cols])
  const keepCols = (c: Record<Col, number>) => {
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(c))
    } catch {
      /* largeurs non mémorisées */
    }
  }
  /** Poignée d'une colonne : glisser pour élargir ou rétrécir, double-clic pour la largeur d'origine. */
  const grip = (col: Col, dir: 1 | -1) => ({
    title: 'Glisser pour élargir ou rétrécir · double-clic : largeur d’origine',
    onDoubleClick: () => {
      const next = { ...cols, [col]: COLS[col].def }
      setCols(next)
      keepCols(next)
    },
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const handle = e.currentTarget
      const x0 = e.clientX
      const w0 = cols[col]
      let last = cols
      handle.setPointerCapture(e.pointerId)
      handle.classList.add('drag')
      document.body.classList.add('resizing')
      const move = (ev: PointerEvent) => {
        // La dernière colonne garde toujours une largeur utilisable.
        const room = window.innerWidth - 260 - (col === 'claude' ? 300 : (claude ? cols.claude : 0) + (col === 'side' ? cols.list : cols.side))
        const w = Math.round(Math.max(COLS[col].min, Math.min(COLS[col].max, room, w0 + dir * (ev.clientX - x0))))
        last = { ...cols, [col]: w }
        setCols(last)
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        handle.removeEventListener('pointercancel', up)
        handle.classList.remove('drag')
        document.body.classList.remove('resizing')
        keepCols(last)
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      handle.addEventListener('pointercancel', up)
    },
  })
  const fileInput = useRef<HTMLInputElement>(null)
  const updateInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  const setExamId = (id: string | null) => {
    setExamIdRaw(id)
    try {
      id ? localStorage.setItem('qr.exam', id) : localStorage.removeItem('qr.exam')
    } catch {
      /* préférence non mémorisée */
    }
  }
  /** Message en bas d'écran ; avec `onUndo`, il reste plus longtemps et propose « Annuler ». */
  const say = (msg: string, onUndo?: () => void) => {
    clearTimeout(toastTimer.current)
    setToast(msg)
    setUndo(onUndo ? () => onUndo : null)
    toastTimer.current = window.setTimeout(() => {
      setToast('')
      setUndo(null)
    }, onUndo ? 15000 : 5000)
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
    // Ordre de l'arbre : celui de la banque (rang médian des questions de chaque catégorie), pas l'ordre alphabétique,
    // pour que les cours restent dans l'ordre même sans numéro dans leur nom. La médiane ne bouge pas quand on
    // déplace quelques questions d'une catégorie à l'autre. Les catégories vides vont à la fin.
    const orders = new Map<string, number[]>()
    for (const q of questions) {
      const parts = categoryParts(q.category)
      parts.forEach((_, i) => {
        const key = parts.slice(0, i + 1).join(SEP)
        const list = orders.get(key)
        list ? list.push(q.meta.order) : orders.set(key, [q.meta.order])
      })
    }
    const first = new Map([...orders].map(([k, v]) => [k, v.sort((x, y) => x - y)[v.length >> 1]]))
    const rank = (key: string) => {
      const parts = key.split(SEP)
      return parts.map((label, i) => ({ at: first.get(parts.slice(0, i + 1).join(SEP)) ?? Infinity, label }))
    }
    const ranks = new Map([...nodes.keys()].map((k) => [k, rank(k)]))
    return [...nodes.values()].sort((a, b) => {
      const ra = ranks.get(a.key)!
      const rb = ranks.get(b.key)!
      for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
        if (ra[i].label === rb[i].label) continue
        return ra[i].at !== rb[i].at ? (ra[i].at < rb[i].at ? -1 : 1) : ra[i].label.localeCompare(rb[i].label, 'fr')
      }
      return ra.length - rb.length
    })
  }, [questions, categories])

  // ---- Catégories : renommer, remplacer dans les noms, supprimer les vides ----
  const activeNode = tree.find((n) => n.key === cat) ?? null
  const emptyPaths = useMemo(() => {
    const used = new Set<string>()
    for (const q of questions) {
      const parts = categoryParts(q.category)
      parts.forEach((_, i) => used.add(parts.slice(0, i + 1).join(SEP)))
    }
    return categories.map((c) => c.path).filter((p) => !used.has(categoryKey(p)))
  }, [questions, categories])
  const renameCategory = async () => {
    if (!activeNode || !leaveEdit()) return
    const depth = activeNode.depth
    const prefix = activeNode.key.split(SEP)
    const name = prompt('Nouveau nom de la catégorie :', activeNode.label)?.trim()
    if (!name || name === activeNode.label) return
    const under = (parts: string[]) => prefix.every((p, i) => parts[i] === p)
    const r = await bank.renameCategories((path) => (path && under(categoryParts(path)) ? mapCategory(path, (parts) => parts.map((p, i) => (i === depth ? name : p))) : path))
    setCat([...prefix.slice(0, depth), name].join(SEP))
    say(`Catégorie renommée en « ${name} » (${r.questions} question${r.questions > 1 ? 's' : ''} concernée${r.questions > 1 ? 's' : ''}).`)
  }
  const replaceInCategories = async () => {
    if (!leaveEdit()) return
    const find = prompt('Texte à remplacer dans les noms de catégories.\nUne expression régulière est acceptée ; celle proposée retire « Cours 03 – », « Cours 07-08 – », etc.', '^Cours \\d+(-\\d+)? [–-] ')
    if (!find) return
    const by = prompt('Remplacer par (laisser vide pour retirer) :', '')
    if (by === null) return
    let re: RegExp
    try {
      re = new RegExp(find, 'u')
    } catch {
      return alert('Expression invalide : ' + find)
    }
    const fn = (path: string) => (path ? mapCategory(path, (parts) => parts.map((p) => p.replace(re, by).trim() || p)) : path)
    const before = [...new Set([...categories.map((c) => c.path), ...questions.map((q) => q.category)])]
    const moved = before.filter((p) => fn(p) !== p)
    if (!moved.length) return say('Aucun nom de catégorie ne contient ce texte.')
    const sample = moved.slice(0, 6).map((p) => `• ${categoryLabel(p)}\n   → ${categoryLabel(fn(p))}`).join('\n')
    if (!confirm(`${moved.length} catégorie${moved.length > 1 ? 's' : ''} à renommer :\n\n${sample}${moved.length > 6 ? `\n… et ${moved.length - 6} autre${moved.length - 6 > 1 ? 's' : ''}` : ''}\n\nContinuer ?`)) return
    const r = await bank.renameCategories(fn)
    setCat(null)
    say(`${moved.length} catégorie${moved.length > 1 ? 's' : ''} renommée${moved.length > 1 ? 's' : ''} (${r.questions} question${r.questions > 1 ? 's' : ''} concernée${r.questions > 1 ? 's' : ''}).`)
  }
  const removeEmptyCategories = async () => {
    const n = emptyPaths.length
    if (!n || !confirm(`Supprimer ${n} catégorie${n > 1 ? 's' : ''} vide${n > 1 ? 's' : ''} ?\n\n${emptyPaths.slice(0, 10).map((p) => '• ' + categoryLabel(p)).join('\n')}${n > 10 ? '\n…' : ''}`)) return
    await bank.removeCategories(emptyPaths)
    if (cat !== null && !questions.some((q) => categoryKey(q.category) === cat || categoryKey(q.category).startsWith(cat + SEP))) setCat(null)
    say(`${n} catégorie${n > 1 ? 's' : ''} vide${n > 1 ? 's' : ''} supprimée${n > 1 ? 's' : ''}.`)
  }

  const filtered = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean)
    return questions.filter((q) => {
      if (fType && q.type !== fType) return false
      if (fStatus && (q.meta.status || 'aucun') !== fStatus) return false
      if (fIssues && !worst(issues.get(q.id) ?? [])) return false
      if (fProp && !q.meta.proposal) return false
      if (fPert && (q.meta.review?.pertinence ?? '') !== fPert) return false
      if (fDir && (q.meta.review?.direction ?? '') !== fDir) return false
      if (cat !== null) {
        const key = categoryKey(q.category)
        if (key !== cat && !key.startsWith(cat + SEP)) return false
      }
      const text = index.get(q.id) ?? ''
      return words.every((w) => text.includes(w))
    })
  }, [questions, query, fType, fStatus, fIssues, fProp, fPert, fDir, cat, index, issues])

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
    if (tab === 'history') setTab('preview')
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
        // Un fichier de titres : [{ id_origine, nouveau }]. Seul le titre des questions reconnues change.
        const titles = parseTitles(await f.text())
        if (titles) {
          const plan = bank.planTitles(titles)
          const n = plan.updates.length
          const rest = `${plan.same} déjà à jour` + (plan.unknown ? `, ${plan.unknown} sans correspondance` : '')
          if (!n) msgs.push(`« ${f.name} » : aucun titre à changer (${rest})`)
          else if (confirm(`« ${f.name} » renomme ${n} question${n > 1 ? 's' : ''} (${rest}).\n\n${plan.updates.slice(0, 6).map((q) => '• ' + qName(q)).join('\n')}${n > 6 ? '\n…' : ''}\n\nSeul le titre change ; l’ancien reste dans l’historique. Continuer ?`)) {
            await bank.applyUpdate(plan, `Titre renommé depuis ${f.name}`)
            msgs.push(`« ${f.name} » : ${n} question${n > 1 ? 's' : ''} renommée${n > 1 ? 's' : ''}`)
          } else msgs.push(`« ${f.name} » : renommage annulé`)
          continue
        }
        // Un fichier de propositions de distracteurs se reconnaît à son contenu.
        const proposals = parseProposals(await f.text())
        if (proposals) {
          const p = await bank.importProposals(proposals)
          msgs.push(`« ${f.name} » : ${p.matched} proposition${p.matched > 1 ? 's' : ''} de distracteurs rattachée${p.matched > 1 ? 's' : ''} sur ${p.total}`)
          continue
        }
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

  /** Remplace le contenu des questions de la banque par celui d'un fichier corrigé (même identifiant d'origine ou même nom). */
  const updateFromFile = async (file: File | undefined) => {
    if (!file || !leaveEdit()) return
    setBusy(true)
    try {
      const plan = await bank.planUpdate(file)
      const n = plan.updates.length
      const rest = `${plan.same} identique${plan.same > 1 ? 's' : ''}` + (plan.unknown ? `, ${plan.unknown} sans correspondance dans la banque (ignorée${plan.unknown > 1 ? 's' : ''})` : '')
      if (!n) return say(`Aucune question à mettre à jour : ${rest}.`)
      const names = plan.updates.slice(0, 8).map((q) => '• ' + (qName(q) || '(sans nom)')).join('\n')
      if (!confirm(`« ${file.name} » modifie ${n} question${n > 1 ? 's' : ''} de la banque (${rest}).\n\n${names}${n > 8 ? `\n… et ${n - 8} autre${n - 8 > 1 ? 's' : ''}` : ''}\n\nLa version actuelle de chacune restera dans son historique. Catégories, étiquettes, notes et examens ne changent pas. Continuer ?`)) return
      await bank.applyUpdate(plan, `Mise à jour depuis ${file.name}`)
      say(`${n} question${n > 1 ? 's' : ''} mise${n > 1 ? 's' : ''} à jour depuis « ${file.name} ».`)
    } catch (e) {
      alert('Mise à jour impossible : ' + (e instanceof Error ? e.message : String(e)))
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
        const remember = () => {
          try {
            localStorage.setItem(AUTO_KEY, JSON.stringify(Object.fromEntries(list.map((f) => [f.name, `${f.size}-${f.mtime}`]))))
          } catch {
            /* les fichiers seront simplement relus au prochain lancement */
          }
        }
        // Banque vide (autre navigateur, données du site effacées) : la dernière sauvegarde passe avant
        // les fichiers d'origine, sauf si la banque vient d'être vidée volontairement.
        let fresh = false
        try {
          fresh = localStorage.getItem(FRESH_KEY) === '1'
          localStorage.removeItem(FRESH_KEY)
        } catch {
          /* pas de préférence mémorisée */
        }
        if (!questions.length && !fresh) {
          const saves: { name: string }[] = await (await fetch('/api/data-prive?dossier=sauvegardes')).json()
          const latest = saves.map((f) => f.name).filter((n) => n.startsWith('banque-')).sort().pop()
          if (latest) {
            const day = latest.slice(7, 17)
            const get = async (name: string) => {
              const r = await fetch('/api/data-prive?dossier=sauvegardes&name=' + name)
              return r.ok ? new File([await r.blob()], name) : null
            }
            setBusy(true)
            say(`Restauration de la sauvegarde du ${day}…`)
            const notes = saves.some((f) => f.name === `notes-${day}.json`) ? await get(`notes-${day}.json`) : null
            const xml = await get(latest)
            if (xml) {
              await importFiles(notes ? [xml, notes] : [xml])
              let exams = 0
              if (notes) {
                try {
                  exams = await bank.restoreExams(JSON.parse(await notes.text()).examens ?? [])
                } catch {
                  /* fichier de notes sans examens */
                }
              }
              // Les fichiers d'origine sont déjà contenus dans la sauvegarde : inutile de les réimporter.
              remember()
              say(`Banque restaurée depuis la sauvegarde du ${day}` + (exams ? ` (${exams} examen${exams > 1 ? 's' : ''}).` : '.'))
              return
            }
          }
        }
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

  // ---- Sauvegarde automatique dans data_prive/sauvegardes/ (quelques secondes après chaque changement) ----
  const [backup, setBackup] = useState('')
  const saved = useRef<{ q: Question[] | null; e: Exam[] }>({ q: null, e: [] })
  useEffect(() => {
    if (!bank.loaded) return
    if (saved.current.q === null) {
      saved.current = { q: questions, e: exams }
      return
    }
    // Une banque vide n'écrase jamais une sauvegarde existante.
    if (!questions.length || (saved.current.q === questions && saved.current.e === exams)) return
    setBackup('pending')
    const timer = setTimeout(async () => {
      setBackup('saving')
      const now = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
      const post = async (name: string, body: string) => {
        const r = await fetch('/api/sauvegarde?name=' + name, { method: 'POST', body: new Blob([body]) })
        if (!r.ok) throw new Error(String(r.status))
      }
      try {
        if (saved.current.q !== questions) await post(`banque-${day}.xml`, serializeBank(questions, categories, fileData))
        await post(`notes-${day}.json`, backupNotes(reports[0], questions, exams, qName))
        saved.current = { q: questions, e: exams }
        setBackup(`${p(now.getHours())}:${p(now.getMinutes())}`)
      } catch {
        setBackup('error')
      }
    }, 6000)
    return () => clearTimeout(timer)
  }, [bank.loaded, questions, exams])

  // ---- Notes de révision : les étiquettes et la catégorie suivent la note ----
  const changeReview = async (q: Question, review: Review, o: { category?: string | null; note?: string } = {}) => {
    const tags = syncTags(q.tags, review)
    const category = o.category ?? q.category
    if (sameTags(tags, q.tags) && category === q.category) return bank.updateMeta(q.id, { review })
    await bank.saveQuestion({ ...q, tags, category, meta: { ...q.meta, review } }, o.note ?? 'Note de révision mise à jour')
  }
  const markCorrected = async (q: Question) => {
    const r = q.meta.review
    if (!r) return
    const category = correctedCategory(q.category, r.pertinence, categories.map((c) => c.path))
    await changeReview(q, { ...r, direction: 'Garder', probleme: '', correction: '', cle: '', edited: true }, { category, note: 'Question corrigée' })
    say('Marquée comme corrigée' + (category ? ` et déplacée vers « ${categoryLabel(category)} ».` : '. Sa catégorie n’a pas changé.'))
  }
  const removeReview = async (q: Question) => {
    const r = q.meta.review
    if (!r || !confirm('Supprimer la note de révision de cette question ?')) return
    await changeReview(q, { ...emptyReview(), origine: r.origine, theme: r.theme, doublons: r.doublons, edited: true, removed: true }, { note: 'Note de révision supprimée' })
  }

  // ---- Sélection par cases à cocher et suppression en lot ----
  const pickedShown = filtered.filter((q) => picked.has(q.id))
  const togglePick = (id: string, range: boolean) => {
    const next = new Set(picked)
    const on = !next.has(id)
    const a = filtered.findIndex((q) => q.id === lastPick.current)
    const b = filtered.findIndex((q) => q.id === id)
    // Maj+clic : toute la plage depuis la dernière case cochée.
    if (range && a >= 0 && b >= 0) for (const q of filtered.slice(Math.min(a, b), Math.max(a, b) + 1)) on ? next.add(q.id) : next.delete(q.id)
    else on ? next.add(id) : next.delete(id)
    lastPick.current = id
    setPicked(next)
  }
  /** Déplace les questions cochées ; `target` vide = demander le chemin d'une nouvelle catégorie. */
  const movePicked = async (target: string) => {
    const moving = pickedShown
    if (!moving.length || !leaveEdit()) return
    let category = target
    if (target === NEW_CATEGORY) {
      const base = moving[0].category || categories[0]?.path || ''
      const typed = prompt('Chemin de la nouvelle catégorie (niveaux séparés par « › ») :', base ? categoryLabel(base) : '')?.trim()
      if (!typed) return
      const parts = typed.split('›').map((s) => s.trim()).filter(Boolean)
      if (!parts.length) return
      category = base ? mapCategory(base, () => parts) : '$course$/top/' + parts.map((s) => s.replace(/\//g, '//')).join('/')
    }
    const before = new Map(moving.map((q) => [q.id, q.category]))
    const n = await bank.moveQuestions(new Map(moving.map((q) => [q.id, category])))
    if (!n) return say('Ces questions sont déjà dans cette catégorie.')
    setPicked(new Set())
    say(`${n} question${n > 1 ? 's' : ''} déplacée${n > 1 ? 's' : ''} vers « ${categoryLabel(category)} ».`, async () => {
      await bank.moveQuestions(before)
      say(`${n} question${n > 1 ? 's' : ''} remise${n > 1 ? 's' : ''} dans ${n > 1 ? 'leur catégorie' : 'sa catégorie'} d’origine.`)
    })
  }
  const deletePicked = async () => {
    const gone = pickedShown
    if (!gone.length || !leaveEdit()) return
    if (!confirm(`Supprimer ${gone.length} question${gone.length > 1 ? 's' : ''} de la banque locale ?`)) return
    const examsBefore = exams
    await bank.removeQuestions(gone.map((q) => q.id))
    setPicked(new Set())
    if (gone.some((q) => q.id === sel)) setSel(null)
    say(`${gone.length} question${gone.length > 1 ? 's' : ''} supprimée${gone.length > 1 ? 's' : ''}.`, async () => {
      await bank.restore(gone, examsBefore)
      say(`${gone.length} question${gone.length > 1 ? 's' : ''} rétablie${gone.length > 1 ? 's' : ''}.`)
    })
  }

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
  // ---- Propositions de l'assistant Claude ----
  const addProposal = async (p: Question) => {
    if (!leaveEdit()) return
    const category = current?.category ?? categories[0]?.path ?? ''
    const q = await bank.saveQuestion({ ...p, id: uid(), category, meta: { ...p.meta, status: 'brouillon', source: 'Claude', order: bank.nextOrder() } })
    setCat(null)
    setQuery('')
    setFType('')
    setFStatus('')
    setFIssues(false)
    setFDir('')
    setFPert('')
    setView('bank')
    setSel(q.id)
    say('Proposition ajoutée à la banque comme brouillon' + (category ? ` dans « ${categoryLabel(category)} ».` : '.'))
  }
  const replaceWithProposal = async (p: Question) => {
    if (!current || !leaveEdit()) return
    // La question garde son identité : catégorie, étiquettes, notes et place dans les examens.
    await bank.saveQuestion({ ...p, id: current.id, category: current.category, tags: current.tags, hasTags: current.hasTags, meta: current.meta }, 'Remplacée par une proposition de Claude')
    say('Question remplacée. L’ancienne version reste dans l’historique.')
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
        className={'app' + (claude ? ' with-claude' : '')}
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
          {backup && backup !== 'error' && (
            <span className="backup" title="Sauvegarde automatique dans data_prive/sauvegardes">
              {backup === 'pending' ? 'Modifications à sauvegarder…' : backup === 'saving' ? 'Sauvegarde…' : `Sauvegardé à ${backup}`}
            </span>
          )}
          {backup === 'error' && (
            <span className="backup bad" title="Le dossier data_prive/sauvegardes n’a pas pu être écrit. Lancez l’application avec lancer.bat et exportez la banque à la main en attendant.">
              Sauvegarde impossible
            </span>
          )}
          <button className={claude ? 'on-claude' : ''} onClick={() => setClaude(!claude)} title="Demander à Claude de générer ou d’améliorer des questions">
            Claude
          </button>
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
              <button disabled={busy || !questions.length} title="Remplace le contenu des questions déjà dans la banque par celui d’un fichier Moodle XML corrigé. Les questions sont reconnues par leur identifiant d’origine ou leur nom ; rien n’est ajouté." onClick={() => updateInput.current?.click()}>
                Appliquer un fichier corrigé (XML)…
              </button>
              <input ref={updateInput} type="file" accept=".xml" hidden onChange={(e) => updateFromFile(e.target.files?.[0]).then(() => (e.target.value = ''))} />
              <button
                className="danger"
                onClick={() => {
                  if (confirm('Vider complètement la banque locale (questions, examens, historique) ? Vos fichiers XML d’origine ne sont pas touchés.')) {
                    bank.clear()
                    // Au prochain lancement : repartir des fichiers d'origine, pas de la sauvegarde.
                    try {
                      localStorage.setItem(FRESH_KEY, '1')
                    } catch {
                      /* sans effet si le stockage est indisponible */
                    }
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
            <p className="hint">Les questions restent sur cet ordinateur (stockage local du navigateur). Rien n’est envoyé sur Internet, sauf ce que vous choisissez d’envoyer à l’assistant Claude.</p>
          </div>
        ) : (
          <main className="layout">
            <div className="col-grip g-side" {...grip('side', 1)} />
            <div className="col-grip g-list" {...grip('list', 1)} />
            <aside className="sidebar">
              <div className="side-title">Catégories</div>
              <div className="cat-tools">
                <button disabled={!activeNode || activeNode.label.startsWith('(')} title={activeNode ? 'Renommer la catégorie sélectionnée' : 'Sélectionnez d’abord une catégorie'} onClick={renameCategory}>
                  Renommer
                </button>
                <button title="Rechercher et remplacer dans les noms de toutes les catégories (par exemple retirer « Cours 03 – »)" onClick={replaceInCategories}>
                  Remplacer…
                </button>
                {emptyPaths.length > 0 && (
                  <button className="danger" title="Supprimer les catégories qui ne contiennent plus aucune question" onClick={removeEmptyCategories}>
                    Vides ({emptyPaths.length}) ✕
                  </button>
                )}
              </div>
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
              {questions.some((q) => q.meta.review && !q.meta.review.removed) && (
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
              {questions.some((q) => q.meta.proposal) && (
                <label className="check">
                  <input type="checkbox" checked={fProp} onChange={(e) => setFProp(e.target.checked)} />
                  Avec distracteurs proposés ({questions.filter((q) => q.meta.proposal).length})
                </label>
              )}
              <p className="hint keys">
                Clavier : ↑ ↓ naviguer · <kbd>e</kbd> modifier · <kbd>a</kbd> ajouter à l’examen · <kbd>/</kbd> rechercher
              </p>
            </aside>

            <section className="list">
              <div className="list-head">
                <input ref={searchInput} type="search" placeholder="Rechercher dans les énoncés, réponses, étiquettes…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()} />
                <div className="bulk">
                  <label className="check" title="Cocher ou décocher toutes les questions affichées">
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && pickedShown.length === filtered.length}
                      ref={(el) => {
                        if (el) el.indeterminate = pickedShown.length > 0 && pickedShown.length < filtered.length
                      }}
                      onChange={(e) => setPicked(e.target.checked ? new Set(filtered.map((q) => q.id)) : new Set())}
                    />
                    {pickedShown.length ? `${pickedShown.length} sélectionnée${pickedShown.length > 1 ? 's' : ''}` : 'Tout cocher'}
                  </label>
                  <span className="grow" />
                  {pickedShown.length > 0 && (
                    <>
                      <button onClick={() => setPicked(new Set())}>Décocher</button>
                      <select className="move" value="" title="Déplacer les questions cochées vers une autre catégorie" onChange={(e) => e.target.value && movePicked(e.target.value)}>
                        <option value="">Déplacer ({pickedShown.length}) vers…</option>
                        {[...categories]
                          .sort((a, b) => a.path.localeCompare(b.path, 'fr'))
                          .map((c) => (
                            <option key={c.path} value={c.path}>
                              {categoryLabel(c.path)}
                            </option>
                          ))}
                        <option value={NEW_CATEGORY}>+ Nouvelle catégorie…</option>
                      </select>
                      <button className="danger solid" onClick={deletePicked}>
                        Supprimer ({pickedShown.length})
                      </button>
                    </>
                  )}
                </div>
                <div className="list-count">
                  {filtered.length} question{filtered.length > 1 ? 's' : ''} · {+filtered.reduce((s, q) => s + points(q), 0).toFixed(2)} points
                </div>
              </div>
              <div className="rows">
                {filtered.map((q) => {
                  const level = worst(issues.get(q.id) ?? [])
                  const inExam = !!exam?.items.includes(q.id)
                  return (
                    <div key={q.id} className={'q-row' + (q.id === sel ? ' active' : '') + (picked.has(q.id) ? ' picked' : '')} onClick={() => select(q.id)}>
                      <input type="checkbox" className="pick" title="Sélectionner (Maj+clic pour une plage)" checked={picked.has(q.id)} onClick={(e) => e.stopPropagation()} onChange={(e) => togglePick(q.id, (e.nativeEvent as MouseEvent).shiftKey)} />
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
                      {q.meta.proposal && <span className={'chip ' + (q.meta.proposal.priorite === 'haute' ? 'fix' : q.meta.proposal.priorite === 'moyenne' ? 'improve' : 'low')} title={'Distracteurs proposés : ' + q.meta.proposal.probleme}>Distr.</span>}
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
                    <select
                      className="move"
                      value=""
                      title="Changer la question de catégorie"
                      onChange={async (e) => {
                        const category = e.target.value
                        if (!category || category === current.category) return
                        await bank.saveQuestion({ ...current, category }, 'Changement de catégorie')
                        say(`Déplacée vers « ${categoryLabel(category)} ».`)
                      }}
                    >
                      <option value="">Déplacer vers…</option>
                      {[...categories]
                        .sort((a, b) => a.path.localeCompare(b.path, 'fr'))
                        .map((c) => (
                          <option key={c.path} value={c.path} disabled={c.path === current.category}>
                            {categoryLabel(c.path)}
                          </option>
                        ))}
                    </select>
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
                  <ReviewBox q={current} onChange={(review) => changeReview(current, review)} onCorrected={() => markCorrected(current)} onRemove={() => removeReview(current)} />
                  <ProposalBox
                    q={current}
                    onEdit={() => setEditing(true)}
                    onApply={async (next) => {
                      await bank.saveQuestion(next, 'Distracteurs proposés appliqués')
                      say('Distracteurs remplacés. L’ancienne version reste dans l’historique.')
                    }}
                    onDismiss={() => {
                      const { proposal: _gone, ...meta } = current.meta
                      bank.saveMeta(current.id, meta)
                    }}
                  />
                  <Issues issues={issues.get(current.id) ?? []} />
                  <div className="tabs">
                    <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>
                      Aperçu avec corrigé
                    </button>
                    <button className={tab === 'student' ? 'on' : ''} onClick={() => setTab('student')} title="La question telle que l’étudiant la voit et y répond dans StudiUM">
                      Vue étudiant
                    </button>
                    <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>
                      Historique
                    </button>
                  </div>
                  {tab === 'preview' ? <QuestionPreview q={current} /> : tab === 'student' ? <StudentView key={current.id + ':' + current.meta.modified} q={current} /> : <History q={current} onRestore={(snap) => bank.saveQuestion({ ...snap, meta: { ...current.meta } }, 'Restauration d’une version antérieure')} />}
                </div>
              )}
            </section>
          </main>
        )}
        {toast && (
          <div className="toast">
            {toast}
            {undo && (
              <button
                onClick={() => {
                  const fn = undo
                  setUndo(null)
                  fn()
                }}
              >
                Annuler
              </button>
            )}
          </div>
        )}
      </div>
      <ClaudePanel grip={grip('claude', -1)} open={claude} onClose={() => setClaude(false)} current={view === 'bank' ? current : null} onAdd={addProposal} onReplace={replaceWithProposal} />
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
