import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // L'application reste strictement locale : le serveur n'écoute que sur localhost.
  server: { host: 'localhost', port: 5173 },
  test: { environment: 'jsdom', testTimeout: 120000 },
})
