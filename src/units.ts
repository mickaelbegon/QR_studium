// Unités des questions numériques de Moodle.
// Les unités vivent dans `extra` (bloc <units> brut, réécrit à l'identique s'il n'est pas modifié) ;
// leur gestion tient en quatre propriétés : unitgradingtype, unitpenalty, showunits, unitsleft.
import { type Answer, type Question, getProp, setProp } from './model'

export interface Unit {
  name: string
  /** La réponse saisie dans cette unité est divisée par ce nombre avant d'être comparée. */
  multiplier: string
}

/** none : nombre seul · optional : unité acceptée mais non notée · graded : unité exigée et notée. */
export type UnitMode = 'none' | 'optional' | 'graded'

const IS_UNITS = /^<units[\s>/]/
export const isUnits = (xml: string): boolean => IS_UNITS.test(xml)

export function getUnits(q: Question): Unit[] {
  const xml = q.extra.find(isUnits)
  if (!xml) return []
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  return [...doc.getElementsByTagName('unit')].map((u) => ({
    name: u.getElementsByTagName('unit_name')[0]?.textContent ?? '',
    multiplier: u.getElementsByTagName('multiplier')[0]?.textContent?.trim() || '1',
  }))
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const unitsXml = (units: Unit[]): string =>
  `<units>\n${units.map((u) => `  <unit>\n    <multiplier>${esc(u.multiplier)}</multiplier>\n    <unit_name>${esc(u.name)}</unit_name>\n  </unit>\n`).join('')}</units>`

export function setUnits(q: Question, units: Unit[]): void {
  const i = q.extra.findIndex(isUnits)
  if (!units.length) {
    if (i >= 0) q.extra.splice(i, 1)
  } else if (i >= 0) q.extra[i] = unitsXml(units)
  else q.extra.push(unitsXml(units))
}

export function unitMode(q: Question): UnitMode {
  if ((getProp(q, 'unitgradingtype') ?? '0') !== '0') return 'graded'
  const show = getProp(q, 'showunits')
  return show === '3' || (show === undefined && !getUnits(q).length) ? 'none' : 'optional'
}

export function setUnitMode(q: Question, mode: UnitMode): void {
  const show = getProp(q, 'showunits')
  if (mode === 'none') {
    setProp(q, 'unitgradingtype', '0')
    setProp(q, 'showunits', '3')
    return
  }
  const grading = getProp(q, 'unitgradingtype')
  setProp(q, 'unitgradingtype', mode === 'optional' ? '0' : grading === '2' ? '2' : '1')
  setProp(q, 'showunits', mode === 'optional' ? '0' : show === '1' || show === '2' ? show : '0')
  if (getProp(q, 'unitpenalty') === undefined) setProp(q, 'unitpenalty', '0.1')
  if (getProp(q, 'unitsleft') === undefined) setProp(q, 'unitsleft', '0')
  if (!getUnits(q).length) setUnits(q, [{ name: '', multiplier: '1' }])
}

/** L'étudiant choisit l'unité dans une liste (au lieu de la taper après le nombre). */
export const unitChoice = (q: Question): boolean => unitMode(q) === 'graded' && ['1', '2'].includes(getProp(q, 'showunits') ?? '')

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i
const TOL = /<tolerance>([^<]*)<\/tolerance>/
const tolerance = (a: Answer) => parseFloat(TOL.exec(a.extra.join(''))?.[1] ?? '0') || 0

/**
 * Note une réponse numérique comme Moodle : conversion par l'unité, tolérance, pénalité d'unité.
 * `picked` est l'unité choisie dans la liste quand la question en propose une.
 */
export function gradeNumerical(q: Question, typed: string, picked = ''): { fraction: number; answer?: Answer; unitProblem: '' | 'absente' | 'inconnue' } {
  const s = typed.trim().replace(',', '.')
  const m = NUMBER.exec(s)
  if (!m) return { fraction: 0, unitProblem: '' }
  let value = parseFloat(m[0])
  const mode = unitMode(q)
  const unitText = unitChoice(q) ? picked.trim() : (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim()
  let unitProblem: '' | 'absente' | 'inconnue' = ''
  if (mode !== 'none') {
    const unit = getUnits(q).find((u) => u.name.trim() === unitText)
    if (unit && unitText) value /= parseFloat(unit.multiplier) || 1
    else unitProblem = unitText ? 'inconnue' : mode === 'graded' ? 'absente' : ''
  }
  // Une unité que la question ne connaît pas rend la réponse fausse, quelle que soit la valeur.
  if (unitProblem === 'inconnue') return { fraction: 0, unitProblem }
  const answer = q.answers.find((a) => a.rt.text.trim() === '*' || Math.abs(value - parseFloat(a.rt.text.trim().replace(',', '.'))) <= tolerance(a) + 1e-9)
  let fraction = (parseFloat(answer?.fraction ?? '0') || 0) / 100
  if (unitProblem === 'absente') {
    const penalty = parseFloat(getProp(q, 'unitpenalty') ?? '0') || 0
    // 1 : la pénalité est une fraction de la note obtenue ; 2 : une fraction de la note de la question.
    fraction = Math.max(0, getProp(q, 'unitgradingtype') === '2' ? fraction - penalty : fraction * (1 - penalty))
  }
  return { fraction, answer, unitProblem }
}
