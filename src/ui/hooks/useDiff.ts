import { useState, useEffect, useRef } from 'react'
import { subscribeLive } from '../live'
import type { DiffOverview } from '../../lib/diff-overview'

export interface BinaryFileInfo {
  path: string
  type: 'added' | 'deleted' | 'changed' | 'untracked'
}

export interface CommitInfo {
  sha: string
  shortSha: string
  parents: string[]
  subject: string
  body: string
  authorName: string
  authorEmail: string
  authorDate: string
  committerName: string
  committerEmail: string
  committerDate: string
  patch: string
}

interface DiffData {
  patch: string
  repoName: string
  branch: string
  customMode: boolean
  showMode?: boolean
  commits?: CommitInfo[]
  truncated?: number
  binaryFiles: BinaryFileInfo[]
  tabSizeMap: Record<string, number>
  untrackedFiles: string[]
  /** False when optional untracked reads were omitted rather than represented. */
  complete?: boolean
  omittedPaths?: string[]
  /**
   * "What is this diff?" overview. The diff-engine builds one whenever it
   * has enough metadata (working tree / staged / range / show / PR). The
   * field is optional so old server payloads remain backward-compatible.
   */
  overview?: DiffOverview
}

export interface DiffOptions {
  staged: boolean
  untracked: boolean
}

const EMPTY_ARRAY: any[] = []
const EMPTY_OBJECT: Record<string, number> = {}
const EMPTY_COMMITS: CommitInfo[] = []

export function useDiff(options: DiffOptions, enabled = true) {
  const [data, setData] = useState<DiffData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshCount, setRefreshCount] = useState(0)
  const hasData = useRef(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    // Only the very first load shows the full skeleton. Background refreshes
    // (triggered by `change` events while you keep working) update the diff in
    // place so the whole view never blanks out mid-review.
    if (hasData.current) setRefreshing(true)
    else setLoading(true)
    setError(null)

    fetch(`/api/diff?staged=${options.staged}&untracked=${options.untracked}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json) => {
        if (cancelled) return
        hasData.current = true
        setData(json)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setRefreshing(false)
      })

    return () => {
      cancelled = true
    }
  }, [options.staged, options.untracked, enabled, refreshCount])

  useEffect(() => {
    if (!enabled) return
    // Coalesce bursty change events. Tools like an IDE's git integration touch
    // several `.git` files in quick succession; debouncing avoids a refetch
    // stampede from a single logical change.
    // Also listen to `pr-session`: PR refresh rewrites the cached patch without
    // touching the working tree, so `change` alone would leave a stale diff.
    let timer: ReturnType<typeof setTimeout> | null = null
    const bump = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setRefreshCount((c) => c + 1), 150)
    }
    const unsubChange = subscribeLive('change', bump)
    const unsubPr = subscribeLive('pr-session', bump)
    return () => {
      if (timer) clearTimeout(timer)
      unsubChange()
      unsubPr()
    }
  }, [enabled])

  return {
    patch: data?.patch ?? null,
    repoName: data?.repoName ?? '',
    branch: data?.branch ?? '',
    customMode: data?.customMode ?? false,
    showMode: data?.showMode ?? false,
    commits: data?.commits ?? EMPTY_COMMITS,
    truncated: data?.truncated ?? 0,
    binaryFiles: data?.binaryFiles ?? EMPTY_ARRAY,
    tabSizeMap: data?.tabSizeMap ?? EMPTY_OBJECT,
    untrackedFiles: data?.untrackedFiles ?? EMPTY_ARRAY,
    complete: data?.complete !== false,
    omittedPaths: data?.omittedPaths ?? EMPTY_ARRAY,
    // Atomic with the rest of the diff payload — no second fetch, no second
    // source of truth. The banner refreshes whenever the diff does.
    overview: data?.overview,
    loading,
    refreshing,
    error,
  }
}
