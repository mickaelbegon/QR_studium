import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCloze } from '../src/cloze'
import { findDuplicates, lintQuestion } from '../src/lint'
import { categoryParts, comparable, getProp, getText, newQuestion, qName } from '../src/model'
import { parseMoodleXml, serializeBank } from '../src/moodleXml'
import { applyReport, backupNotes, correctedCategory, exportReport, parseReport, syncTags } from '../src/report'

const fixture = readFileSync(join(__dirname, 'fixtures', 'exemple.xml'), 'utf8')

/** Lit, réécrit puis relit : le contenu doit être strictement identique. */
function roundTrip(xml: string, name: string) {
  const a = parseMoodleXml(xml, name)
  const out = serializeBank(a.questions, a.categories, (h) => a.files.get(h) ?? '')
  const b = parseMoodleXml(out, name)
  expect(b.questions.map(comparable)).toEqual(a.questions.map(comparable))
  expect(b.categories).toEqual(a.categories)
  expect([...b.files.entries()].sort()).toEqual([...a.files.entries()].sort())
  return a
}

describe('Moodle XML', () => {
  it('lit la structure de l’exemple', () => {
    const bank = parseMoodleXml(fixture, 'exemple.xml')
    expect(bank.questions.map((q) => q.type)).toEqual(['multichoice', 'truefalse', 'matching', 'cloze', 'description', 'numerical'])
    expect(bank.categories.map((c) => c.path)).toEqual(['$module$/top/Exemple/Biomécanique // cinématique', '$module$/top/Exemple/Autres'])
    expect(categoryParts(bank.questions[0].category)).toEqual(['Exemple', 'Biomécanique / cinématique'])
    expect(bank.questions[3].category).toBe('$module$/top/Exemple/Autres')

    const mc = bank.questions[0]
    expect(qName(mc)).toBe('Unité de force')
    expect(getProp(mc, 'idnumber')).toBe('EX-001')
    expect(getText(mc, 'generalfeedback')?.text).toContain('a &lt; b]]> c')
    expect(mc.tags).toEqual(['unités', 'cours 1'])
    expect(mc.answers.map((a) => a.fraction)).toEqual(['100', '0'])
    expect(getText(mc, 'questiontext')?.files[0].name).toBe('point rouge.png')
    expect(bank.files.size).toBe(1)

    expect(bank.questions[2].subquestions.map((s) => s.answer)).toEqual(['N', 'J', 'W'])
    // Les éléments non interprétés (unités, indices…) sont conservés tels quels.
    expect(bank.questions[5].extra.join('')).toContain('<unit_name>N</unit_name>')
    expect(bank.questions[5].answers[0].extra[0]).toContain('<tolerance>0.5</tolerance>')
  })

  it('réécrit l’exemple sans perte', () => {
    roundTrip(fixture, 'exemple.xml')
  })

  it('n’a aucune alerte bloquante sur l’exemple', () => {
    const bank = parseMoodleXml(fixture, 'exemple.xml')
    const dup = findDuplicates(bank.questions)
    for (const q of bank.questions) expect(lintQuestion(q, dup).filter((i) => i.level === 'error')).toEqual([])
  })

  it('signale les erreurs courantes', () => {
    const q = newQuestion('multichoice', '', 0)
    q.answers.forEach((a) => (a.fraction = '0'))
    const msgs = lintQuestion(q).map((i) => i.msg).join('\n')
    expect(msgs).toContain('Aucun choix ne vaut 100 %')
    expect(msgs).toContain('Le choix 1 est vide')
  })

  it('analyse la syntaxe cloze', () => {
    const parts = parseCloze('F = {1:MULTICHOICE:=m·a#Deuxième loi~m/a~%50%m·v} {2:NM:=9.81:0.1} {:SA:=a\\}b}')
    expect(parts.map((p) => p.kind)).toEqual(['mc', 'nm', 'sa'])
    expect(parts[0].options).toEqual([
      { fraction: 100, text: 'm·a', feedback: 'Deuxième loi' },
      { fraction: 0, text: 'm/a', feedback: '' },
      { fraction: 50, text: 'm·v', feedback: '' },
    ])
    expect(parts[1].weight).toBe(2)
    expect(parts[2].options[0].text).toBe('a}b')
  })
})

