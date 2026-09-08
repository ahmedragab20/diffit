import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HotkeysProvider } from '@tanstack/react-hotkeys'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'
// Register the <diffs-container> custom element. @pierre/diffs marks only
// this one file as side-effectful, but `components/FileDiff.js` (which
// imports it) is not — so esbuild's dev pre-bundler drops the whole chain
// and the element never registers. Importing it directly keeps it alive.
import '../../node_modules/@pierre/diffs/dist/components/web-components.js'
import { TooltipProvider } from './primitives/Tooltip'
import { observePageVisibility } from './lib/pauseWhenHidden'
import { Root } from './Root'
import { installSessionAuth } from './session-auth'
import { AiProvider } from './ai/AiContext'
import './styles/global.css'
// Gridline is the canonical web design-system layer. Keep it last: it adapts
// the legacy component stylesheet to the same terminal-native contract as the
// Rust TUI while components migrate away from historical one-off styling.
import './styles/gridline.css'

const queryClient = new QueryClient()

installSessionAuth()

observePageVisibility()

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <HotkeysProvider>
      <WorkerPoolContextProvider
        poolOptions={{
          workerFactory: () => new DiffsWorker(),
          poolSize: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)),
        }}
        highlighterOptions={{
          theme: {
            dark: 'rose-pine',
            light: 'github-light',
          },
          // Vue's compound grammar is comparatively expensive to resolve. If
          // it is loaded on the first render task, pierre can leave that first
          // FileDiff on its plain-text placeholder until a remount. Initial
          // worker loading makes the highlighted AST available on first paint.
          langs: ['vue'],
        }}
      >
        <TooltipProvider>
          <AiProvider>
            <Root />
          </AiProvider>
        </TooltipProvider>
      </WorkerPoolContextProvider>
    </HotkeysProvider>
  </QueryClientProvider>,
)
