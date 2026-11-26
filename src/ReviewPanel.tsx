import { type Question, type Review, emptyReview } from './model'
import type { Report, Suggestion } from './report'

export const PERTINENCES = ['Haute', 'Moyenne', 'Faible']
export const DIRECTIONS = ['Garder', 'Améliorer', 'Corriger avant usage']
export const directionClass = (d: string | undefined): string => (d === 'Corriger avant usage' ? 'fix' : d === 'Améliorer' ? 'improve' : d === 'Garder' ? 'keep' : '')

/** Note de révision d'une question : pertinence, direction de travail, problème et correction proposée. */
export function ReviewBox({ q, onChange, onCorrected, onRemove }: { q: Question; onChange: (r: Review) => void; onCorrected: () => void; onRemove: () => void }) {
  const r = q.meta.review
  if (!r || r.removed)
    return (
      <button className="add-review" onClick={() => onChange({ ...emptyReview(), origine: r?.origine, theme: r?.theme ?? '', doublons: r?.doublons ?? [], edited: true })}>
        + Ajouter une note de révision
      </button>
    )
  const set = (patch: Partial<Review>) => onChange({ ...r, ...patch, edited: true })
  const area = (key: 'probleme' | 'correction' | 'cle', label: string) => (
    <label>
      {label}
      <textarea key={q.id + key + '|' + r[key]} rows={2} defaultValue={r[key]} onBlur={(e) => e.target.value !== r[key] && set({ [key]: e.target.value })} />
    </label>
  )
  return (
    <div className={'review ' + directionClass(r.direction)}>
      <div className="row">
        <strong className="grow">Note de révision</strong>
        {r.theme && <span className="hint">{r.theme}</span>}
        {r.origine != null && <span className="hint">ID d’origine : {r.origine}</span>}
      </div>
      <div className="row">
        {(r.direction !== 'Garder' || r.probleme || r.correction || r.cle) && (
          <>
            <span className={'chip todo ' + (r.direction === 'Améliorer' ? 'improve' : 'fix')}>{r.direction === 'Améliorer' ? 'À améliorer' : 'À corriger'}</span>
            <button className="primary done" onClick={onCorrected} title="Passe la direction à « Garder », efface le problème et la correction, et range la question dans la catégorie de sa pertinence">
              J’ai corrigé cette question
            </button>
          </>
        )}
        <span className="grow" />
        <button className="danger" onClick={onRemove} title="Retire entièrement la note de révision de cette question">
          Supprimer la note
        </button>
      </div>
      <div className="row">
        <label>
          Pertinence
          <select value={r.pertinence} onChange={(e) => set({ pertinence: e.target.value })}>
            <option value="">—</option>
            {[...new Set([...PERTINENCES, r.pertinence].filter(Boolean))].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select value={r.direction} onChange={(e) => set({ direction: e.target.value })}>
            <option value="">—</option>
            {[...new Set([...DIRECTIONS, r.direction].filter(Boolean))].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        {r.doublons.length > 0 && <span className="hint">Doublons retirés : {r.doublons.join(', ')}</span>}
      </div>
      {area('probleme', 'Problème constaté')}
      {area('correction', 'Correction proposée')}
      {(r.cle || r.edited) && area('cle', 'Clé de correction discutable')}
    </div>
  )
}

/** Vue d'ensemble du rapport : répartition, défauts récurrents, lacunes, questions suggérées. */
export function ReportView({ reports, questions, onCreate, existing, onOpen, onExport, onShow }: { reports: Report[]; questions: Question[]; onCreate: (s: Suggestion) => void; existing: (s: Suggestion) => string | null; onOpen: (id: string) => void; onExport: (r: Report) => void; onShow: (direction: string) => void }) {
  if (!reports.length)
    return (
      <div className="empty">
        <h1>Aucun rapport importé</h1>
        <p>Importez le fichier JSON d’analyse qui accompagne une banque : ses notes seront rattachées aux questions.</p>
      </div>
    )
  const reviewed = questions.filter((q) => q.meta.review && !q.meta.review.removed)
  const count = (d: string) => reviewed.filter((q) => q.meta.review!.direction === d).length
  return (
    <div className="report">
      {reports.map((rep) => {
        const d = rep.data
        const meta = (d.meta ?? {}) as Record<string, unknown>
        const criteres = (meta.criteres_pertinence ?? {}) as Record<string, string>
        const repartition = (meta.repartition ?? {}) as Record<string, Record<string, number>>
        return (
          <section key={rep.name}>
            <div className="row">
              <h1 className="grow">{String(meta.cours ?? rep.name)}</h1>
              <button onClick={() => onExport(rep)}>Exporter les notes à jour (JSON)</button>
            </div>
            <p className="hint">
              {rep.name}
              {meta.date ? ` · analyse du ${meta.date}` : ''} · {d.questions.length} questions dans le rapport, {reviewed.length} rattachées à la banque locale
            </p>
            {typeof meta.lecture === 'string' && <p>{meta.lecture}</p>}

            <div className="cards">
              {DIRECTIONS.map((dir) => (
                <button key={dir} className={'card ' + directionClass(dir)} onClick={() => onShow(dir)} title="Afficher ces questions dans la banque">
                  <span className="big">{count(dir)}</span>
                  {dir}
                </button>
              ))}
            </div>

            {Object.keys(repartition).length > 0 && (
              <>
                <h2>Répartition par thème et pertinence</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Thème</th>
                      {PERTINENCES.map((p) => (
                        <th key={p} title={criteres[p]}>
                          {p}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(repartition).map(([theme, v]) => (
                      <tr key={theme}>
                        <td>{theme}</td>
                        {PERTINENCES.map((p) => (
                          <td key={p} className="num-cell">
                            {v[p] ?? 0}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="hint">
                  {PERTINENCES.filter((p) => criteres[p])
                    .map((p) => `${p} : ${criteres[p]}`)
                    .join(' · ')}
                </p>
              </>
            )}

            {!!d.defauts_recurrents?.length && (
              <>
                <h2>Défauts récurrents</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Défaut</th>
                      <th>Portée</th>
                      <th>Correction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.defauts_recurrents.map((x, i) => (
                      <tr key={i}>
                        <td>{x.defaut}</td>
                        <td>{x.portee}</td>
                        <td>{x.correction}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {!!d.lacunes?.length && (
              <>
                <h2>Lacunes de la banque</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Thème</th>
                      <th>Constat</th>
                      <th>Objectif du plan de cours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lacunes.map((x, i) => (
                      <tr key={i}>
                        <td>{x.theme}</td>
                        <td>{x.constat}</td>
                        <td>{x.objectif_plan_de_cours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {!!d.questions_suggerees?.length && (
              <>
                <h2>Questions suggérées</h2>
                <div className="suggestions">
                  {d.questions_suggerees.map((s, i) => (
                    <div key={i} className="suggestion">
                      <div className="row">
                        <span className="hint grow">
                          {s.theme}
                          {s.pertinence_visee ? ` · pertinence visée : ${s.pertinence_visee}` : ''}
                        </span>
                        {existing(s) ? (
                          <button className="done" onClick={() => onOpen(existing(s)!)} title="Une question de la banque a déjà cet énoncé">
                            ✓ Déjà créée · ouvrir
                          </button>
                        ) : (
                          <button onClick={() => onCreate(s)}>Créer cette question</button>
                        )}
                      </div>
                      <p>{s.enonce}</p>
                      <ul>
                        {s.options.map((o, k) => (
                          <li key={k} className={k === s.bonne_reponse ? 'ok' : ''}>
                            {o}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )
      })}
    </div>
  )
}
