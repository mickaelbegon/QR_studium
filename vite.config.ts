import { createReadStream, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

const DATA_DIR = fileURLToPath(new URL('./data_prive', import.meta.url))

/**
 * Donne à l'application (et à elle seule, sur localhost) la liste et le contenu des
 * fichiers .xml et .json posés dans data_prive/, pour les charger au lancement.
 */
function dataPrive(): Plugin {
  const wanted = (name: string) => /\.(xml|json)$/i.test(name)
  return {
    name: 'data-prive',
    configureServer(server) {
      server.middlewares.use('/api/data-prive', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const name = url.searchParams.get('name')
        try {
          if (name === null) {
            const files = readdirSync(DATA_DIR, { withFileTypes: true })
              .filter((d) => d.isFile() && wanted(d.name))
              .map((d) => {
                const s = statSync(join(DATA_DIR, d.name))
                return { name: d.name, size: s.size, mtime: Math.round(s.mtimeMs) }
              })
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(files))
            return
          }
          // Uniquement un fichier situé directement dans data_prive/.
          if (name !== basename(name) || !wanted(name)) throw new Error('nom refusé')
          const path = join(DATA_DIR, name)
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
  server: { host: 'localhost', port: 5173 },
  test: { environment: 'jsdom', testTimeout: 120000 },
})