describe('Rapport JSON', () => {
  const data = {
    meta: { cours: 'Exemple', repartition: { A: { Haute: 1, Moyenne: 1, Faible: 0 } } },
    a_corriger_avant_usage: [{ id_moodle_origine: 2, probleme: 'Clé fausse', correction_proposee: 'Corriger', categorie_xml: 'c2' }],
    cles_discutables: [{ id: 1, probleme: 'Deux réponses défendables' }],
    questions: [
      { id_moodle_origine: 1, theme: 'A', pertinence: 'Haute', statut: 'Garder', probleme: null, correction_proposee: null, categorie_xml: 'c1', doublons_retires: [9] },
      { id_moodle_origine: 2, theme: 'A', pertinence: 'Moyenne', statut: 'Corriger avant usage', probleme: 'Clé fausse', correction_proposee: 'Corriger', categorie_xml: 'c2', doublons_retires: [] },
    ],
  }
  const bank = () => {
    const qs = [newQuestion('multichoice', '', 1), newQuestion('truefalse', '', 2), newQuestion('cloze', '', 3)]
    // Comme des questions venant d'un import XML : sans statut.
    qs.forEach((q) => (q.meta.status = ''))
    qs[0].tags = ['id-origine-1']
    qs[1].tags = ['pertinence-moyenne', 'id-origine-2']
    return qs
  }

  it('rattache les notes par l’étiquette id-origine', () => {
    const report = parseReport(JSON.stringify(data), 'r.json')
    const changed = applyReport(bank(), report.data)
    expect(changed.map((q) => q.meta.review?.origine)).toEqual([1, 2])
    expect(changed[0].meta.review).toMatchObject({ pertinence: 'Haute', direction: 'Garder', cle: 'Deux réponses défendables', doublons: [9] })
    expect(changed[1].meta.review).toMatchObject({ probleme: 'Clé fausse', correction: 'Corriger' })
    expect(() => parseReport('{"x":1}', 'r.json')).toThrow()
  })

  it('exporte les notes à jour et se relit', () => {
    const report = parseReport(JSON.stringify(data), 'r.json')
    const qs = bank()
    for (const q of applyReport(qs, report.data)) qs[qs.findIndex((x) => x.id === q.id)] = q
    // Sans modification, l'export redonne le rapport d'origine.
    const same = JSON.parse(exportReport(report, qs))
    expect(same.questions.map(({ etat_application: _e, note_privee: _n, ...e }: Record<string, unknown>) => e)).toEqual(data.questions)
    expect(same.a_corriger_avant_usage).toEqual(data.a_corriger_avant_usage)
    expect(same.meta).toEqual(data.meta)
    expect(same.cles_discutables).toEqual(data.cles_discutables)

    qs[1].meta.review = { ...qs[1].meta.review!, direction: 'Garder', pertinence: 'Haute', probleme: '', edited: true }
    qs[1].meta.note = 'revue en novembre'
    qs[1].meta.status = 'validee'
    const out = JSON.parse(exportReport(report, qs))
    expect(out.questions[1]).toMatchObject({ statut: 'Garder', pertinence: 'Haute', probleme: null, note_privee: 'revue en novembre', etat_application: 'validee' })
    expect(out.a_corriger_avant_usage).toEqual([])
    expect(out.meta.repartition).toEqual({ A: { Haute: 2, Moyenne: 0, Faible: 0 } })

    // Relu dans une banque vierge, l'export restitue notes, statut et note privée.
    const fresh = applyReport(bank(), parseReport(JSON.stringify(out), 'r2.json').data)
    expect(fresh[1].meta).toMatchObject({ status: 'validee', note: 'revue en novembre' })
    expect(fresh[1].meta.review).toMatchObject({ direction: 'Garder', pertinence: 'Haute' })
  })
})

