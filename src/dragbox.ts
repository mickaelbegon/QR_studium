// Choix à déposer des questions « glisser-déposer sur texte » (balises <dragbox> de Moodle).
// Ils vivent dans `extra` (XML brut) : un choix non modifié est réécrit à l'identique à l'export.
import type { Question } from './model'

export interface DragBox {
  text: string
  /** Groupe (1 à 8) : un choix ne se dépose que dans une zone de son groupe. */
  group: string
  /** Réutilisable : le choix reste disponible après avoir été déposé. */
  infinite: boolean
}

export function parseDragBox(xml: string): DragBox | null {
  const el = new DOMParser().parseFromString(xml, 'text/xml').documentElement
  if (el.tagName !== 'dragbox') return null
  return {
    text: el.getElementsByTagName('text')[0]?.textContent ?? '',
    group: el.getElementsByTagName('group')[0]?.textContent?.trim() || '1',
    infinite: el.getElementsByTagName('infinite').length > 0,
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const dragBoxXml = (b: DragBox): string =>
  `<dragbox>\n      <text>${esc(b.text)}</text>\n      <group>${esc(b.group)}</group>\n${b.infinite ? '      <infinite/>\n' : ''}    </dragbox>`

/** Les choix dans l'ordre de leur numéro ([[1]], [[2]]…), avec leur position dans `extra`. */
export function dragBoxes(q: Question): { i: number; box: DragBox }[] {
  const out: { i: number; box: DragBox }[] = []
  q.extra.forEach((x, i) => {
    const box = /^<dragbox[\s>]/.test(x) ? parseDragBox(x) : null
    if (box) out.push({ i, box })
  })
  return out
}

/** Numéros des zones [[n]] présentes dans un énoncé. */
export const dropZones = (text: string): number[] => [...text.matchAll(/\[\[(\d+)\]\]/g)].map((m) => parseInt(m[1], 10))
