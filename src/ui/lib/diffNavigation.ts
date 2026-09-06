import type { AnnotationSide } from '@pierre/diffs'

interface FileTarget {
  reveal: () => void
  position: (line: number, side: AnnotationSide) => number | undefined
}
const targets = new Map<string, FileTarget>()
let cancelCurrent: (() => void) | undefined
let currentTarget: string | undefined

export function cancelDiffNavigation() {
  cancelCurrent?.()
}

export function registerDiffTarget(path: string, target: FileTarget) {
  targets.set(path, target)
  return () => {
    if (targets.get(path) !== target) return
    targets.delete(path)
    if (currentTarget === path) cancelDiffNavigation()
  }
}

/** One bounded job at a time. User input always wins over a delayed jump. */
export function scheduleDiffNavigation(step: () => boolean, frames = 40, targetPath?: string) {
  cancelDiffNavigation()
  let raf = 0
  let cancelled = false
  const cancel = () => {
    cancelled = true
    cancelAnimationFrame(raf)
    window.removeEventListener('wheel', cancel)
    window.removeEventListener('touchstart', cancel)
    window.removeEventListener('pointerdown', cancel)
    window.removeEventListener('keydown', cancel)
    if (cancelCurrent === cancel) {
      cancelCurrent = undefined
      currentTarget = undefined
    }
  }
  cancelCurrent = cancel
  currentTarget = targetPath
  window.addEventListener('wheel', cancel, { passive: true })
  window.addEventListener('touchstart', cancel, { passive: true })
  window.addEventListener('pointerdown', cancel, { passive: true })
  window.addEventListener('keydown', cancel)
  const tick = () => {
    if (cancelled) return
    if (step() || --frames <= 0) cancel()
    else raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return cancel
}

export function navigateToFile(path: string) {
  cancelDiffNavigation()
  document.getElementById(`file-${path}`)?.scrollIntoView({ block: 'start', behavior: 'auto' })
}

export function navigateToDiffLine(
  path: string,
  line: number,
  side: AnnotationSide,
  onArrive?: () => boolean,
) {
  cancelDiffNavigation()
  const card = document.getElementById(`file-${path}`)
  if (!card) return
  targets.get(path)?.reveal()
  // Mount an off-screen target once. Further attempts never return to its header.
  card.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  let positioned = false
  return scheduleDiffNavigation(
    () => {
      if (!card.isConnected) return true
      if (positioned) return onArrive?.() ?? true
      const position = targets.get(path)?.position(line, side)
      if (position == null) return false
      window.scrollTo({
        top: Math.max(0, position - Math.max(100, window.innerHeight / 3)),
        behavior: 'auto',
      })
      positioned = true
      return !onArrive
    },
    40,
    path,
  )
}