describe('Question corrigée', () => {
  const cats = ['$course$/top/B/Cours 01/0 – À corriger avant usage', '$course$/top/B/Cours 01/1 – Pertinence haute', '$course$/top/B/Cours 02/0 – À corriger avant usage', '$course$/top/B/Cours 02/2 – Pertinence moyenne']

  it('trouve la catégorie de rangement selon la pertinence', () => {
    expect(correctedCategory(cats[0], 'Haute', cats)).toBe(cats[1])
    // Catégorie voisine absente : le libellé est repris d'un autre cours.
    expect(correctedCategory(cats[2], 'Haute', cats)).toBe('$course$/top/B/Cours 02/1 – Pertinence haute')
    expect(correctedCategory(cats[1], 'Haute', cats)).toBeNull()
    expect(correctedCategory(cats[0], '', cats)).toBeNull()
  })

  it('fait suivre les étiquettes de statut et de pertinence', () => {
    const tags = ['id-origine-5', 'pertinence-moyenne', 'statut-corriger-avant-usage']
    const r = { pertinence: 'Haute', direction: 'Garder', theme: '', probleme: '', correction: '', cle: '', doublons: [] }
    expect(syncTags(tags, r)).toEqual(['id-origine-5', 'pertinence-haute', 'statut-garder'])
    expect(syncTags(tags, { ...r, pertinence: '', direction: '' })).toEqual(['id-origine-5'])
    // Une question sans ces étiquettes n'en reçoit pas.
    expect(syncTags(['autre'], r)).toEqual(['autre'])
  })

  it('inclut les examens et les notes hors rapport dans la sauvegarde', () => {
    const q = newQuestion('multichoice', '', 1)
    q.meta.note = 'à revoir'
    const out = JSON.parse(backupNotes(undefined, [q], [{ name: 'Intra', items: [q.id] }], qName))
    expect(out.examens).toEqual([{ nom: 'Intra', questions: [{ nom: 'Nouvelle question', id_origine: null }] }])
    expect(out.autres_questions[0]).toMatchObject({ note_privee: 'à revoir', etat_application: 'brouillon' })
  })
})

// Test facultatif sur les vraies banques (dossier data_prive/, jamais versionné).
const priv = join(__dirname, '..', 'data_prive')
const privFiles = existsSync(priv) ? readdirSync(priv).filter((f) => f.endsWith('.xml')) : []
describe.skipIf(!privFiles.length)('Banques privées (data_prive/)', () => {
  for (const f of privFiles) {
    it(`réécrit ${f} sans perte`, () => {
      const bank = roundTrip(readFileSync(join(priv, f), 'utf8'), f)
      expect(bank.questions.length).toBeGreaterThan(0)
    })
  }
})

describe('formules mathématiques', () => {
  it('rend les délimiteurs de Moodle et laisse le reste intact', async () => {
    const { renderMath } = await import('../src/math')
    const html = renderMath('<p>Si \\(F = m \\cdot a\\) et $$\\frac{1}{2} &lt; x$$ alors 5 $ et 3 $.</p><select><option>\\(x\\)</option></select>')
    expect(html.match(/class="katex"/g)?.length).toBe(2)
    expect(html).toContain('katex-display')
    expect(html).toContain('5 $ et 3 $')
    expect(html).toContain('<option>\\(x\\)</option>')
    expect(renderMath('<p>Aucune formule</p>')).toBe('<p>Aucune formule</p>')
  })
})

describe('glisser-déposer sur texte', () => {
  it('lit et réécrit les choix à déposer', async () => {
    const { dragBoxXml, dragBoxes, dropZones, parseDragBox } = await import('../src/dragbox')
    const xml = `<quiz><question type="ddwtos"><name><text>GD</text></name><questiontext format="html"><text><![CDATA[<p>Le [[1]] fléchit le [[2]].</p>]]></text></questiontext>
    <shuffleanswers>1</shuffleanswers>
    <dragbox>
      <text>biceps &amp; co</text>
      <group>1</group>
    </dragbox>
    <dragbox>
      <text>coude</text>
      <group>2</group>
      <infinite/>
    </dragbox></question></quiz>`
    const q = parseMoodleXml(xml, 't').questions[0]
    const boxes = dragBoxes(q)
    expect(boxes.map((b) => b.box)).toEqual([
      { text: 'biceps & co', group: '1', infinite: false },
      { text: 'coude', group: '2', infinite: true },
    ])
    expect(dropZones('<p>Le [[1]] fléchit le [[2]].</p>')).toEqual([1, 2])
    // Un choix réécrit sans changement redonne le même XML : l'export reste identique.
    for (const { i, box } of boxes) expect(dragBoxXml(box)).toBe(q.extra[i])
    expect(parseDragBox(dragBoxXml({ text: 'a < b', group: '3', infinite: true }))).toEqual({ text: 'a < b', group: '3', infinite: true })
  })
})

