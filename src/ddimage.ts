// Questions « glisser-déposer sur image » de Moodle (ddimageortext).
// L'image de fond (<file>), les étiquettes (<drag>) et les zones (<drop>) vivent dans `extra`, en XML brut :
// tant qu'on n'y touche pas, l'export les réécrit à l'identique.
import type { Question } from './model'

export interface DdDrag {
  no: number
  text: string
  /** Groupe (1 à 8) : une étiquette ne se dépose que dans les zones de son groupe. */
  group: string
  /** Réutilisable : l'étiquette reste disponible après avoir été déposée. */
  infinite: boolean
  /** Étiquette-image : son <file> brut, conservé tel quel. */
  file: string
}

export interface DdDrop {
  no: number
  /** Texte de la zone (lu par les lecteurs d'écran, non affiché). */
  label: string
  /** Numéro de l'étiquette attendue. */
  choice: number
  x: number
  y: number
}

export interface DdModel {
  bgName: string
  bgData: string
  drags: DdDrag[]
  drops: DdDrop[]
}

const FILE = /^<file\b[^>]*\bname="([^"]*)"[^>]*>([^<]*)<\/file>$/
export const isDdExtra = (x: string): boolean => /^<(drag|drop|file)[\s>]/.test(x)

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }
export const dataUrl = (name: string, data: string): string => (data ? `data:${MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'image/png'};base64,${data.replace(/\s+/g, '')}` : '')

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const int = (s: string | null | undefined) => parseInt((s ?? '').trim(), 10) || 0

export function readDd(q: Question): DdModel {
  const m: DdModel = { bgName: '', bgData: '', drags: [], drops: [] }
  for (const x of q.extra) {
    if (x.startsWith('<file')) {
      const f = FILE.exec(x.trim())
      if (f && !m.bgData) {
        m.bgName = f[1]
        m.bgData = f[2]
      }
    } else if (/^<drag[\s>]/.test(x)) {
      // Une étiquette-image porte un <file> volumineux : on le met de côté avant d'analyser le reste.
      const file = /<file\b[\s\S]*<\/file>/.exec(x)?.[0] ?? ''
      const el = new DOMParser().parseFromString(file ? x.replace(file, '') : x, 'text/xml').documentElement
      const get = (tag: string) => el.getElementsByTagName(tag)[0]?.textContent ?? ''
      m.drags.push({ no: int(get('no')), text: get('text'), group: get('draggroup').trim() || '1', infinite: el.getElementsByTagName('infinite').length > 0, file })
    } else if (/^<drop[\s>]/.test(x)) {
      const el = new DOMParser().parseFromString(x, 'text/xml').documentElement
      const get = (tag: string) => el.getElementsByTagName(tag)[0]?.textContent ?? ''
      m.drops.push({ no: int(get('no')), label: get('text'), choice: int(get('choice')), x: int(get('xleft')), y: int(get('ytop')) })
    }
  }
  return m
}

export const dragXml = (d: DdDrag): string =>
  `<drag>\n      <no>${d.no}</no>\n      <text>${esc(d.text)}</text>\n      <draggroup>${esc(d.group)}</draggroup>\n${d.infinite ? '      <infinite/>\n' : ''}${d.file ? '      ' + d.file + '\n' : ''}    </drag>`

export const dropXml = (d: DdDrop): string =>
  `<drop>\n      <text>${esc(d.label)}</text>\n      <no>${d.no}</no>\n      <choice>${d.choice}</choice>\n      <xleft>${Math.round(d.x)}</xleft>\n      <ytop>${Math.round(d.y)}</ytop>\n    </drop>`

/** Réécrit les étiquettes et les zones de la question (numérotées dans l'ordre), sans toucher à l'image de fond. */
export function writeDd(q: Question, drags: DdDrag[], drops: DdDrop[]): void {
  const at = q.extra.findIndex((x) => /^<(drag|drop)[\s>]/.test(x))
  const rest = q.extra.filter((x) => !/^<(drag|drop)[\s>]/.test(x))
  const before = at < 0 ? rest.length : q.extra.slice(0, at).filter((x) => !/^<(drag|drop)[\s>]/.test(x)).length
  rest.splice(before, 0, ...drags.map((d, i) => dragXml({ ...d, no: i + 1 })), ...drops.map((d, i) => dropXml({ ...d, no: i + 1 })))
  q.extra = rest
}

/** Supprime une étiquette : les suivantes et les zones qui les attendent sont renumérotées. */
export function removeDrag(m: DdModel, no: number): { drags: DdDrag[]; drops: DdDrop[] } {
  return {
    drags: m.drags.filter((d) => d.no !== no).map((d) => ({ ...d, no: d.no > no ? d.no - 1 : d.no })),
    drops: m.drops.map((d) => ({ ...d, choice: d.choice > no ? d.choice - 1 : d.choice })),
  }
}

export function setBackground(q: Question, name: string, data: string): void {
  const xml = `<file name="${name.replace(/[<>&"]/g, '_')}" encoding="base64">${data}</file>`
  const i = q.extra.findIndex((x) => x.startsWith('<file'))
  if (i >= 0) q.extra[i] = xml
  else q.extra.unshift(xml)
}

/** Groupe d'une zone : celui de l'étiquette qu'elle attend. */
export const dropGroup = (m: DdModel, drop: DdDrop): string => m.drags.find((d) => d.no === drop.choice)?.group ?? '1'

/** Part des zones correctement remplies (`placed` : numéro de zone → numéro d'étiquette). */
export function gradeDd(m: DdModel, placed: Record<number, number>): number {
  if (!m.drops.length) return 0
  // Deux étiquettes au même texte et du même groupe sont équivalentes, comme dans Moodle.
  const same = (a: number, b: number) => {
    if (a === b) return true
    const da = m.drags.find((d) => d.no === a)
    const db = m.drags.find((d) => d.no === b)
    return !!da && !!db && !da.file && !db.file && da.group === db.group && da.text.trim() === db.text.trim()
  }
  return m.drops.filter((d) => placed[d.no] !== undefined && same(placed[d.no], d.choice)).length / m.drops.length
}
