// Syntaxe Cloze de Moodle : {1:MULTICHOICE:=bonne#rétroaction~mauvaise~%50%partielle}

export interface ClozeOption {
  fraction: number
  text: string
  feedback: string
}

export interface ClozePart {
  raw: string
  weight: number
  kind: 'mc' | 'mr' | 'sa' | 'nm'
  options: ClozeOption[]
}

const RE = /\{(\d*):([A-Z_]+):((?:\\[\s\S]|[^}\\])*)\}/g

function kindOf(code: string): ClozePart['kind'] | null {
  if (/^(MULTIRESPONSE|MR)/.test(code)) return 'mr'
  if (/^(MULTICHOICE|MC)/.test(code)) return 'mc'
  if (/^(SHORTANSWER|SA|MW)/.test(code)) return 'sa'
  if (/^(NUMERICAL|NM)/.test(code)) return 'nm'
  return null
}

const unescape = (s: string) => s.replace(/\\([~#}={:\\])/g, '$1')

function parseOptions(body: string): ClozeOption[] {
  return body
    .split(/(?<!\\)~/)
    .filter((o) => o.trim() !== '')
    .map((o) => {
      const m = /^\s*(?:(=)|%(-?[\d.]+)%)?([\s\S]*)$/.exec(o)!
      const fraction = m[1] ? 100 : m[2] !== undefined ? parseFloat(m[2]) : 0
      const rest = m[3]
      const cut = rest.search(/(?<!\\)#/)
      return {
        fraction,
        text: unescape(cut < 0 ? rest : rest.slice(0, cut)),
        feedback: cut < 0 ? '' : unescape(rest.slice(cut + 1)),
      }
    })
}

export function parseCloze(text: string): ClozePart[] {
  const parts: ClozePart[] = []
  for (const m of text.matchAll(RE)) {
    const kind = kindOf(m[2])
    if (!kind) continue
    parts.push({ raw: m[0], weight: m[1] ? parseInt(m[1], 10) : 1, kind, options: parseOptions(m[3]) })
  }
  return parts
}

const KIND_LABEL = { mc: 'menu', mr: 'choix multiples', sa: 'réponse courte', nm: 'numérique' }

/** Remplace chaque trou par un aperçu lisible (réponses visibles ou non). */
export function renderCloze(html: string, showAnswers: boolean): string {
  return html.replace(RE, (raw, _w, code, body) => {
    const kind = kindOf(code)
    if (!kind) return raw
    const options = parseOptions(body)
    const text = (o: ClozeOption) => (kind === 'nm' ? o.text.replace(/^(.*):(.*)$/, '$1 ± $2') : o.text)
    if (!showAnswers) {
      if (kind === 'sa' || kind === 'nm') return '<span class="cloze blank">__________</span>'
      return '<span class="cloze blank">( ' + options.map(text).join(' / ') + ' )</span>'
    }
    const opts = options
      .map((o) => {
        const cls = o.fraction >= 100 ? 'ok' : o.fraction > 0 ? 'part' : ''
        const pct = o.fraction > 0 && o.fraction < 100 ? ` <small>${o.fraction} %</small>` : ''
        const title = o.feedback ? ` title="${o.feedback.replace(/<[^>]*>/g, '').replace(/"/g, '&quot;')}"` : ''
        return `<span class="cloze-opt ${cls}"${title}>${text(o)}${pct}</span>`
      })
      .join('')
    return `<span class="cloze"><span class="cloze-kind">${KIND_LABEL[kind]}</span>${opts}</span>`
  })
}

function shuffled<T>(a: T[]): T[] {
  const b = [...a]
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[b[i], b[j]] = [b[j], b[i]]
  }
  return b
}

const noTags = (s: string) => s.replace(/<[^>]*>/g, '')

/**
 * Remplace chaque trou par le champ que voit l'étudiant : zone de texte, menu déroulant,
 * boutons radio ou cases à cocher (verticaux ou horizontaux selon le code du trou).
 * Chaque champ porte data-cz="<rang du trou>", dans le même ordre que parseCloze.
 */
export function renderClozeInputs(html: string): string {
  let i = -1
  return html.replace(RE, (raw, _w, code: string, body: string) => {
    const kind = kindOf(code)
    if (!kind) return raw
    i++
    const options = parseOptions(body)
    if (kind === 'sa' || kind === 'nm') {
      const size = Math.max(5, Math.min(30, ...options.map((o) => noTags(o.text).length + 2)))
      return `<input type="text" class="cz" data-cz="${i}" size="${size}" autocomplete="off">`
    }
    const vertical = /(_V|^MCV|^MR$|^MRS$|^MULTIRESPONSE$|^MULTIRESPONSE_S$)/.test(code)
    const horizontal = /(_H|^MCH|^MRH)/.test(code)
    let order = options.map((o, k) => ({ o, k }))
    if (/S$/.test(code) && code !== 'MULTIRESPONSE') order = shuffled(order)
    if (kind === 'mc' && !vertical && !horizontal) {
      return `<select class="cz" data-cz="${i}"><option value=""></option>${order.map(({ o, k }) => `<option value="${k}">${noTags(o.text)}</option>`).join('')}</select>`
    }
    const type = kind === 'mr' ? 'checkbox' : 'radio'
    const items = order.map(({ o, k }) => `<label><input type="${type}" name="cz${i}" value="${k}"> ${o.text}</label>`).join('')
    return `<span class="cz-group ${horizontal ? 'h' : 'v'}" data-cz="${i}">${items}</span>`
  })
}