describe('unités des questions numériques', () => {
  it('lit, réécrit et note avec les unités', async () => {
    const { getUnits, gradeNumerical, setUnitMode, setUnits, unitMode, unitsXml } = await import('../src/units')
    const xml = `<quiz><question type="numerical"><name><text>N</text></name><questiontext format="html"><text>d ?</text></questiontext>
    <answer fraction="100" format="moodle_auto_format"><text>5</text><tolerance>0.1</tolerance></answer>
    <unitgradingtype>1</unitgradingtype><unitpenalty>0.5000000</unitpenalty><showunits>0</showunits><unitsleft>0</unitsleft>
<units>
  <unit>
    <multiplier>1</multiplier>
    <unit_name>m</unit_name>
  </unit>
  <unit>
    <multiplier>100</multiplier>
    <unit_name>cm</unit_name>
  </unit>
</units></question></quiz>`
    const q = parseMoodleXml(xml, 't').questions[0]
    expect(getUnits(q)).toEqual([{ name: 'm', multiplier: '1' }, { name: 'cm', multiplier: '100' }])
    // Réécrites sans changement, les unités redonnent le même XML.
    expect(unitsXml(getUnits(q))).toBe(q.extra.find((x) => x.startsWith('<units')))
    expect(unitMode(q)).toBe('graded')
    expect(gradeNumerical(q, '5 m').fraction).toBe(1)
    expect(gradeNumerical(q, '505cm').fraction).toBe(1)
    expect(gradeNumerical(q, '5,05').fraction).toBe(0.5) // unité absente : pénalité
    expect(gradeNumerical(q, '5 km').fraction).toBe(0) // unité inconnue
    expect(gradeNumerical(q, '7 m').fraction).toBe(0)
    setUnitMode(q, 'none')
    expect(unitMode(q)).toBe('none')
    expect(gradeNumerical(q, '5').fraction).toBe(1)
    setUnitMode(q, 'optional')
    expect(gradeNumerical(q, '5').fraction).toBe(1)
    expect(gradeNumerical(q, '500 cm').fraction).toBe(1)
    setUnits(q, [])
    expect(q.extra.some((x) => x.startsWith('<units'))).toBe(false)
  })
})

describe('propositions de distracteurs', () => {
  it('lit le fichier et remplace les mauvaises réponses, en gardant celles qui sont conservées', async () => {
    const { applyProposal, parseProposals } = await import('../src/Proposals')
    const xml = `<quiz><question type="multichoice"><name><text>Q</text></name><questiontext format="html"><text>?</text></questiontext><single>true</single>
    <answer fraction="100" format="html"><text><![CDATA[<p>bonne</p>]]></text><feedback format="html"><text>oui</text></feedback></answer>
    <answer fraction="0" format="html"><text><![CDATA[<p>blague</p>]]></text><feedback format="html"><text>non, blague</text></feedback></answer>
    <answer fraction="0" format="html"><text><![CDATA[<p>plausible</p>]]></text><feedback format="html"><text>non</text></feedback></answer>
    <tags><tag><text>id-origine-42</text></tag></tags></question></quiz>`
    const q = parseMoodleXml(xml, 't').questions[0]
    expect(parseProposals('{"questions": []}')).toBeNull()
    const map = parseProposals(JSON.stringify([{ id_origine: '42', probleme: 'p', priorite: 'haute', distracteurs_proposes: [{ texte: 'Plausible', erreur_visee: 'conservé' }, { texte: 'a < b', erreur_visee: 'signe' }] }]))!
    const p = map.get(42)!
    const next = applyProposal({ ...q, meta: { ...q.meta, proposal: p } }, p)!
    expect(next.answers.map((a) => a.rt.text)).toEqual(['<p>bonne</p>', '<p>a &lt; b</p>', '<p>plausible</p>'])
    expect(next.answers.map((a) => a.feedback?.text)).toEqual(['oui', '', 'non'])
    expect(next.meta.proposal).toBeUndefined()
    // Nombre de choix différent : pas de substitution automatique.
    expect(applyProposal(q, { ...p, proposes: p.proposes.slice(0, 1) })).toBeNull()
  })
})

