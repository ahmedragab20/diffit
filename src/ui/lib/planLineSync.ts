import { scrollBehavior } from "./motion.js";
/**
 * Helpers for facing the Read pane to the active Source line while editing
 * a plan in Split mode.
 *
 * Important: never scroll the window/document for this — Source and Read share
 * page layout, so window scroll yanks the caret. Only scroll a dedicated Read
 * overflow container (the split pane).
 */

export interface PlanSourceRange {
  /** Inclusive 1-based start line. */
  startLine: number
  /** Inclusive 1-based end line. */
  endLine: number
}

/**
 * 1-based line number of the caret in a text buffer given a selection offset.
 * Empty string / offset 0 → line 1.
 */
export function lineNumberFromOffset(text: string, offset: number): number {
  if (!text || offset <= 0) return 1
  const clamped = Math.min(offset, text.length)
  let line = 1
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++
  }
  return line
}

/**
 * Pick the source range that owns `line` (inclusive). Prefers the first
 * range whose [start, end] contains the line; falls back to nearest range
 * by start line, then null.
 */
export function findRangeForLine(
  ranges: PlanSourceRange[],
  line: number,
): PlanSourceRange | null {
  if (!ranges.length || line < 1) return null
  for (const r of ranges) {
    if (line >= r.startLine && line <= r.endLine) return r
  }
  // Nearest by start line (before or after).
  let best: PlanSourceRange | null = null
  let bestDist = Infinity
  for (const r of ranges) {
    const dist =
      line < r.startLine
        ? r.startLine - line
        : line > r.endLine
          ? line - r.endLine
          : 0
    if (dist < bestDist) {
      bestDist = dist
      best = r
    }
  }
  return best
}

/**
 * Fractional progress of `line` within a range, clamped to [0, 1].
 * Single-line ranges return 0 (align to top of segment).
 */
export function lineProgressInRange(range: PlanSourceRange, line: number): number {
  const span = range.endLine - range.startLine
  if (span <= 0) return 0
  const t = (line - range.startLine) / span
  return Math.max(0, Math.min(1, t))
}

/**
 * Nearest ancestor that can scroll independently (overflow auto/scroll and
 * actually overflows). Skips the document/body so callers never treat the
 * window as a pane scroller.
 */
export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  if (!el || typeof window === 'undefined') return null
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node)
    const oy = style.overflowY
    const canScroll = oy === 'auto' || oy === 'scroll' || oy === 'overlay'
    if (canScroll && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
    // Prefer explicit pane markers even if not overflowing yet (content short).
    if (
      canScroll &&
      (node.classList.contains('plan-rendered-layout') ||
        node.classList.contains('plan-file') ||
        node.hasAttribute('data-plan-scroll-pane'))
    ) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * Target scrollTop for a container so that `progress` through `el` lands near
 * `anchorY` px from the container's visible top. Pure geometry helper.
 */
export function scrollTopToFaceInContainer(
  container: HTMLElement,
  el: HTMLElement,
  progress: number,
  anchorY: number,
): number {
  const cRect = container.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  const p = Math.max(0, Math.min(1, progress))
  const pointInContent =
    eRect.top - cRect.top + container.scrollTop + eRect.height * p
  return Math.max(0, pointInContent - anchorY)
}

/** True when the face point is already comfortably inside the container viewport. */
export function isFacePointInView(
  container: HTMLElement,
  el: HTMLElement,
  progress: number,
  margin = 48,
): boolean {
  const cRect = container.getBoundingClientRect()
  const eRect = el.getBoundingClientRect()
  const p = Math.max(0, Math.min(1, progress))
  const y = eRect.top + eRect.height * p
  return y >= cRect.top + margin && y <= cRect.bottom - margin
}

/**
 * Query Read segments that carry source-line range attrs and return ranges
 * sorted by startLine. Used for DOM-driven face-sync.
 */
export function readSegmentRangesFromRoot(root: ParentNode | null): Array<
  PlanSourceRange & { element: HTMLElement }
> {
  if (!root) return []
  const nodes = root.querySelectorAll<HTMLElement>('[data-plan-source-start]')
  const out: Array<PlanSourceRange & { element: HTMLElement }> = []
  for (const el of nodes) {
    const start = Number(el.getAttribute('data-plan-source-start'))
    const end = Number(el.getAttribute('data-plan-source-end') ?? start)
    if (!Number.isFinite(start) || start < 1) continue
    out.push({
      startLine: start,
      endLine: Number.isFinite(end) && end >= start ? end : start,
      element: el,
    })
  }
  out.sort((a, b) => a.startLine - b.startLine)
  return out
}

export interface FaceReadOptions {
  /**
   * Explicit Read scroll pane. When omitted, the nearest scroll parent of the
   * matched segment is used. Never falls back to window/document.
   */
  scrollContainer?: HTMLElement | null
  /** Distance from container top to place the face point (default ~25% of height). */
  anchorY?: number
  /** Skip scrolling when the point is already in view (default true). */
  onlyIfOutOfView?: boolean
  behavior?: ScrollBehavior
}

/**
 * Scroll **only** the Read overflow pane so the segment for `line` faces the
 * caret region. Returns false when nothing was scrolled (no match, no pane,
 * or already in view). Never touches window.scrollTo / Source.
 */
export function faceReadToSourceLine(
  root: ParentNode | null,
  line: number,
  options: FaceReadOptions = {},
): boolean {
  const {
    scrollContainer = null,
    onlyIfOutOfView = true,
    behavior = 'auto',
  } = options

  const ranges = readSegmentRangesFromRoot(root)
  if (!ranges.length) return false
  const pure = ranges.map(({ startLine, endLine }) => ({ startLine, endLine }))
  const hit = findRangeForLine(pure, line)
  if (!hit) return false
  const entry = ranges.find(
    (r) => r.startLine === hit.startLine && r.endLine === hit.endLine,
  )
  if (!entry) return false

  const container =
    scrollContainer ??
    findScrollParent(entry.element) ??
    // Prefer the layout wrapper if it is the overflow pane but not yet overflowing.
    (entry.element.closest('.plan-rendered-layout') as HTMLElement | null)

  if (!container) return false
  // Hard guard: never scroll the document as a substitute for a pane.
  if (container === document.documentElement || container === document.body) {
    return false
  }

  const progress = lineProgressInRange(hit, line)
  if (onlyIfOutOfView && isFacePointInView(container, entry.element, progress)) {
    return false
  }

  const anchorY =
    options.anchorY ?? Math.max(32, Math.round(container.clientHeight * 0.22))
  const top = scrollTopToFaceInContainer(container, entry.element, progress, anchorY)
  const max = Math.max(0, container.scrollHeight - container.clientHeight)
  const next = Math.max(0, Math.min(max, top))
  if (Math.abs(container.scrollTop - next) < 1) return false

  if (behavior === 'smooth' && typeof container.scrollTo === 'function') {
    container.scrollTo({ top: next, behavior: scrollBehavior() })
  } else {
    container.scrollTop = next
  }
  return true
}
