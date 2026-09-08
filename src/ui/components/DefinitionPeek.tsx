import { useEffect, useRef, useState } from 'react'
import { FileText, Loader2, X, GitCompare } from 'lucide-react'
import { File as DiffsFile } from '@pierre/diffs/react'
import { useFilePreview } from '../hooks/useFilePreview'
import { highlightLineInElement, SHIKI_THEME_MAP } from '../utils'
import { navigateToDiffLine } from '../lib/diffNavigation'
import {
  closeDefinitionPeek,
  subscribeDefinitionPeek,
  type DefinitionPeekRequest,
} from '../lib/definitionPeek'

interface DefinitionPeekProps {
  /** Paths present in the current diff; a definition in one can be jumped to. */
  diffFileSet: Set<string>
  theme: string
  fontSize: number
  monoFontFamily: string
  defaultTabSize: number
  lineWrap: boolean
  showLineNumbers: boolean
}

/**
 * Shows the file a definition landed in, without leaving the review.
 *
 * Mounted once by the app and driven by `definitionPeek`, so a click anywhere
 * in a virtualized diff card can open it. When the target file is part of the
 * current diff the panel offers to jump there instead — reading a definition
 * in its own diff context beats reading it in a detached pane.
 */
export function DefinitionPeek({
  diffFileSet,
  theme,
  fontSize,
  monoFontFamily,
  defaultTabSize,
  lineWrap,
  showLineNumbers,
}: DefinitionPeekProps) {
  const [request, setRequest] = useState<DefinitionPeekRequest | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const shikiConfig = SHIKI_THEME_MAP[theme] || SHIKI_THEME_MAP['rose-pine']
  const { data, isLoading, error } = useFilePreview(request?.path ?? null)

  useEffect(() => subscribeDefinitionPeek(setRequest), [])

  useEffect(() => {
    if (!request) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDefinitionPeek()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request])

  // Scroll to and flash the definition once the file has rendered.
  useEffect(() => {
    if (!data?.content || !request || !containerRef.current) return
    highlightLineInElement(containerRef.current, request.line)
    // Bringing a long line into view drags the horizontal axis with it, which
    // hides the start of every line — the part you actually came to read. Only
    // the vertical move was wanted, so undo the rest once it has settled.
    const timer = setTimeout(() => {
      const root = containerRef.current
      if (!root) return
      const reset = (node: Element | ShadowRoot) => {
        for (const child of node.querySelectorAll('*')) {
          if (child.scrollLeft > 0) child.scrollLeft = 0
          if (child.shadowRoot) reset(child.shadowRoot)
        }
      }
      root.scrollLeft = 0
      reset(root)
    }, 120)
    return () => clearTimeout(timer)
  }, [data?.content, request])

  if (!request) return null

  const inDiff = diffFileSet.has(request.path)

  return (
    <div className="definition-peek" role="dialog" aria-label={`Definition of ${request.symbol}`}>
      <div className="definition-peek-head">
        <FileText size={12} />
        <span className="definition-peek-path">
          {request.path}:{request.line}
        </span>
        {inDiff && (
          <button
            className="definition-peek-jump"
            onClick={() => {
              closeDefinitionPeek()
              navigateToDiffLine(request.path, request.line, 'additions')
            }}
            title="Open this file and line in the diff viewer"
          >
            <GitCompare size={11} />
            View in diff
          </button>
        )}
        <button
          className="searchpalette-clear"
          onClick={closeDefinitionPeek}
          aria-label="Close definition"
        >
          <X size={14} />
        </button>
      </div>
      <div className="definition-peek-body" ref={containerRef}>
        {isLoading ? (
          <div className="searchpalette-state">
            <Loader2 size={15} className="spin" /> Loading {request.path}…
          </div>
        ) : error ? (
          <div className="searchpalette-state searchpalette-state--error">
            {(error as Error).message}
          </div>
        ) : data?.binary ? (
          <div className="searchpalette-state">Binary file — no preview</div>
        ) : data?.missing ? (
          <div className="searchpalette-state">File not present in the working tree</div>
        ) : data ? (
          <DiffsFile
            file={{ name: request.path, contents: data.content ?? '' }}
            options={{
              disableFileHeader: true,
              overflow: lineWrap ? 'wrap' : 'scroll',
              disableLineNumbers: !showLineNumbers,
              theme: {
                dark: shikiConfig.type === 'dark' ? shikiConfig.themeName : 'rose-pine',
                light: shikiConfig.type === 'light' ? shikiConfig.themeName : 'github-light',
              },
              themeType: shikiConfig.type,
              unsafeCSS: `
                :host {
                  --diffs-tab-size: ${defaultTabSize} !important;
                  --diffs-font-family: ${monoFontFamily} !important;
                  --diffs-font-size: ${fontSize}px !important;
                  --diffs-border: var(--gl-rule) !important;
                  --diffs-bg: var(--gl-canvas) !important;
                  --diffs-line-height: ${Math.round(fontSize * 1.7)}px !important;
                }
                [data-column-number], [data-line], [data-line] * {
                  font-family: ${monoFontFamily} !important;
                  font-size: ${fontSize}px !important;
                }
                [data-column-number] {
                  color: var(--gl-gutter) !important;
                  opacity: 1 !important;
                }
              `,
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
