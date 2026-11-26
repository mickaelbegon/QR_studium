// Nettoyage de la mise en forme : paragraphes vides, sauts de ligne en trop, paragraphes imbriqués.
// Ces restes de copier-coller ajoutent des lignes blanches autour des réponses dans StudiUM.
import { type Question, type RichText } from './model'

const BLOCKS = new Set(['P', 'DIV', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'UL', 'OL', 'TABLE'])
/** Éléments qui comptent comme du contenu même sans texte. */
const CONTENT = 'img,video,audio,iframe,table,input,select,textarea,svg,math,hr,object,embed,canvas'
const blank = (s: string | null) => !(s ?? '').replace(/[\s ]/g, '')

/** Voisin significatif d'un nœud (les textes faits d'espaces ne comptent pas). */
function sibling(n: Node, dir: 'previousSibling' | 'nextSibling'): Node | null {
  let s = n[dir]
  while (s && s.nodeType === Node.TEXT_NODE && blank(s.textContent)) s = s[dir]
  return s
}
const isBlock = (n: Node | null) => !!n && n.nodeType === Node.ELEMENT_NODE && BLOCKS.has((n as Element).tagName)

/**
 * Retire d'un HTML les paragraphes vides et les sauts de ligne inutiles (en début ou fin de bloc, ou collés à un bloc).
 * Le texte lisible, les images et les sauts de ligne placés au milieu d'un texte ne changent pas.
 * Rend le HTML d'origine, à l'octet près, s'il n'y a rien à retirer.
 */
export function tidyHtml(html: string, o: { keepSpaces?: boolean } = {}): string {
  if (!/<(p|div|br|span)\b/i.test(html)) return html
  const t = document.createElement('template')
  t.innerHTML = html
  const root = t.content
  const text = (n: ParentNode) => (n.textContent ?? '').replace(/[\s ]/g, '')
  const before = text(root)
  const media = root.querySelectorAll(CONTENT).length
  let removed = 0
  for (let again = true; again; ) {
    again = false
    for (const br of [...root.querySelectorAll('br')]) {
      const prev = sibling(br, 'previousSibling')
      const next = sibling(br, 'nextSibling')
      // Saut de ligne sans texte avant ou après lui dans son bloc, ou collé à un paragraphe : il ne sépare rien.
      if (!prev || !next || isBlock(prev) || isBlock(next)) {
        br.remove()
        removed++
        again = true
      }
    }
    for (const el of [...root.querySelectorAll('p,div,span')]) {
      if (blank(el.textContent) && !el.querySelector(CONTENT) && !el.querySelector('br')) {
        el.remove()
        removed++
        again = true
      }
    }
  }
  if (!removed) return html
  // Les retours à la ligne du code source n'ont pas de sens à l'affichage : une seule espace suffit.
  if (!o.keepSpaces) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n.parentElement?.closest('pre') ?? null) !== null) continue
      let v = (n.nodeValue ?? '').replace(/[ \t\r\n]+/g, ' ')
      const parent = n.parentNode
      const edgeBlock = !parent || parent === root || isBlock(parent)
      if (edgeBlock && !sibling(n, 'previousSibling') && !n.previousSibling) v = v.replace(/^ /, '')
      if (edgeBlock && !sibling(n, 'nextSibling') && !n.nextSibling) v = v.replace(/ $/, '')
      // Entre deux paragraphes, l'espace ne sert à rien.
      if (v === ' ' && (isBlock(n.previousSibling) || isBlock(n.nextSibling)) && (edgeBlock || !n.previousSibling || !n.nextSibling)) v = ''
      n.nodeValue = v
    }
  }
  const out = t.innerHTML.trim()
  // Garde-fou : le texte et les médias doivent être exactement ceux d'avant.
  const check = document.createElement('template')
  check.innerHTML = out
  if (text(check.content) !== before || check.content.querySelectorAll(CONTENT).length !== media) return html
  return out
}

const isHtml = (rt: RichText) => rt.format === 'html' || /^\s*</.test(rt.text)

/** La question avec sa mise en forme nettoyée, ou `null` s'il n'y a rien à nettoyer. */
export function tidyQuestion(q: Question): Question | null {
  const next = structuredClone(q)
  let changed = false
  const fix = (rt: RichText | undefined, keepSpaces = false) => {
    if (!rt || !rt.text || !isHtml(rt)) return
    const text = tidyHtml(rt.text, { keepSpaces })
    if (text !== rt.text) {
      rt.text = text
      changed = true
    }
  }
  for (const f of next.fields) {
    // Le titre est du texte brut ; dans un texte à trous, les espaces font partie des réponses.
    if (f.kind === 'text' && f.tag !== 'name') fix(f.rt, next.type === 'cloze' && f.tag === 'questiontext')
  }
  for (const a of next.answers) {
    fix(a.rt)
    fix(a.feedback)
  }
  for (const s of next.subquestions) fix(s.rt)
  return changed ? next : null
}
