import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// QR_DATA_DIR permet de pointer vers un autre dossier (essais, autre cours).
const DATA_DIR = process.env.QR_DATA_DIR || fileURLToPath(new URL('./data_prive', import.meta.url))
const SAVE_DIR = join(DATA_DIR, 'sauvegardes')
/** Nombre de jours de sauvegarde conservés (une sauvegarde par jour, réécrite au fil de la journée). */
const KEEP_DAYS = 3
const SAVE_NAME = /^(banque|notes)-\d{4}-\d{2}-\d{2}\.(xml|json)$/

/** Refuse les requêtes venant d'une autre page web que l'application elle-même. */
function fromApp(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const site = req.headers['sec-fetch-site']
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return false
  return !site || site === 'same-origin' || site === 'none'
}

// ---- Assistant Claude ----
// Avec une clé d'API (variable ANTHROPIC_API_KEY ou fichier data_prive/cle_claude.txt) : appel direct de l'API.
// Sans clé : Claude Code installé sur l'ordinateur répond, avec l'abonnement de la personne connectée.
const CLAUDE_MODEL = process.env.QR_CLAUDE_MODEL || 'claude-opus-5-5'

function claudeKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  try {
    return readFileSync(join(DATA_DIR, 'cle_claude.txt'), 'utf8').trim()
  } catch {
    return ''
  }
}
let cli: boolean | null = null
const hasCli = () => (cli ??= spawnSync('claude', ['--version'], { timeout: 20000, windowsHide: true }).status === 0)
const claudeMode = () => (claudeKey() ? 'api' : hasCli() ? 'cli' : 'none')

type Turn = { role: 'user' | 'assistant'; content: string }

async function askApi(key: string, system: string, messages: Turn[], res: ServerResponse) {
  const client = new Anthropic({ apiKey: key })
  // Si le modèle décline une demande, l'API la confie d'elle-même à un modèle de repli.
  const fallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(CLAUDE_MODEL)
  const stream = client.beta.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: 64000,
    system,
    messages,
    cache_control: { type: 'ephemeral' },
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  })
  res.on('close', () => stream.abort())
  stream.on('text', (t) => res.write(t))
  try {
    const msg = await stream.finalMessage()
    if (msg.stop_reason === 'refusal') res.write('\n\n[Claude a décliné cette demande.]')
    else if (msg.stop_reason === 'max_tokens') res.write('\n\n[Réponse coupée : elle était trop longue. Demandez la suite.]')
    res.end()
  } catch (e) {
    if (res.writableEnded || res.destroyed) return
    const why =
      e instanceof Anthropic.AuthenticationError
        ? 'Clé d’API Anthropic refusée. Vérifiez data_prive/cle_claude.txt ou la variable ANTHROPIC_API_KEY.'
        : e instanceof Anthropic.PermissionDeniedError
          ? 'Cette clé d’API n’a pas accès au modèle ' + CLAUDE_MODEL + '.'
          : e instanceof Anthropic.RateLimitError
            ? 'Limite de débit atteinte chez Anthropic. Réessayez dans une minute.'
            : e instanceof Anthropic.APIConnectionError
              ? 'Connexion à Anthropic impossible. Vérifiez l’accès à Internet.'
              : e instanceof Anthropic.APIError
                ? `Erreur de l’API Anthropic (${e.status ?? '?'}) : ${e.message}`
                : 'Erreur inattendue : ' + (e instanceof Error ? e.message : String(e))
    if (res.headersSent) res.end('\n\n[' + why + ']')
    else {
      res.statusCode = 502
      res.end(why)
    }
  }
}

function askCli(system: string, messages: Turn[], res: ServerResponse) {
  // Claude Code ne reçoit aucun outil : il ne peut ni lire de fichier ni lancer de commande, seulement répondre.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--system-prompt', system, '--tools', '']
  if (process.env.QR_CLAUDE_MODEL) args.push('--model', process.env.QR_CLAUDE_MODEL)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_?CODE/i.test(k)))
  const child = spawn('claude', args, { cwd: tmpdir(), env, windowsHide: true })
  const tag = (m: Turn) => (m.role === 'user' ? 'professeur' : 'claude')
  const prompt =
    messages.length === 1
      ? messages[0].content
      : 'Voici le dialogue jusqu’ici. Réponds au dernier message du professeur.\n\n' + messages.map((m) => `<${tag(m)}>\n${m.content}\n</${tag(m)}>`).join('\n\n')
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
  let buffer = ''
  let wrote = false
  let errors = ''
  const line = (l: string) => {
    let ev: any
    try {
      ev = JSON.parse(l)
    } catch {
      return
    }
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
      wrote = true
      res.write(ev.event.delta.text)
    } else if (ev.type === 'result') {
      if (ev.is_error) errors += String(ev.result ?? '')
      else if (!wrote && typeof ev.result === 'string') {
        wrote = true
        res.write(ev.result)
      }
    }
  }
  child.stdout.on('data', (d) => {
    buffer += d
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.filter(Boolean).forEach(line)
  })
  child.stderr.on('data', (d) => (errors += d))
  res.on('close', () => child.kill())
  const fail = (why: string) => {
    if (res.writableEnded || res.destroyed) return
    if (wrote) res.end('\n\n[' + why + ']')
    else {
      res.statusCode = 502
      res.end(why)
    }
  }
  child.on('error', () => fail('Claude Code n’a pas pu être lancé.'))
  child.on('close', (code) => {
    if (buffer.trim()) line(buffer)
    if (wrote) res.end()
    else fail('Claude Code n’a pas répondu' + (errors.trim() ? ' : ' + errors.trim().slice(0, 500) : ` (code ${code}).`) + ' Ouvrez Claude Code une fois pour vérifier que vous y êtes connecté.')
  })
}

