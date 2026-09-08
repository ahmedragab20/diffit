/**
 * A single place to ask for a definition to be shown.
 *
 * The request comes from deep inside a virtualized diff card, and the panel
 * that answers it is mounted once at the top of the app. Rather than thread a
 * callback through every card, cards publish here and the panel subscribes —
 * the same module-level registry pattern `diffNavigation.ts` uses for scroll
 * targets. Only one peek is open at a time, so a second request replaces the
 * first instead of stacking panels.
 */

export interface DefinitionPeekRequest {
  /** Repository-relative path of the file to show. */
  path: string
  /** One-based line to scroll to and highlight. */
  line: number
  /** The token that was clicked, used for the panel's title. */
  symbol: string
}

type Handler = (request: DefinitionPeekRequest | null) => void

const handlers = new Set<Handler>()

export function openDefinitionPeek(request: DefinitionPeekRequest): void {
  for (const handler of handlers) handler(request)
}

export function closeDefinitionPeek(): void {
  for (const handler of handlers) handler(null)
}

export function subscribeDefinitionPeek(handler: Handler): () => void {
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
  }
}
