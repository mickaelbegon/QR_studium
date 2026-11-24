// Rapport d'analyse (JSON) accompagnant une banque : notes de révision par question,
// défauts récurrents, lacunes et questions suggérées.
// Le lien avec le XML se fait par l'étiquette « id-origine-<ID> » portée par chaque question.
import type { Question, Review } from './model'

export interface ReportEntry {
  id_moodle_origine: number
  pertinence?: string | null
  statut?: string | null
  theme?: string | null
  probleme?: string | null
  correction_proposee?: string | null
  doublons_retires?: number[]
  [k: string]: unknown
}

export interface Suggestion {
  theme?: string
  enonce: string
  options: string[]
  bonne_reponse: number
  pertinence_visee?: string
}

export interface ReportData {
  meta?: Record<string, unknown>
  questions: ReportEntry[]
  cles_discutables?: { id: number; probleme: string }[]
  defauts_recurrents?: { defaut: string; portee?: string; correction?: string }[]
  lacunes?: { theme: string; constat?: string; objectif_plan_de_cours?: string }[]
  questions_suggerees?: Suggestion[]
  [k: string]: unknown
}

export interface Report {
  name: string
  imported: number
  data: ReportData
}

export function parseReport(json: string, name: string): Report {
  let data: ReportData
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error(`« ${name} » n'est pas un fichier JSON valide.`)
  }
  if (!data || !Array.isArray(data.questions)) throw new Error(`« ${name} » n'est pas un rapport reconnu (liste « questions » absente).`)
  return { name, imported: Date.now(), data }
}

export function originId(q: Question): number | null {
  for (const t of q.tags) {
    const m = /^id-origine-(\d+)$/.exec(t.trim())
    if (m) return +m[1]
  }
  return null
}

export function reviewIndex(data: ReportData): Map<number, Review> {
  const keys = new Map((data.cles_discutables ?? []).map((c) => [c.id, c.probleme]))
  const index = new Map<number, Review>()
  for (const e of data.questions) {
    index.set(e.id_moodle_origine, {
      origine: e.id_moodle_origine,
      pertinence: e.pertinence ?? '',
      direction: e.statut ?? '',
      theme: e.theme ?? '',
      probleme: e.probleme ?? '',
      correction: e.correction_proposee ?? '',
      cle: keys.get(e.id_moodle_origine) ?? '',
      doublons: e.doublons_retires ?? [],
    })
  }
  return index
}

/** Rattache les notes du rapport aux questions ; ne remplace jamais une note modifiée dans l'application. */
export function applyReport(questions: Question[], data: ReportData): Question[] {
  const index = reviewIndex(data)
  const changed: Question[] = []
  for (const q of questions) {
    const id = originId(q)
    const review = id === null ? undefined : index.get(id)
    if (!review || q.meta.review?.edited) continue
    changed.push({ ...q, meta: { ...q.meta, review } })
  }
  return changed
}

/** Rapport mis à jour avec les notes actuelles de l'application (même format que le fichier d'origine). */
export function exportReport(report: Report, questions: Question[]): string {
  const byOrigin = new Map<number, Question>()
  for (const q of questions) {
    const id = q.meta.review?.origine ?? originId(q)
    if (id != null) byOrigin.set(id, q)
  }
  const entries = report.data.questions.map((e) => {
    const q = byOrigin.get(e.id_moodle_origine)
    const r = q?.meta.review
    if (!q || !r) return e
    return {
      ...e,
      pertinence: r.pertinence || null,
      statut: r.direction || null,
      probleme: r.probleme || null,
      correction_proposee: r.correction || null,
      etat_application: q.meta.status || null,
      note_privee: q.meta.note || null,
    }
  })
  const cles = questions.filter((q) => q.meta.review?.cle && q.meta.review.origine != null).map((q) => ({ id: q.meta.review!.origine!, probleme: q.meta.review!.cle }))
  return JSON.stringify({ ...report.data, cles_discutables: cles, questions: entries }, null, 2)
}
