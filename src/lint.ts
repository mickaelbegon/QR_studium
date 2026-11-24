// Contrôle qualité : repère les problèmes courants avant un réimport dans StudiUM.
import { parseCloze } from './cloze'
import { type Question, type RichText, allTexts, filePathName, fileRefs, fold, getProp, getText, plain, qName } from './model'

export interface Issue {
  level: 'error' | 'warn' | 'info'
  msg: string
}

const hasContent = (rt: RichText | undefined): boolean => !!rt && (plain(rt.text) !== '' || /<(img|video|audio|table)/i.test(rt.text))

/** Identifiants des questions dont l'énoncé (et le type) est identique à celui d'une autre. */
export function findDuplicates(questions: Question[]): Set<string> {
  const seen = new Map<string, string[]>()
  for (const q of questions) {
    const text = fold(plain(getText(q, 'questiontext')?.text))
    if (text.length < 15) continue
    const key = q.type + '|' + text
    seen.set(key, [...(seen.get(key) ?? []), q.id])
  }
  const dup = new Set<string>()
  for (const ids of seen.values()) if (ids.length > 1) ids.forEach((id) => dup.add(id))
  return dup
}

export function lintQuestion(q: Question, duplicates?: Set<string>): Issue[] {
  const out: Issue[] = []
  const err = (msg: string) => out.push({ level: 'error', msg })
  const warn = (msg: string) => out.push({ level: 'warn', msg })
  const info = (msg: string) => out.push({ level: 'info', msg })
  const qt = getText(q, 'questiontext')
  const fr = q.answers.map((a) => parseFloat(a.fraction) || 0)

  if (!qName(q).trim()) err('La question n’a pas de nom.')
  if (!hasContent(qt)) warn('L’énoncé est vide.')

  if (q.type === 'multichoice') {
    if (q.answers.length < 2) err('Moins de deux choix de réponse.')
    if (getProp(q, 'single') !== 'false') {
      if (!fr.some((f) => f >= 100)) err('Aucun choix ne vaut 100 %.')
    } else {
      const sum = fr.filter((f) => f > 0).reduce((a, b) => a + b, 0)
      if (Math.abs(sum - 100) > 0.5) err(`La somme des fractions positives vaut ${+sum.toFixed(2)} % au lieu de 100 %.`)
    }
    q.answers.forEach((a, i) => {
      if (!hasContent(a.rt)) err(`Le choix ${i + 1} est vide.`)
    })
    const texts = q.answers.map((a) => fold(plain(a.rt.text))).filter((t) => t)
    if (new Set(texts).size < texts.length) warn('Deux choix ont le même texte.')
  } else if (q.type === 'truefalse') {
    if (fr.filter((f) => f >= 100).length !== 1) err('Vrai/Faux : exactement une réponse doit valoir 100 %.')
  } else if (q.type === 'matching') {
    const filled = q.subquestions.filter((s) => hasContent(s.rt))
    if (filled.length < 2) err('Appariement : au moins deux paires sont nécessaires.')
    filled.forEach((s) => {
      if (!s.answer.trim()) err(`Appariement : « ${plain(s.rt.text).slice(0, 40)} » n’a pas de réponse.`)
    })
    if (new Set(q.subquestions.map((s) => s.answer.trim()).filter((a) => a)).size < 3) warn('Appariement : moins de trois réponses distinctes.')
  } else if (q.type === 'cloze') {
    const parts = parseCloze(qt?.text ?? '')
    if (!parts.length) err('Cloze : aucun trou {…} reconnu dans l’énoncé.')
    parts.forEach((p, i) => {
      // Choix multiples : la note se répartit entre plusieurs bonnes réponses partielles.
      if (!p.options.some((o) => (p.kind === 'mr' ? o.fraction > 0 : o.fraction >= 100))) err(`Cloze : le trou ${i + 1} n’a aucune bonne réponse.`)
      if ((p.kind === 'mc' || p.kind === 'mr') && p.options.length < 2) warn(`Cloze : le trou ${i + 1} n’a qu’un seul choix.`)
    })
    const stripped = (qt?.text ?? '').replace(/\{(\d*):([A-Z_]+):((?:\\[\s\S]|[^}\\])*)\}/g, '')
    if (/\{\d*:[A-Z_]+:/.test(stripped)) err('Cloze : un trou est mal formé (accolade non fermée ?).')
  } else if (q.type === 'shortanswer' || q.type === 'numerical') {
    if (!fr.some((f) => f >= 100)) err('Aucune réponse ne vaut 100 %.')
  }

  for (const rt of allTexts(q)) {
    const refs = fileRefs(rt.text)
    const names = rt.files.map(filePathName)
    for (const r of new Set(refs)) if (!names.includes(r)) err(`Image manquante : « ${r} » est référencée mais absente du fichier.`)
    for (const n of names) if (!refs.includes(n)) warn(`Fichier inutilisé : « ${n} » est intégré mais n’apparaît pas dans le texte.`)
    if (/class="?Mso|mso-[a-z-]+:|<o:p>/i.test(rt.text)) warn('HTML collé depuis Word (balises « Mso ») : à nettoyer.')
  }

  if (duplicates?.has(q.id)) warn('Doublon : une autre question du même type a le même énoncé.')

  if (q.type !== 'description' && q.type !== 'essay') {
    const anyFeedback = hasContent(getText(q, 'generalfeedback')) || q.answers.some((a) => hasContent(a.feedback))
    if (!anyFeedback && q.type !== 'cloze') info('Aucune rétroaction (ni générale, ni par réponse).')
  }

  // Une même alerte peut venir de plusieurs champs : on ne la montre qu'une fois.
  return out.filter((x, i) => out.findIndex((y) => y.msg === x.msg) === i)
}

export const worst = (issues: Issue[]): Issue['level'] | null =>
  issues.some((i) => i.level === 'error') ? 'error' : issues.some((i) => i.level === 'warn') ? 'warn' : null
