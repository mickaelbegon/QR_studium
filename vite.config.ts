import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
          out.on('finish', () => {
            try {
              renameSync(tmp, join(SAVE_DIR, name))
              const prefix = name.split('-')[0]
              const old = readdirSync(SAVE_DIR)
                .filter((f) => SAVE_NAME.test(f) && f.startsWith(prefix + '-'))
                .sort()
                .reverse()
                .slice(KEEP_DAYS)
              for (const f of old) unlinkSync(join(SAVE_DIR, f))
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true, dossier: 'data_prive/sauvegardes', fichier: name }))
            } catch {
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
  plugins: [react(), dataPrive()],
  // L'application reste strictement locale : le serveur n'écoute que sur localhost.
  // Port fixe : la banque locale du navigateur est liée à l'adresse, un autre port montrerait une banque vide.
  server: { host: 'localhost', port: 5173, strictPort: true },
  test: { environment: 'jsdom', testTimeout: 120000 },
})