function claudeApi(): Plugin {
  return {
    name: 'claude',
    configureServer(server) {
      server.middlewares.use('/api/claude', (req, res) => {
        if (!fromApp(req)) {
          res.statusCode = 403
          res.end()
          return
        }
        res.setHeader('Cache-Control', 'no-store')
        if (req.method !== 'POST') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ mode: claudeMode(), model: CLAUDE_MODEL }))
          return
        }
        let body = ''
        req.on('data', (d) => {
          body += d
          if (body.length > 4_000_000) req.destroy()
        })
        req.on('end', () => {
          let system = ''
          let messages: Turn[] = []
          try {
            const j = JSON.parse(body)
            system = String(j.system ?? '')
            messages = (j.messages as Turn[]).filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
            if (!messages.length || messages[messages.length - 1].role !== 'user') throw new Error('messages')
          } catch {
            res.statusCode = 400
            res.end('Demande invalide.')
            return
          }
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          const key = claudeKey()
          if (key) askApi(key, system, messages, res)
          else if (hasCli()) askCli(system, messages, res)
          else {
            res.statusCode = 503
            res.end('Claude n’est pas configuré : installez Claude Code, ou placez une clé d’API Anthropic dans data_prive/cle_claude.txt, puis relancez l’application.')
          }
        })
      })
    },
  }
}

/**
 * Donne à l'application (et à elle seule, sur localhost) la liste et le contenu des
 * fichiers .xml et .json posés dans data_prive/, pour les charger au lancement.
 */
function dataPrive(): Plugin {
  const wanted = (name: string) => /\.(xml|json)$/i.test(name)
  return {
    name: 'data-prive',
    configureServer(server) {
      // Sauvegarde automatique : l'application envoie la banque, le serveur l'écrit dans data_prive/sauvegardes/.
      server.middlewares.use('/api/sauvegarde', (req, res) => {
        const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
        if (req.method !== 'POST' || !fromApp(req) || !SAVE_NAME.test(name)) {
          res.statusCode = 400
          res.end()
          return
        }
        const fail = () => {
          res.statusCode = 500
          res.end()
        }
        try {
          mkdirSync(SAVE_DIR, { recursive: true })
          // Écriture dans un fichier temporaire puis renommage : jamais de sauvegarde à moitié écrite.
          const tmp = join(SAVE_DIR, name + '.tmp')
          const out = createWriteStream(tmp)
          out.on('error', fail)
          req.on('error', fail)
          out.on('finish', async () => {
            try {
              // Sous Windows, le remplacement échoue tant qu'un autre programme (antivirus, éditeur, indexation)
              // tient l'ancienne sauvegarde ouverte : on réessaie, puis on recopie par-dessus en dernier recours.
              const target = join(SAVE_DIR, name)
              for (let attempt = 0; ; attempt++) {
                try {
                  renameSync(tmp, target)
                  break
                } catch (e) {
                  if (attempt < 8) {
                    await new Promise((r) => setTimeout(r, 250))
                    continue
                  }
                  copyFileSync(tmp, target)
                  unlinkSync(tmp)
                  break
                }
              }
              const prefix = name.split('-')[0]
              const old = readdirSync(SAVE_DIR)
                .filter((f) => SAVE_NAME.test(f) && f.startsWith(prefix + '-'))
                .sort()
                .reverse()
                .slice(KEEP_DAYS)
              for (const f of old) unlinkSync(join(SAVE_DIR, f))
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, dossier: 'data_prive/sauvegardes', fichier: name }))
            } catch (e) {
              // La raison s'affiche dans la fenêtre de lancement, pour pouvoir la diagnostiquer.
              console.error(`[sauvegarde] ${name} n'a pas pu être écrite :`, e instanceof Error ? e.message : e)
              fail()
            }
          })
          req.pipe(out)
        } catch {
          fail()
        }
      })

      server.middlewares.use('/api/data-prive', (req, res) => {
        if (!fromApp(req)) {
          res.statusCode = 403
          res.end()
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const name = url.searchParams.get('name')
        // ?dossier=sauvegardes : les sauvegardes automatiques plutôt que les fichiers d'origine.
        const saves = url.searchParams.get('dossier') === 'sauvegardes'
        const dir = saves ? SAVE_DIR : DATA_DIR
        const allowed = (n: string) => (saves ? SAVE_NAME.test(n) : wanted(n))
        try {
          if (name === null) {
            const files = readdirSync(dir, { withFileTypes: true })
              .filter((d) => d.isFile() && allowed(d.name))
              .map((d) => {
                const s = statSync(join(dir, d.name))
                return { name: d.name, size: s.size, mtime: Math.round(s.mtimeMs) }
              })
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(files))
            return
          }
          // Uniquement un fichier situé directement dans data_prive/.
          if (name !== basename(name) || !allowed(name)) throw new Error('nom refusé')
          const path = join(dir, name)
          res.setHeader('Content-Length', statSync(path).size)
          res.setHeader('Content-Type', 'application/octet-stream')
          createReadStream(path).pipe(res)
        } catch {
          // Dossier ou fichier absent : rien à charger.
          if (name === null) {
            res.setHeader('Content-Type', 'application/json')
            res.end('[]')
          } else {
            res.statusCode = 404
            res.end()
          }
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), dataPrive(), claudeApi()],
  // L'application reste strictement locale : le serveur n'écoute que sur localhost.
  // Port fixe : la banque locale du navigateur est liée à l'adresse, un autre port montrerait une banque vide.
  server: { host: 'localhost', port: 5173, strictPort: true },
  test: { environment: 'jsdom', testTimeout: 120000 },
})