describe('catégories', () => {
  it('réécrit les niveaux affichés en gardant le préfixe technique', async () => {
    const { mapCategory, categoryLabel } = await import('../src/model')
    const strip = (p: string) => mapCategory(p, (parts) => parts.map((x) => x.replace(/^Cours \d+(-\d+)? [–-] /u, '')))
    expect(strip('$course$/top/KIN2024 – Banque/Cours 07-08 – Tissus et blessures/1 – Pertinence haute')).toBe('$course$/top/KIN2024 – Banque/Tissus et blessures/1 – Pertinence haute')
    expect(strip('$course$/top/Cours 03 – Outils')).toBe('$course$/top/Outils')
    expect(categoryLabel(mapCategory('$course$/top/A', () => ['Force//vitesse', 'B/C']))).toBe('Force//vitesse › B/C')
    expect(strip('')).toBe('')
  })
})

describe('nettoyage de la mise en forme', () => {
  it('retire paragraphes vides et sauts de ligne en trop sans toucher au texte', async () => {
    const { tidyHtml, tidyQuestion } = await import('../src/tidy')
    expect(tidyHtml('<p><p>La force est\nproportionnelle.</p><br></p>')).toBe('<p>La force est proportionnelle.</p>')
    expect(tidyHtml('<p></p><p>Quel\nmouvement&nbsp;?</p><br><p></p>')).toBe('<p>Quel mouvement&nbsp;?</p>')
    expect(tidyHtml('Pédalage<br>')).toBe('Pédalage')
    expect(tidyHtml('<p>&nbsp;</p><p>a<br>b</p><p><br></p>')).toBe('<p>a<br>b</p>')
    expect(tidyHtml('<p></p>\n<p>a</p>\n<p>b <em>c</em> d</p>\n<p></p>')).toBe('<p>a</p><p>b <em>c</em> d</p>')
    // Rien à retirer : rendu tel quel, à l'octet près.
    for (const same of ['<p>a<br>b</p>', '<p>Texte\nsur deux lignes</p>', '<p><img src="@@PLUGINFILE@@/a.png" alt=""></p>', 'true', '<p>x</p>\n<p>y <strong>z</strong></p>'])
      expect(tidyHtml(same)).toBe(same)
    expect(tidyHtml('<p><img src="@@PLUGINFILE@@/a.png" alt=""><br></p><p></p>')).toBe('<p><img src="@@PLUGINFILE@@/a.png" alt=""></p>')
    const q = parseMoodleXml(`<quiz><question type="multichoice"><name><text>Q</text></name><questiontext format="html"><text><![CDATA[<p>ok</p>]]></text></questiontext>
      <answer fraction="100" format="html"><text><![CDATA[<p><p>bonne</p><br></p>]]></text></answer>
      <answer fraction="0" format="html"><text><![CDATA[<p>autre</p>]]></text></answer></question></quiz>`, 't').questions[0]
    const t = tidyQuestion(q)!
    expect(t.answers.map((a) => a.rt.text)).toEqual(['<p>bonne</p>', '<p>autre</p>'])
    expect(tidyQuestion(t)).toBeNull()
  })
})

