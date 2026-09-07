import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isBuiltin } from 'node:module'
import { basename, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Port of the `pnpm dev:server` backend (must match `dev:server` in package.json). */
const DEV_BACKEND_PORT = 3433

interface DevServerLock {
  port?: number
  authToken?: string
}

/**
 * Read the session token the dev backend wrote into the repo server lock
 * (`~/.diffing/<repo>-<hash>/server.json`). Only accept locks bound to the
 * dev backend port so a production `diffing` session for this repo can never
 * leak its token into dev. Returns null when the backend isn't up yet — the
 * page then just needs a reload once it is.
 */
function devBackendAuthToken(): string | null {
  try {
    const root = process.cwd()
    const hash = createHash('sha256').update(root).digest('hex').slice(0, 8)
    const lock = JSON.parse(
      readFileSync(join(homedir(), '.diffing', `${basename(root)}-${hash}`, 'server.json'), 'utf-8'),
    ) as DevServerLock
    if (lock.port !== DEV_BACKEND_PORT || typeof lock.authToken !== 'string') return null
    return lock.authToken
  } catch {
    return null
  }
}

/**
 * Dev-mode session auth bridge. In production the backend serves the UI and
 * injects `window.__DIFFING_SESSION_TOKEN__` (and the HttpOnly cookie) into
 * the HTML it returns. In dev the vite dev server serves the HTML, so the
 * backend never gets that chance and every `/api/*` request would 401.
 * Mirror `injectSessionTokenIntoHtml` here so the browser can pick the token
 * up from the served page exactly as in production.
 */
function diffingDevSessionAuthPlugin(): Plugin {
  return {
    name: 'diffing-dev-session-auth',
    apply: 'serve',
    transformIndexHtml(html) {
      const token = devBackendAuthToken()
      if (!token) return html
      const script = `<script>window.__DIFFING_SESSION_TOKEN__="${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}";</script>`
      return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${script}${html}`
    },
  }
}

/** Fail before Vite replaces server dependencies with empty browser shims. */
export function browserOnlyPlugin(): Plugin {
  return {
    name: 'diffing-browser-only',
    enforce: 'pre',
    resolveId(source, importer) {
      if (isBuiltin(source)) {
        this.error(`Node-only module "${source}" imported by "${importer}" in the browser UI`)
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [browserOnlyPlugin(), react(), diffingDevSessionAuthPlugin()],
  root: '.',
  // Ensure a single React instance across the app and Base UI primitives,
  // otherwise hooks inside Base UI components throw "Invalid hook call".
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      '@base-ui-components/react/dialog',
      '@base-ui-components/react/tooltip',
      '@base-ui-components/react/select',
      '@base-ui-components/react/popover',
    ],
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3433',
    },
  },
})
