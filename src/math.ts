// Formules mathématiques : mêmes délimiteurs que le filtre MathJax de Moodle.
//   \( ... \)   formule dans le texte
//   \[ ... \]   et   $$ ... $$   formule centrée sur sa propre ligne
import katex from 'katex'

const MATH = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$/g
// Le contenu d'un menu déroulant ou d'une zone de saisie ne peut pas contenir de mise en forme.
const TEXT_ONLY = /(<option\b[\s\S]*?<\/option>|<textarea\b[\s\S]*?<\/textarea>)/i

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }

/** Le TeX tel que tapé : l'éditeur HTML a pu y glisser des balises et des entités. */
const toTex = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => ENTITIES[m])

/** Remplace les formules TeX d'un HTML par leur rendu. Une formule invalide reste lisible, en rouge. */
export function renderMath(html: string): string {
  if (!/\\\(|\\\[|\$\$/.test(html)) return html
  return html
    .split(TEXT_ONLY)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(MATH, (raw, inline?: string, block?: string, dollars?: string) => {
            try {
              return katex.renderToString(toTex(inline ?? block ?? dollars ?? ''), { displayMode: inline === undefined, throwOnError: false })
            } catch {
              return raw
            }
          }),
    )
    .join('')
}