describe('glisser-déposer sur image', () => {
  it('lit, note et réécrit étiquettes et zones', async () => {
    const { dragXml, dropXml, gradeDd, readDd, removeDrag, writeDd } = await import('../src/ddimage')
    const xml = `<quiz><question type="ddimageortext"><name><text>GDI</text></name><questiontext format="html"><text>Placez.</text></questiontext>
    <shuffleanswers/>
    <file name="fond.png" encoding="base64">QUJD</file>
    <drag>
      <no>1</no>
      <text>Fémur &amp; co</text>
      <draggroup>1</draggroup>
    </drag>
    <drag>
      <no>2</no>
      <text>Leurre</text>
      <draggroup>1</draggroup>
    </drag>
    <drag>
      <no>3</no>
      <text>Oui</text>
      <draggroup>2</draggroup>
      <infinite/>
    </drag>
    <drop>
      <text>Zone A</text>
      <no>1</no>
      <choice>1</choice>
      <xleft>10</xleft>
      <ytop>20</ytop>
    </drop>
    <drop>
      <text>Zone B</text>
      <no>2</no>
      <choice>3</choice>
      <xleft>30</xleft>
      <ytop>40</ytop>
    </drop></question></quiz>`
    const q = parseMoodleXml(xml, 't').questions[0]
    const m = readDd(q)
    expect([m.bgName, m.bgData]).toEqual(['fond.png', 'QUJD'])
    expect(m.drags.map((d) => [d.no, d.text, d.group, d.infinite])).toEqual([[1, 'Fémur & co', '1', false], [2, 'Leurre', '1', false], [3, 'Oui', '2', true]])
    expect(m.drops.map((d) => [d.no, d.choice, d.x, d.y])).toEqual([[1, 1, 10, 20], [2, 3, 30, 40]])
    // Réécrits sans changement, ils redonnent le même XML.
    const raw = q.extra.filter((x) => /^<(drag|drop)/.test(x))
    expect([...m.drags.map(dragXml), ...m.drops.map(dropXml)]).toEqual(raw)
    expect(gradeDd(m, { 1: 1, 2: 3 })).toBe(1)
    expect(gradeDd(m, { 1: 2, 2: 3 })).toBe(0.5)
    expect(gradeDd(m, {})).toBe(0)
    // Supprimer le leurre renumérote l'étiquette suivante et la zone qui l'attend.
    const r = removeDrag(m, 2)
    writeDd(q, r.drags, r.drops)
    const m2 = readDd(q)
    expect(m2.drags.map((d) => d.text)).toEqual(['Fémur & co', 'Oui'])
    expect(m2.drops.map((d) => d.choice)).toEqual([1, 2])
    expect(m2.bgData).toBe('QUJD')
    expect(serializeBank([q], [], () => '')).toContain('<file name="fond.png" encoding="base64">QUJD</file>')
  })
})

describe('difficulté et temps', () => {
  it('lit un fichier de scores et résume un examen', async () => {
    const { parseScores, stats, statsLabel, fmtMin } = await import('../src/scores')
    expect(parseScores('[{"id_origine": 1, "nouveau": "x"}]')).toBeNull()
    const s = parseScores(JSON.stringify([{ cle: '42', difficulte: 3, temps_min: 1.5 }, { cle: 'T:Ma question', difficulte: 9, temps_min: 2 }]))!
    expect(s).toEqual([{ origine: 42, titre: '', difficulty: 3, minutes: 1.5 }, { origine: null, titre: 'Ma question', difficulty: undefined, minutes: 2 }])
    const mk = (difficulty: number | undefined, minutes: number | undefined, pts: number) => ({ ...newQuestion('multichoice', '', 1), meta: { ...newQuestion('multichoice', '', 1).meta, difficulty, minutes }, pts })
    const qs = [mk(2, 1, 1), mk(4, 3, 3), mk(undefined, undefined, 1)]
    const st = stats(qs, (q) => (q as unknown as { pts: number }).pts)
    expect([st.mean, st.weighted, st.minutes, st.noDifficulty, st.noMinutes]).toEqual([3, 3.5, 4, 1, 1])
    expect(st.levels).toEqual([0, 0, 1, 0, 1, 0])
    expect(statsLabel(st)).toBe('difficulté 3 · 4 min')
    expect(fmtMin(95)).toBe('1 h 35')
  })
})

describe('niveau cognitif', () => {
  it('lit le fichier de niveaux et pose une seule étiquette niveau-…', async () => {
    const { levelCounts, levelOf, parseLevels, withLevel } = await import('../src/levels')
    expect(parseLevels('[{"cle": "1", "difficulte": 2}]')).toBeNull()
    expect(parseLevels(JSON.stringify([{ cle: '42', niveau: 'Sait comment' }, { cle: 'T:Titre', niveau: 'analyse' }, { cle: '7', niveau: 'inconnu' }]))).toEqual([
      { origine: 42, titre: '', level: 'sait-comment' },
      { origine: null, titre: 'Titre', level: 'analyse' },
    ])
    const q = { ...newQuestion('multichoice', '', 1), tags: ['pertinence-haute', 'niveau-sait', 'id-origine-42'] }
    expect(levelOf(q)).toBe('sait')
    const q2 = withLevel(q, 'applique')
    expect(q2.tags).toEqual(['pertinence-haute', 'id-origine-42', 'niveau-applique'])
    expect(withLevel(q2, '').tags).toEqual(['pertinence-haute', 'id-origine-42'])
    expect(levelCounts([q, q2, withLevel(q2, '')])).toEqual({ counts: [1, 0, 0, 1, 0], none: 1 })
  })
})
