// Difficulté (1 à 5) et temps de réponse estimé (minutes) d'une question.
// Ces deux valeurs restent dans l'application : Moodle n'a pas de champ pour elles.
import type { Question } from './model'

export const DIFFICULTY: Record<number, string> = { 1: 'Rappel', 2: 'Compréhension', 3: 'Application', 4: 'Analyse', 5: 'Synthèse' }

export interface Score {
  /** Identifiant d'origine de la question, quand elle en a un. */
  origine: number | null
  /** Titre de la question, pour celles qui n'ont pas d'identifiant d'origine. */
  titre: string
  difficulty?: number
  minutes?: number
}

/** Lit un fichier de scores [{ cle | id_origine | titre, difficulte, temps_min }] ; `null` si le JSON est autre chose. */
export function parseScores(text: string): Score[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(data) || !data.length || !data.every((x) => x && typeof x === 'object' && ('difficulte' in x || 'temps_min' in x))) return null
  const out: Score[] = []
  for (const x of data as Record<string, unknown>[]) {
    const cle = String(x.cle ?? x.id_origine ?? '')
    const titre = cle.startsWith('T:') ? cle.slice(2) : String(x.titre ?? x.nom ?? '')
    const origine = /^\d+$/.test(cle) ? parseInt(cle, 10) : null
    const d = Math.round(Number(x.difficulte))
    const m = Number(x.temps_min)
    if (origine === null && !titre) continue
    out.push({ origine, titre, difficulty: d >= 1 && d <= 5 ? d : undefined, minutes: Number.isFinite(m) && m > 0 ? Math.round(m * 2) / 2 : undefined })
  }
  return out
}

const nf = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 1 })
export const fmtMin = (m: number): string => (m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')}` : `${nf.format(m)} min`)

/** Étiquette courte d'une question : « D3 · 2 min ». */
export function scoreLabel(q: Question): string {
  const parts = [q.meta.difficulty ? 'D' + q.meta.difficulty : '', q.meta.minutes ? fmtMin(q.meta.minutes) : ''].filter(Boolean)
  return parts.join(' · ')
}

export interface Stats {
  /** Difficulté moyenne des questions notées, ou `null` si aucune ne l'est. */
  mean: number | null
  /** Moyenne pondérée par les points de chaque question. */
  weighted: number | null
  minutes: number
  /** Nombre de questions par niveau (indice 1 à 5). */
  levels: number[]
  /** Questions sans difficulté / sans temps. */
  noDifficulty: number
  noMinutes: number
}

export function stats(questions: Question[], points: (q: Question) => number): Stats {
  const levels = [0, 0, 0, 0, 0, 0]
  let sum = 0
  let n = 0
  let wsum = 0
  let w = 0
  let minutes = 0
  let noMinutes = 0
  for (const q of questions) {
    const d = q.meta.difficulty
    if (d) {
      levels[d]++
      sum += d
      n++
      const p = points(q)
      wsum += d * p
      w += p
    }
    if (q.meta.minutes) minutes += q.meta.minutes
    else noMinutes++
  }
  return { mean: n ? sum / n : null, weighted: w ? wsum / w : null, minutes, levels, noDifficulty: questions.length - n, noMinutes }
}

/** Résumé en une ligne : « difficulté 2,8 · 54 min ». */
export function statsLabel(s: Stats): string {
  const parts = [s.mean !== null ? `difficulté ${nf.format(s.mean)}` : '', s.minutes ? fmtMin(s.minutes) : ''].filter(Boolean)
  return parts.join(' · ')
}
