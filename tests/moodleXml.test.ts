import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCloze } from '../src/cloze'
import { findDuplicates, lintQuestion } from '../src/lint'
import { categoryParts, comparable, getProp, getText, newQuestion, qName } from '../src/model'
import { parseMoodleXml, serializeBank } from '../src/moodleXml'

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
