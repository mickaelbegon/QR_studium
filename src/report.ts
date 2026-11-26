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
  categorie_xml?: string | null
  etat_application?: string | null
  note_privee?: string | null
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
  const entries = new Map(data.questions.map((e) => [e.id_moodle_origine, e]))
  const states = ['brouillon', 'a_reviser', 'validee']
  const changed: Question[] = []
  for (const q of questions) {
    const id = originId(q)
    const review = id === null ? undefined : index.get(id)
    if (!review || q.meta.review?.edited) continue
    // Un rapport exporté par l'application contient aussi le statut et la note privée :
    // on les reprend seulement s'ils sont vides ici.
    const e = entries.get(id!)
    const status = !q.meta.status && e?.etat_application && states.includes(e.etat_application) ? (e.etat_application as Question['meta']['status']) : q.meta.status
    const note = !q.meta.note && typeof e?.note_privee === 'string' ? e.note_privee : q.meta.note
    changed.push({ ...q, meta: { ...q.meta, status, note, review } })
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
  // Les listes dérivées suivent les notes actuelles, sinon elles contrediraient « questions ».
  const aCorriger = entries
    .filter((e) => e.statut === 'Corriger avant usage')
    .map((e) => ({ id_moodle_origine: e.id_moodle_origine, probleme: e.probleme ?? null, correction_proposee: e.correction_proposee ?? null, categorie_xml: e.categorie_xml ?? null }))
  const meta = { ...(report.data.meta ?? {}) } as Record<string, unknown>
  if (meta.repartition && typeof meta.repartition === 'object') {
    const rep: Record<string, Record<string, number>> = {}
    for (const theme of Object.keys(meta.repartition as object)) rep[theme] = { Haute: 0, Moyenne: 0, Faible: 0 }
    for (const e of entries) {
      if (!e.theme || !e.pertinence) continue
      rep[e.theme] ??= { Haute: 0, Moyenne: 0, Faible: 0 }
      rep[e.theme][e.pertinence] = (rep[e.theme][e.pertinence] ?? 0) + 1
    }
    meta.repartition = rep
  }
  const cles = questions.filter((q) => q.meta.review?.cle && q.meta.review.origine != null).map((q) => ({ id: q.meta.review!.origine!, probleme: q.meta.review!.cle }))
  const out: Record<string, unknown> = { ...report.data, meta, cles_discutables: cles, questions: entries }
  if ('a_corriger_avant_usage' in report.data) out.a_corriger_avant_usage = aCorriger
  return JSON.stringify(out, null, 2)
}

// ---- Étiquettes et catégories qui suivent la note de révision ----

const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-')

/**
 * Met à jour les étiquettes « statut-… » et « pertinence-… » d'une question pour qu'elles
 * suivent sa note (seulement si la question utilisait déjà cette convention).
 */
export function syncTags(tags: string[], r: Review | undefined): string[] {
  const hadStatut = tags.some((t) => /^statut-/.test(t))
  const hadPertinence = tags.some((t) => /^pertinence-/.test(t))
  const out = tags.filter((t) => !/^(statut|pertinence)-/.test(t))
  if (hadPertinence && r?.pertinence) out.push('pertinence-' + slug(r.pertinence))
  if (hadStatut && r?.direction) out.push('statut-' + slug(r.direction))
  return out
}

export const sameTags = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t) => b.includes(t))

/**
 * Catégorie où ranger une question une fois corrigée : si elle est dans « … / 0 – À corriger
 * avant usage », la catégorie voisine correspondant à sa pertinence (« … / 1 – Pertinence haute »).
 */
export function correctedCategory(category: string, pertinence: string, categories: string[]): string | null {
  const cut = category.lastIndexOf('/')
  if (cut < 0 || !pertinence || !/corriger/i.test(category.slice(cut + 1))) return null
  const parent = category.slice(0, cut)
  const wanted = 'pertinence ' + pertinence.toLowerCase()
  const last = (c: string) => c.slice(c.lastIndexOf('/') + 1)
  const sibling = categories.find((c) => c.slice(0, c.lastIndexOf('/')) === parent && last(c).toLowerCase().includes(wanted))
  if (sibling) return sibling
  // Pas encore de catégorie voisine dans ce cours : on reprend le libellé utilisé ailleurs.
  const model = categories.find((c) => last(c).toLowerCase().includes(wanted))
  return model ? parent + '/' + last(model) : null
}

/** Contenu du fichier de notes d'une sauvegarde : rapport à jour, examens, et notes hors rapport. */
export function backupNotes(report: Report | undefined, questions: Question[], exams: { name: string; items: string[] }[], name: (q: Question) => string): string {
  const base: Record<string, unknown> = report ? JSON.parse(exportReport(report, questions)) : { questions: [] }
  const byId = new Map(questions.map((q) => [q.id, q]))
  base.examens = exams.map((e) => ({
    nom: e.name,
    questions: e.items.map((id) => byId.get(id)).filter((q): q is Question => !!q).map((q) => ({ nom: name(q), id_origine: q.meta.review?.origine ?? originId(q) })),
  }))
  base.autres_questions = questions
    .filter((q) => (q.meta.review?.origine ?? originId(q)) == null && (q.meta.status || q.meta.note || (q.meta.review && !q.meta.review.removed)))
    .map((q) => ({ nom: name(q), etat_application: q.meta.status || null, note_privee: q.meta.note || null, note_de_revision: q.meta.review ?? null }))
  // Difficulté et temps estimé : même format que le fichier de scores, pour être réimportés tels quels.
  base.difficulte_temps = questions
    .filter((q) => q.meta.difficulty || q.meta.minutes)
    .map((q) => {
      const o = q.meta.review?.origine ?? originId(q)
      return { cle: o != null ? String(o) : 'T:' + name(q), difficulte: q.meta.difficulty ?? null, temps_min: q.meta.minutes ?? null }
    })
  return JSON.stringify(base, null, 2)
}
