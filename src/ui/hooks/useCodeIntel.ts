import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { subscribeLive } from '../live'

/** Mirrors the result shapes returned by `POST /api/code-intel`. */
export interface CodeIntelCapabilities {
  configured: boolean
  extensions: string[]
  unavailable?: string
}

export interface CodeIntelLocation {
  path: string
  line: number
  character: number
  endLine: number
  endCharacter: number
  inRepository: boolean
}

type CodeIntelResponse =
  | { available: false; reason: string; detail?: string }
  | { available: true; op: 'hover'; hover: string | null }
  | { available: true; op: 'definition' | 'references'; locations: CodeIntelLocation[] }

/** A position in the rendered diff, plus the element to anchor a popover to. */
export interface CodeIntelTarget {
  path: string
  side: 'additions' | 'deletions'
  /** One-based, as the diff gutter numbers it. */
  line: number
  /** Zero-based character offset within the line. */
  character: number
  tokenText: string
  anchor: HTMLElement
}

export type HoverStatus = 'pending' | 'ready' | 'empty' | 'unavailable'

export interface HoverState {
  target: CodeIntelTarget
  status: HoverStatus
  markdown: string | null
  /** Set when `status` is `unavailable`; explains why, never "no results". */
  reason?: string
}

const HOVER_DEBOUNCE_MS = 250
/**
 * Leaving a token does not close the popover immediately: the pointer needs a
 * moment to cross the gap and reach it, or a hover long enough to have a
 * scrollbar could never be read.
 */
const HOVER_CLOSE_GRACE_MS = 150
const CACHE_LIMIT = 300

/**
 * Capabilities are a property of the review, not of a file, so every card
 * shares one in-flight request. Cleared on a live `change` so a settings edit
 * that adds a language server is picked up without a reload.
 */
let capabilitiesPromise: Promise<CodeIntelCapabilities> | null = null

/**
 * Answers keyed by position. A language server reads the working tree, so the
 * `change` event — which already fires for every write the review makes — is
 * exactly the moment these stop being true.
 */
const answers = new Map<string, CodeIntelResponse>()

let invalidateAttached = false

function attachInvalidation() {
  if (invalidateAttached) return
  invalidateAttached = true
  subscribeLive('change', () => {
    answers.clear()
    capabilitiesPromise = null
  })
}

function loadCapabilities(): Promise<CodeIntelCapabilities> {
  capabilitiesPromise ??= fetch('/api/code-intel/capabilities')
    .then((res) => (res.ok ? (res.json() as Promise<CodeIntelCapabilities>) : null))
    .then((value) => value ?? { configured: false, extensions: [] })
    // A probe that cannot be answered means the feature is off, not broken.
    .catch(() => ({ configured: false, extensions: [] }))
  return capabilitiesPromise
}

function cacheKey(op: string, target: CodeIntelTarget, staged: boolean): string {
  return `${op}:${staged ? 's' : 'w'}:${target.side}:${target.path}:${target.line}:${target.character}`
}

function remember(key: string, value: CodeIntelResponse) {
  // A plain insertion-ordered map is enough: drop the oldest entry once full.
  if (answers.size >= CACHE_LIMIT) {
    const oldest = answers.keys().next()
    if (!oldest.done) answers.delete(oldest.value)
  }
  answers.set(key, value)
}

/**
 * The review's code-intel capabilities, for surfaces that need to explain the
 * feature rather than use it — the settings toggle says why it is unavailable
 * instead of silently doing nothing when it is switched on.
 *
 * The probe is one small request per session, shared by every caller.
 */
export function useCodeIntelCapabilities(): CodeIntelCapabilities | null {
  const [capabilities, setCapabilities] = useState<CodeIntelCapabilities | null>(null)
  useEffect(() => {
    attachInvalidation()
    let current = true
    loadCapabilities().then((value) => {
      if (current) setCapabilities(value)
    })
    return () => {
      current = false
    }
  }, [])
  return capabilities
}

interface UseCodeIntelOptions {
  /** The `codeIntel` setting. False keeps every listener off the renderer. */
  enabled: boolean
  /** The scope the client is displaying, which the UI can toggle at runtime. */
  staged: boolean
  /**
   * True while a file has unsaved edits. The language server reads the working
   * tree, so an answer about a dirty file would describe text the reviewer is
   * no longer looking at. Suppress rather than mislead.
   */
  isDirty?: (path: string) => boolean
}

