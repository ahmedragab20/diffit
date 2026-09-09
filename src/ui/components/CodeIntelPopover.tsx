import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Markdown } from './Markdown'
import type { HoverState } from '../hooks/useCodeIntel'

/**
 * A language server can take a long time to come up. Say so rather than
 * showing an empty box, but only once the wait is long enough to notice —
 * a warm server answers well inside this.
 */
const SLOW_MS = 400

const GAP_PX = 6
const EDGE_PX = 8

interface CodeIntelPopoverProps {
  hover: HoverState
  /** The pointer reached the popover; the pending close is cancelled. */
  onHold: () => void
  /** The pointer left the popover, or the anchor went away. */
  onClose: () => void
}

/** True once `delayMs` has passed since the value last changed. */
function useDelayed(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) {
      setElapsed(false)
      return
    }
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])
  return elapsed
}

/**
 * Hover contents anchored to a token in the diff.
 *
 * The diff renderer virtualizes, so the anchor can be unmounted underneath us
 * at any scroll position. Every reposition re-checks that the anchor is still
 * in the document and closes rather than leaving a popover pointing at
 * nothing. Contents come from a language server reading repository files, so
 * they render through the same sanitized `Markdown` component as every other
 * untrusted body in the app.
 */
export function CodeIntelPopover({ hover, onHold, onClose }: CodeIntelPopoverProps) {
  const popup = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const slow = useDelayed(hover.status === 'pending', SLOW_MS)
  const { anchor } = hover.target

  useLayoutEffect(() => {
    const place = () => {
      const element = popup.current
      if (!element) return
      if (!anchor.isConnected) return onClose()
      const rect = anchor.getBoundingClientRect()
      const { offsetHeight: height, offsetWidth: width } = element
      // Prefer below the token, flip above only when below would be clipped.
      const below = rect.bottom + GAP_PX
      const above = rect.top - height - GAP_PX
      const top =
        below + height > window.innerHeight - EDGE_PX && above >= EDGE_PX
          ? above
          : below
      const left = Math.min(
        Math.max(rect.left, EDGE_PX),
        Math.max(EDGE_PX, window.innerWidth - width - EDGE_PX),
      )
      setPosition({ top, left })
    }
    place()
    // Capture-phase: the diff scrolls inside nested containers, not the window.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchor, hover.status, hover.markdown, onClose])

  if (hover.status === 'unavailable') return null
  if (hover.status === 'pending' && !slow) return null
  if (hover.status === 'empty') return null

  return createPortal(
    <div
      ref={popup}
      className="code-intel-popover"
      role="tooltip"
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      onMouseEnter={onHold}
      onMouseLeave={onClose}
    >
      {hover.status === 'pending' ? (
        <span className="code-intel-popover-status">Starting language server…</span>
      ) : (
        <>
          {hover.markdown ? (
            <Markdown content={hover.markdown} className="code-intel-popover-body" />
          ) : null}
          {hover.signatures && hover.signatures.length > 0 ? (
            <div className="code-intel-signatures">
              {hover.signatures.map((signature, index) => (
                <div key={`${signature.label}:${index}`} className="code-intel-signature">
                  <code>{signature.label}</code>
                  {signature.documentation ? (
                    <Markdown
                      content={signature.documentation}
                      className="code-intel-popover-body"
                    />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {hover.highlights && hover.highlights.length > 1 ? (
            <div className="code-intel-highlight-count">
              {hover.highlights.length} occurrences in this file
            </div>
          ) : null}
        </>
      )}
    </div>,
    document.body,
  )
}
