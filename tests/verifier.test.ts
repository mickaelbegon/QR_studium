// Outil : vérifie un fichier Moodle XML avec l'analyseur et les alertes de l'application.
//   QR_XML=<fichier.xml> [QR_OUT=<rapport.txt>] npx vitest run tests/verifier.test.ts
// Sans QR_XML, le test est ignoré (il ne fait donc rien pendant `npm test`).
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseCloze } from '../src/cloze'
import { dragBoxes, dropZones } from '../src/dragbox'
import { lintQuestion } from '../src/lint'
import { getText, plain, qName } from '../src/model'
import { parseMoodleXml } from '../src/moodleXml'

it.skipIf(!process.env.QR_XML)('fichier Moodle XML valide pour l’application', () => {
  const file = process.env.QR_XML!
  const { questions } = parseMoodleXml(readFileSync(file, 'utf8'), file)
  const lines: string[] = [`${questions.length} question(s) dans ${file}`]
  let errors = 0
  for (const q of questions) {
    const issues = lintQuestion(q).map((i) => `${i.level}: ${i.msg}`)
    const text = getText(q, 'questiontext')?.text ?? ''
    if (!qName(q).trim()) issues.push('error: titre vide')
    if (!plain(text).trim()) issues.push('error: énoncé vide')
    let detail = ''
    if (q.type === 'cloze') {
      const parts = parseCloze(text)
      detail = `${parts.length} trou(s)`
      if (!parts.length) issues.push('error: aucun trou reconnu dans le texte à trous')
      parts.forEach((p, i) => {
        if (!p.options.some((o) => o.fraction >= 100)) issues.push(`error: trou ${i + 1} sans bonne réponse à 100 %`)
        if ((p.kind === 'mc' || p.kind === 'mr') && p.options.length < 2) issues.push(`error: trou ${i + 1} avec un seul choix`)
      })
    } else if (q.type === 'ddwtos') {
      const boxes = dragBoxes(q)
      const zones = dropZones(text)
      detail = `${zones.length} zone(s), ${boxes.length} choix`
      if (!zones.length) issues.push('error: aucune zone [[n]] dans l’énoncé')
      for (const z of zones) {
        if (z < 1 || z > boxes.length) issues.push(`error: zone [[${z}]] sans choix correspondant`)
      }
      if (new Set(zones).size !== zones.length && !zones.every((z) => boxes[z - 1]?.box.infinite || zones.filter((x) => x === z).length === 1)) issues.push('warn: un choix non réutilisable sert à plusieurs zones')
    } else if (q.type === 'matching') {
      const filled = q.subquestions.filter((s) => plain(s.rt.text).trim())
      detail = `${filled.length} paire(s), ${new Set(q.subquestions.map((s) => s.answer.trim()).filter(Boolean)).size} réponse(s) distincte(s)`
      if (filled.length < 3) issues.push('error: moins de 3 paires')
      if (q.subquestions.some((s) => plain(s.rt.text).trim() && !s.answer.trim())) issues.push('error: une paire sans réponse')
    } else if (q.type === 'multichoice') {
      detail = `${q.answers.length} choix`
    }
    errors += issues.filter((i) => i.startsWith('error')).length
    lines.push(`\n[${q.type}] ${qName(q)} — ${detail}`, ...issues.map((i) => '   ' + i))
  }
  lines.push(`\n${errors} erreur(s)`)
  if (process.env.QR_OUT) writeFileSync(process.env.QR_OUT, lines.join('\n'))
  else console.log(lines.join('\n'))
  expect(errors).toBe(0)
})