/**
 * Hover and go-to-declaration over the review's language servers.
 *
 * Nothing is requested — and no capability is even probed — until the setting
 * is on, so a review without a configured language server behaves exactly as
 * it did before this hook existed.
 */
export function useCodeIntel({ enabled, staged, isDirty }: UseCodeIntelOptions) {
  const [capabilities, setCapabilities] = useState<CodeIntelCapabilities | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<AbortController | null>(null)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setCapabilities(null)
      return
    }
    attachInvalidation()
    let current = true
    loadCapabilities().then((value) => {
      if (current) setCapabilities(value)
    })
    return () => {
      current = false
    }
  }, [enabled])

  const ready = Boolean(
    enabled && capabilities?.configured && !capabilities.unavailable,
  )

  const ask = useCallback(
    async (
      op: 'hover' | 'definition' | 'references',
      target: CodeIntelTarget,
      signal?: AbortSignal,
    ): Promise<CodeIntelResponse> => {
      const key = cacheKey(op, target, staged)
      const cached = answers.get(key)
      if (cached) return cached
      const res = await fetch('/api/code-intel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          op,
          path: target.path,
          side: target.side,
          line: target.line,
          character: target.character,
          staged,
        }),
        signal,
      })
      if (!res.ok) {
        const failed: CodeIntelResponse = { available: false, reason: 'server-error' }
        return failed
      }
      const value = (await res.json()) as CodeIntelResponse
      remember(key, value)
      return value
    },
    [staged],
  )

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
    inFlight.current?.abort()
    inFlight.current = null
  }, [])

  /** Called from `onTokenLeave`; the popover can still catch the pointer. */
  const clearHover = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    inFlight.current?.abort()
    inFlight.current = null
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      if (live.current) setHover(null)
    }, HOVER_CLOSE_GRACE_MS)
  }, [])

  /** Called when the pointer reaches the popover, so it stays put. */
  const holdHover = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])

  /** Called when the popover itself is dismissed; closes with no grace. */
  const closeHover = useCallback(() => {
    cancel()
    setHover(null)
  }, [cancel])

  /** Called from `onTokenEnter`; debounced so a pointer sweep costs nothing. */
  const hoverToken = useCallback(
    (target: CodeIntelTarget) => {
      if (!ready) return
      if (isDirty?.(target.path)) return
      cancel()
      timer.current = setTimeout(() => {
        const controller = new AbortController()
        inFlight.current = controller
        setHover({ target, status: 'pending', markdown: null })
        ask('hover', target, controller.signal)
          .then((value) => {
            if (!live.current || controller.signal.aborted) return
            if (!value.available)
              return setHover({
                target,
                status: 'unavailable',
                markdown: null,
                reason: value.reason,
              })
            if (value.op !== 'hover') return
            setHover({
              target,
              status: value.hover ? 'ready' : 'empty',
              markdown: value.hover,
            })
          })
          .catch(() => {
            // An aborted request is the normal way a hover ends.
            if (live.current && !controller.signal.aborted) setHover(null)
          })
      }, HOVER_DEBOUNCE_MS)
    },
    [ask, cancel, isDirty, ready],
  )

  /** Called from `onTokenClick`; resolves immediately, no debounce. */
  const resolveDefinition = useCallback(
    async (target: CodeIntelTarget): Promise<CodeIntelLocation[] | null> => {
      if (!ready || isDirty?.(target.path)) return null
      const value = await ask('definition', target)
      if (!value.available || value.op !== 'definition') return null
      return value.locations
    },
    [ask, isDirty, ready],
  )

  useEffect(() => cancel, [cancel])

  return useMemo(
    () => ({
      ready,
      capabilities,
      hover,
      hoverToken,
      clearHover,
      holdHover,
      closeHover,
      resolveDefinition,
    }),
    [
      ready,
      capabilities,
      hover,
      hoverToken,
      clearHover,
      holdHover,
      closeHover,
      resolveDefinition,
    ],
  )
}
