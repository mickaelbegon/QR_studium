// Propositions de distracteurs (fichier distracteurs.json) : affichées sur la question concernée,
// applicables d'un clic quand elles se substituent une à une aux mauvaises réponses actuelles.
import { type Proposal, type Question, emptyRt, plain } from './model'

interface RawProposal {
  id_origine: string | number
  probleme?: string
  type_probleme?: string
  priorite?: string
  bonne_reponse?: string
  distracteurs_actuels?: string[]
  distracteurs_proposes?: { texte?: string; erreur_visee?: string }[]
  a_verifier?: boolean
  a_verifier_note?: string
  image_non_vue?: boolean
}

/** Lit un fichier de propositions ; `null` si le JSON est autre chose (un rapport de révision, par exemple). */
export function parseProposals(text: string): Map<number, Proposal> | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(data) || !data.length || !data.every((x) => x && typeof x === 'object' && 'id_origine' in x && 'distracteurs_proposes' in x)) return null
  const out = new Map<number, Proposal>()
  for (const r of data as RawProposal[]) {
    const id = parseInt(String(r.id_origine), 10)
    if (!Number.isFinite(id)) continue
    out.set(id, {
      probleme: r.probleme ?? '',
      type: r.type_probleme ?? '',
      priorite: r.priorite ?? '',
      bonne: r.bonne_reponse ?? '',
      actuels: (r.distracteurs_actuels ?? []).map(String),
      proposes: (r.distracteurs_proposes ?? []).map((p) => ({ texte: String(p.texte ?? ''), erreur: String(p.erreur_visee ?? '') })).filter((p) => p.texte.trim()),
      verifier: !!r.a_verifier,
      note: r.a_verifier_note ?? '',
      image: !!r.image_non_vue,
    })
  }
  return out
}

const norm = (s: string) => plain(s).replace(/\s+/g, ' ').replace(/[’`]/g, "'").trim().toLowerCase()
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * La question avec ses mauvaises réponses remplacées par les distracteurs proposés.
 * `null` quand la substitution ne peut pas se faire seule : nombre de choix différent,
 * choix contenant une image, ou question d'un autre type.
 */
export function applyProposal(q: Question, p: Proposal): Question | null {
  if (q.type !== 'multichoice' || !p.proposes.length) return null
  const next = structuredClone(q)
  const wrong = next.answers.filter((a) => (parseFloat(a.fraction) || 0) <= 0)
  if (wrong.length !== p.proposes.length || wrong.some((a) => a.rt.files.length)) return null
  // Un distracteur proposé identique à un choix actuel signifie « conservé » : ce choix ne bouge pas.
  const kept = new Set<string>()
  const fresh = p.proposes.filter((x) => {
    const same = wrong.find((a) => !kept.has(a.k) && norm(a.rt.text) === norm(x.texte))
    if (same) kept.add(same.k)
    return !same
  })
  const free = wrong.filter((a) => !kept.has(a.k))
  if (!fresh.length || free.length !== fresh.length) return null
  free.forEach((a, i) => {
    a.rt = { ...a.rt, text: /^\s*<p[\s>]/i.test(a.rt.text) || a.rt.format === 'html' ? `<p>${esc(fresh[i].texte)}</p>` : fresh[i].texte, files: [] }
    // La rétroaction de l'ancien distracteur ne vaut plus pour le nouveau.
    if (a.feedback) a.feedback = emptyRt(a.feedback.format)
  })
  delete next.meta.proposal
  return next
}

const PRIORITY: Record<string, string> = { haute: 'fix', moyenne: 'improve', basse: '' }

export function ProposalBox({ q, onApply, onEdit, onDismiss }: { q: Question; onApply: (next: Question) => void; onEdit: () => void; onDismiss: () => void }) {
  const p = q.meta.proposal
  if (!p) return null
  const next = applyProposal(q, p)
  const current = new Set(q.answers.map((a) => norm(a.rt.text)))
  return (
    <div className={'review proposal ' + (PRIORITY[p.priorite] ?? '')}>
      <div className="row">
        <strong>Distracteurs proposés</strong>
        {p.priorite && <span className={'chip ' + (PRIORITY[p.priorite] || 'low')}>Priorité {p.priorite}</span>}
        {p.verifier && <span className="chip fix">À vérifier par vous</span>}
        {p.image && <span className="chip low">Image non vue</span>}
        <span className="grow" />
        <span className="hint">{p.type}</span>
      </div>
      {p.probleme && <div>{p.probleme}</div>}
      {p.note && <div className="hint">À vérifier : {p.note}</div>}
      {p.proposes.length > 0 ? (
        <ul className="proposal-list">
          {p.proposes.map((x, i) => {
            const same = current.has(norm(x.texte))
            return (
              <li key={i} className={same ? 'same' : ''}>
                <span>{x.texte}</span>
                {same ? <small> — déjà dans la question</small> : x.erreur && <small> — {x.erreur}</small>}
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="hint">Pas de distracteur de remplacement : le problème est à régler dans la question elle-même.</div>
      )}
      <div className="row">
        {next ? (
          <button className="primary" title="Remplace les mauvaises réponses par ces distracteurs. La version actuelle reste dans l’historique." onClick={() => onApply(next)}>
            Appliquer ces distracteurs
          </button>
        ) : (
          <button onClick={onEdit} title="La substitution ne peut pas se faire automatiquement (nombre de choix différent, image dans un choix, ou rien à remplacer)">
            Modifier la question à la main
          </button>
        )}
        <button onClick={onDismiss}>Écarter la proposition</button>
      </div>
    </div>
  )
}
