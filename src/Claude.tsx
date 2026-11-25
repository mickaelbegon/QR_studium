// Assistant Claude : un dialogue pour générer ou améliorer des questions.
// Les propositions arrivent au format Moodle XML et s'ajoutent à la banque d'un clic.
import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState } from 'react'
import { lintQuestion } from './lint'
import { renderMath } from './math'
import { type FileRef, type Question, allTexts, filePathName, fileRefs, qName, typeLabel } from './model'
import { parseMoodleXml, serializeQuestion } from './moodleXml'
import { Issues, QuestionPreview } from './Preview'

const SYSTEM = `Tu aides un professeur d'université à rédiger, corriger et améliorer des questions d'examen pour StudiUM (Moodle). Réponds en français, de façon directe et concise.

Quand le professeur joint une question, elle est fournie au format Moodle XML, sans le contenu de ses images (les balises <file> sont vides, tu ne vois pas les images). Tiens compte des notes de révision si elles sont jointes.

Quand tu proposes une question (nouvelle, corrigée ou variante), donne-la en entier dans un bloc \`\`\`xml contenant un seul élément <question type="..."> par question, au format Moodle XML importable :
- types possibles : multichoice, truefalse, matching, shortanswer, numerical, cloze, essay, description ;
- textes en HTML dans <text><![CDATA[...]]></text>, avec format="html" sur questiontext, generalfeedback, answer et feedback ;
- un <name> court et descriptif ;
- pour multichoice : <single>, <shuffleanswers>, <answernumbering>, et la somme des fractions positives égale à 100 ;
- pour cloze : la syntaxe {1:MULTICHOICE:=bonne~mauvaise} directement dans questiontext ;
- formules en TeX entre \\( et \\) dans le texte, ou \\[ et \\] sur une ligne à part ;
- si tu modifies une question jointe, conserve tels quels son type (sauf demande contraire), ses références @@PLUGINFILE@@, ses balises <file> et ses étiquettes.

Une bonne question évalue un seul objectif, a un énoncé sans ambiguïté, des distracteurs plausibles et de longueur comparable, pas d'indice grammatical, pas de « toutes ces réponses ». Ajoute une rétroaction générale brève qui explique la bonne réponse.

Avant ou après le bloc XML, explique en quelques phrases ce que tu as changé et pourquoi. Si la demande est une simple question (avis, explication), réponds sans XML. Si un fait disciplinaire te semble douteux dans la question, signale-le au lieu de le corriger en silence.`

interface Msg {
  role: 'user' | 'assistant'
  /** Texte envoyé à Claude (avec la question jointe, le cas échéant). */
  content: string
  /** Texte tapé par le professeur. */
  shown: string
  attached?: string
  /** Question jointe à ce message : ses images sont reprises dans les propositions qui suivent. */
  base?: Question
  error?: boolean
}

const QUESTION = /<question\b[\s\S]*?<\/question>/g

/** Reprend, pour chaque image citée dans une proposition, le fichier de la question d'origine. */
function adoptFiles(q: Question, base: Question | undefined): Question {
  const known = new Map<string, FileRef>()
  if (base) for (const rt of allTexts(base)) for (const f of rt.files) known.set(filePathName(f), f)
  for (const rt of allTexts(q)) rt.files = fileRefs(rt.text).map((n) => known.get(n)).filter((f): f is FileRef => !!f)
  return q
}

type Segment = { text: string } | { q: Question } | { broken: string }

