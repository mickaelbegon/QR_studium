// Niveau cognitif d'une question : ce que l'étudiant doit faire pour répondre.
// Il est porté par une vraie étiquette Moodle (« niveau-sait »…), donc exporté vers StudiUM.
import type { Question } from './model'

export const LEVELS = [
  { key: 'sait', label: 'Sait', short: 'sait', hint: 'Restitue un fait, une définition, une unité, un nom' },
  { key: 'comprend', label: 'Comprend', short: 'compr.', hint: 'Explique, distingue deux notions, prédit un effet' },
  { key: 'sait-comment', label: 'Sait comment', short: 'comment', hint: 'Connaît la méthode, l’outil ou le réglage, sans l’exécuter' },
  { key: 'applique', label: 'Applique', short: 'appl.', hint: 'Calcule, applique une relation à un cas, lit une valeur' },
  { key: 'analyse', label: 'Analyse', short: 'anal.', hint: 'Interprète une figure ou un cas, raisonne en plusieurs étapes' },
] as const

const PREFIX = 'niveau-'
const KEYS = new Set<string>(LEVELS.map((l) => l.key))

/** Niveau d'une question, lu dans ses étiquettes ; chaîne vide si elle n'en a pas. */
export function levelOf(q: Question): string {
  for (const t of q.tags) {
    const k = t.trim().toLowerCase()
    if (k.startsWith(PREFIX) && KEYS.has(k.slice(PREFIX.length))) return k.slice(PREFIX.length)
  }
  return ''
}

export const levelInfo = (key: string) => LEVELS.find((l) => l.key === key)

/** La question avec son étiquette de niveau remplacée (ou retirée si `level` est vide). */
export function withLevel(q: Question, level: string): Question {
  const tags = q.tags.filter((t) => !t.trim().toLowerCase().startsWith(PREFIX))
  if (level && KEYS.has(level)) tags.push(PREFIX + level)
  return { ...q, tags, hasTags: q.hasTags || tags.length > 0 }
}

export interface LevelEntry {
  origine: number | null
  titre: string
  level: string
}

/** Lit un fichier de niveaux [{ cle | id_origine | titre, niveau }] ; `null` si le JSON est autre chose. */
export function parseLevels(text: string): LevelEntry[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(data) || !data.length || !data.every((x) => x && typeof x === 'object' && typeof (x as { niveau?: unknown }).niveau === 'string')) return null
  const out: LevelEntry[] = []
  for (const x of data as Record<string, unknown>[]) {
    const cle = String(x.cle ?? x.id_origine ?? '')
    const titre = cle.startsWith('T:') ? cle.slice(2) : String(x.titre ?? '')
    const origine = /^\d+$/.test(cle) ? parseInt(cle, 10) : null
    const level = String(x.niveau).trim().toLowerCase().replace(/\s+/g, '-')
    if ((origine === null && !titre) || !KEYS.has(level)) continue
    out.push({ origine, titre, level })
  }
  return out
}

/** Nombre de questions par niveau, dans l'ordre de LEVELS, plus celles sans niveau. */
export function levelCounts(questions: Question[]): { counts: number[]; none: number } {
  const counts = LEVELS.map(() => 0)
  let none = 0
  for (const q of questions) {
    const i = LEVELS.findIndex((l) => l.key === levelOf(q))
    if (i >= 0) counts[i]++
    else none++
  }
  return { counts, none }
}