function segments(content: string, base: Question | undefined): Segment[] {
  const out: Segment[] = []
  const text = (t: string) => {
    // Les clôtures de bloc de code restent autour de la question extraite : on les retire.
    t = t.replace(/```(?:xml)?[ \t]*\n?/g, '').replace(/<\?xml[^>]*\?>|<\/?quiz>/g, '').trim()
    if (t) out.push({ text: t })
  }
  let last = 0
  for (const m of content.matchAll(QUESTION)) {
    text(content.slice(last, m.index))
    last = m.index + m[0].length
    try {
      const q = parseMoodleXml(`<quiz>${m[0]}</quiz>`, 'Claude').questions[0]
      if (q) out.push({ q: adoptFiles(q, base) })
    } catch {
      out.push({ broken: m[0] })
    }
  }
  let tail = content.slice(last)
  // Question en cours de rédaction : on attend la balise fermante avant de l'afficher.
  const open = tail.search(/<question\b/)
  const writing = open >= 0
  if (writing) tail = tail.slice(0, open)
  text(tail)
  if (writing) out.push({ text: '… rédaction de la question en cours' })
  return out
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Mise en forme légère des réponses : gras, code et formules. */
const pretty = (t: string) => renderMath(DOMPurify.sanitize(esc(t).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>')))

const QUICK = ['Améliore la clarté de l’énoncé', 'Propose de meilleurs distracteurs', 'Rédige les rétroactions', 'Crée une variante de même difficulté', 'Vérifie l’exactitude de la clé de correction']

export function ClaudePanel({ open, onClose, current, onAdd, onReplace, grip }: { grip: React.HTMLAttributes<HTMLDivElement>; open: boolean; onClose: () => void; current: Question | null; onAdd: (q: Question) => void; onReplace: (q: Question) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [attach, setAttach] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ mode: string; model: string } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open || status) return
    fetch('/api/claude')
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ mode: 'none', model: '' }))
  }, [open])
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight })
  }, [msgs])

  const send = async (typed: string) => {
    typed = typed.trim()
    if (!typed || busy) return
    const joined = attach && current ? current : undefined
    let content = typed
    if (joined) {
      const r = joined.meta.review
      const notes = r && !r.removed ? [r.direction && `direction : ${r.direction}`, r.probleme && `problème relevé : ${r.probleme}`, r.correction && `correction suggérée : ${r.correction}`, r.cle && `clé : ${r.cle}`].filter(Boolean).join(' ; ') : ''
      content = `Question jointe (Moodle XML, images retirées) :\n\`\`\`xml\n${serializeQuestion(joined, () => '').trim()}\n\`\`\`\n${notes ? `Notes de révision — ${notes}\n` : ''}\n${typed}`
    }
    const history = [...msgs.filter((m) => !m.error), { role: 'user' as const, content, shown: typed, attached: joined && (qName(joined) || '(sans nom)'), base: joined }]
    setMsgs([...history, { role: 'assistant', content: '', shown: '' }])
    setInput('')
    setBusy(true)
    const put = (m: Partial<Msg>) => setMsgs((all) => [...all.slice(0, -1), { ...all[all.length - 1], ...m }])
    try {
      abort.current = new AbortController()
      const r = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system: SYSTEM, messages: history.map((m) => ({ role: m.role, content: m.content })) }),
        signal: abort.current.signal,
      })
      if (!r.ok || !r.body) throw new Error((await r.text()) || `Erreur ${r.status}`)
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let text = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += dec.decode(value, { stream: true })
        put({ content: text })
      }
      if (!text.trim()) throw new Error('Réponse vide.')
    } catch (e) {
      if (abort.current?.signal.aborted) put({ content: 'Réponse interrompue.', error: true })
      else put({ content: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  // Les images d'une proposition viennent de la dernière question jointe avant elle.
  const baseAt = (i: number) => msgs.slice(0, i).reverse().find((m) => m.base)?.base

  return (
    <aside className="claude" hidden={!open}>
      <div className="col-grip claude-grip" {...grip} />
      <div className="claude-head">
        <strong>Claude</strong>
        <span className="claude-note grow">{status?.mode === 'api' ? `API Anthropic · ${status.model}` : status?.mode === 'cli' ? 'via Claude Code (votre abonnement)' : ''}</span>
        {msgs.length > 0 && (
          <button disabled={busy} onClick={() => setMsgs([])} title="Effacer le dialogue et repartir de zéro">
            Nouveau
          </button>
        )}
        <button onClick={onClose} title="Fermer le panneau (le dialogue est conservé)">
          ✕
        </button>
      </div>

      <div className="claude-log" ref={log}>
        {status?.mode === 'none' && (
          <div className="claude-msg error">
            Claude n’est pas configuré sur cet ordinateur. Deux possibilités :{'\n'}• installer Claude Code et s’y connecter (aucune clé à gérer) ;{'\n'}• ou coller une clé d’API Anthropic dans le fichier data_prive/cle_claude.txt.{'\n'}Relancez ensuite l’application.
          </div>
        )}
        {!msgs.length && status?.mode !== 'none' && (
          <p className="hint">
            Demandez à Claude de générer une question (« Rédige 2 QCM sur le moment de force, niveau 1<sup>re</sup> année ») ou d’améliorer la question sélectionnée. Chaque proposition s’affiche en aperçu, avec un bouton pour l’ajouter à la banque ou remplacer la question.
          </p>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="claude-msg user">
              {m.attached && <span className="claude-att">Question jointe : {m.attached}</span>}
              {m.shown}
            </div>
          ) : m.error ? (
            <div key={i} className="claude-msg error">
              {m.content}
            </div>
          ) : (
            <Answer key={i} content={m.content} base={baseAt(i)} waiting={busy && i === msgs.length - 1} canReplace={!!current} onAdd={onAdd} onReplace={onReplace} />
          ),
        )}
      </div>

      {current && attach && !busy && (
        <div className="claude-quick">
          {QUICK.map((p) => (
            <button key={p} onClick={() => send(p)}>
              {p}
            </button>
          ))}
        </div>
      )}
      <form
        className="claude-form"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <textarea
          value={input}
          placeholder="Votre demande à Claude… (Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(input)
            }
          }}
        />
        <div className="row">
          <label className="check grow" title={current ? qName(current) : 'Sélectionnez une question dans la banque pour la joindre'}>
            <input type="checkbox" checked={attach && !!current} disabled={!current} onChange={(e) => setAttach(e.target.checked)} />
            Joindre la question sélectionnée
          </label>
          {busy ? (
            <button type="button" onClick={() => abort.current?.abort()}>
              Arrêter
            </button>
          ) : (
            <button className="primary" disabled={!input.trim() || status?.mode === 'none'}>
              Envoyer
            </button>
          )}
        </div>
        <span className="claude-note">Vos messages et le texte de la question jointe sont envoyés à Anthropic. Les images ne le sont pas. Rien d’autre de la banque ne quitte cet ordinateur.</span>
      </form>
    </aside>
  )
}

function Answer({ content, base, waiting, canReplace, onAdd, onReplace }: { content: string; base: Question | undefined; waiting: boolean; canReplace: boolean; onAdd: (q: Question) => void; onReplace: (q: Question) => void }) {
  const parts = useMemo(() => segments(content, base), [content, base])
  const [done, setDone] = useState<Record<number, string>>({})
  // Chaque clic repart d'une copie : la proposition peut servir plusieurs fois.
  const copy = (q: Question): Question => structuredClone(q)
  return (
    <div className="claude-msg assistant">
      {!content && waiting && <span className="claude-wait">Claude réfléchit…</span>}
      {parts.map((p, i) =>
        'text' in p ? (
          <div key={i} className="claude-text" dangerouslySetInnerHTML={{ __html: pretty(p.text) }} />
        ) : 'broken' in p ? (
          <div key={i} className="claude-msg error">
            Proposition illisible (XML invalide) :{'\n'}
            {p.broken.slice(0, 400)}
          </div>
        ) : (
          <div key={i} className="claude-card">
            <div className="claude-card-head">
              <span className="grow">{qName(p.q) || 'Proposition'}</span>
              <span>{typeLabel(p.q.type)}</span>
            </div>
            <QuestionPreview q={p.q} />
            <Issues issues={lintQuestion(p.q)} />
            <div className="claude-card-actions">
              <button
                className="primary"
                onClick={() => {
                  onAdd(copy(p.q))
                  setDone({ ...done, [i]: 'Ajoutée à la banque' })
                }}
              >
                Ajouter à la banque
              </button>
              {canReplace && (
                <button
                  onClick={() => {
                    if (!confirm('Remplacer la question sélectionnée par cette proposition ? La version actuelle restera dans l’historique.')) return
                    onReplace(copy(p.q))
                    setDone({ ...done, [i]: 'Question remplacée' })
                  }}
                >
                  Remplacer la question sélectionnée
                </button>
              )}
              {done[i] && <span className="claude-note">{done[i]} ✓</span>}
            </div>
          </div>
        ),
      )}
    </div>
  )
}
