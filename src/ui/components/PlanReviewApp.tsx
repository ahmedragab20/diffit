import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import { scrollBehavior } from "../lib/motion.js";
import { preloadHighlighter } from '@pierre/diffs'
import { useWorkerPool } from '@pierre/diffs/react'
import {
  ArrowLeft,
  Palette,
  ClipboardList,
  Settings,
  Code2,
  FileText,
  Columns2,
  Menu,
} from 'lucide-react'
import { useSettings, resolveMonoFont } from '../hooks/useSettings'
import { useApplyFonts } from '../hooks/useApplyFonts'
import { usePlans } from '../hooks/usePlans'
import { useRoutePath, navigate } from '../router'
import { SHIKI_THEME_MAP } from '../utils'
import { HapticsProvider } from '../hooks/useHaptics'
import { usePlanReviewKeymaps } from '../hooks/usePlanReviewKeymaps'
import { getUiStateItem, setUiStateItem } from '../utils/uiState'
import { PlanReview, type PlanViewMode } from './PlanReview'
import { PLAN_UI, readBoolUi, getEffectivePlanViewMode, readLastSingleViewMode, readDefaultCommentsRailOpen, type PlanSingleViewMode } from '../lib/planUiState'
import { usePlanNarrowSplit } from '../hooks/usePlanLayoutMedia'
import { PlanList } from './PlanList'
import { ThemeModal } from './ThemeModal'
import { AgentActivityToast } from './AgentActivityToast'
import { BrandMark } from './BrandMark'
import { Popover } from '../primitives/Popover'
import { Select } from '../primitives/Select'
import { Tooltip } from '../primitives/Tooltip'
import { SubmitPlanReviewPopover } from './SubmitPlanReviewPopover'
import { VimStatusBar } from './VimStatusBar'
import { ShortcutsHelpModal } from './ShortcutsHelpModal'
import { AiModelPicker } from '../ai/AiModelPicker'
import { AiAssistantRail } from '../ai/AiAssistantRail'
import { AiConnectionsPanel } from '../ai/AiConnectionsPanel'

const FONT_SIZE_OPTS = [12, 13, 14, 15, 16, 17, 18].map((n) => ({
  value: String(n),
  label: `${n}px`,
}))
const TAB_SIZE_OPTS = [2, 4, 8].map((n) => ({
  value: String(n),
  label: String(n),
}))
const HOVER_OPTS = [
  { value: 'both', label: 'Both' },
  { value: 'line', label: 'Line only' },
  { value: 'number', label: 'Number only' },
  { value: 'disabled', label: 'Disabled' },
]

/**
 * Top-level surface for the `/plan` route. The plan-review twin of {@link App}:
 * lists submitted plans, renders the active one for line/section commenting and
 * an approve/reject/request-changes verdict, and shares the theme + worker pool
 * machinery so highlighting matches the diff view.
 */
export function PlanReviewApp() {
  const poolManager = useWorkerPool()
  const { settings, loaded, updateSettings } = useSettings()
  useApplyFonts(loaded, settings.uiFont, settings.monoFont)
  const {
    plans,
    getPlan,
    removePlan,
    agentActivity,
    clearAgentActivity,
    submitDecision,
    submitting,
    agentWaiting,
    isLoading,
  } = usePlans()
  const path = useRoutePath()
  const [themeModalOpen, setThemeModalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false)
  const [aiRailOpen, setAiRailOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      // ⌘, / Ctrl+, — toggle Settings
      if (e.key === ',' || e.code === 'Comma') {
        e.preventDefault()
        setSettingsOpen((open) => !open)
        return
      }
      // ⌘? / Ctrl+? (and ⌘Shift+/ ) — open shortcuts guide
      if (e.key === '?' || (e.key === '/' && e.shiftKey) || (e.code === 'Slash' && e.shiftKey)) {
        e.preventDefault()
        setShortcutsHelpOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Persisted viewMode: source | rendered | split
  const [viewMode, setViewMode] = useState<PlanViewMode>(() => {
    try {
      const stored = getUiStateItem(PLAN_UI.viewMode)
      if (stored === 'rendered' || stored === 'split' || stored === 'source') return stored
    } catch {}
    return 'source'
  })

  const [lastSingleViewMode, setLastSingleViewMode] = useState<PlanSingleViewMode>(() =>
    readLastSingleViewMode('rendered'),
  )

  const handleViewModeChange = useCallback((mode: PlanViewMode) => {
    if (mode === 'source' || mode === 'rendered') {
      setLastSingleViewMode(mode)
      try {
        setUiStateItem(PLAN_UI.lastSingleViewMode, mode)
      } catch {}
    } else if (viewMode === 'source' || viewMode === 'rendered') {
      setLastSingleViewMode(viewMode)
      try {
        setUiStateItem(PLAN_UI.lastSingleViewMode, viewMode)
      } catch {}
    }
    setViewMode(mode)
    try {
      setUiStateItem(PLAN_UI.viewMode, mode)
    } catch {}
  }, [viewMode])

  const isNarrowSplit = usePlanNarrowSplit()
  const effectiveViewMode = useMemo(
    () => getEffectivePlanViewMode(viewMode, isNarrowSplit, lastSingleViewMode),
    [viewMode, isNarrowSplit, lastSingleViewMode],
  )

  // Immersive full-width Read (zen) — owned here so `z` can switch to Read + zen.
  const [zenMode, setZenModeState] = useState(() => readBoolUi(PLAN_UI.zenMode, false))
  const handleZenModeChange = useCallback((open: boolean) => {
    setZenModeState(open)
    try {
      setUiStateItem(PLAN_UI.zenMode, String(open))
    } catch {}
  }, [])

  const toggleZenMode = useCallback(() => {
    if (viewMode !== 'rendered') {
      handleViewModeChange('rendered')
      handleZenModeChange(true)
    } else {
      handleZenModeChange(!zenMode)
    }
  }, [viewMode, zenMode, handleViewModeChange, handleZenModeChange])

  // Outline + comments rail — same ui-state store as every other chrome pref.
  const [tocOpen, setTocOpen] = useState(() => {
    try {
      const v = getUiStateItem(PLAN_UI.tocOpen)
      if (v === 'false') return false
      if (v === 'true') return true
    } catch {}
    return true
  })
  const [commentsRailOpen, setCommentsRailOpen] = useState(() => {
    try {
      const v = getUiStateItem(PLAN_UI.commentsRail)
      if (v === 'false') return false
      if (v === 'true') return true
    } catch {}
    return readDefaultCommentsRailOpen()
  })
  const handleTocOpenChange = useCallback((open: boolean) => {
    setTocOpen(open)
    setUiStateItem(PLAN_UI.tocOpen, String(open))
  }, [])
  const handleCommentsRailOpenChange = useCallback((open: boolean) => {
    setCommentsRailOpen(open)
    setUiStateItem(PLAN_UI.commentsRail, String(open))
  }, [])

  const toggleOutline = useCallback(() => {
    handleTocOpenChange(!tocOpen)
  }, [tocOpen, handleTocOpenChange])

  const toggleCommentsRail = useCallback(() => {
    handleCommentsRailOpenChange(!commentsRailOpen)
  }, [commentsRailOpen, handleCommentsRailOpenChange])

  const routeId = useMemo(() => {
    const m = /^\/plan\/([^/]+)/.exec(path)
    return m ? decodeURIComponent(m[1]) : null
  }, [path])

  // Without an explicit id, default to the most recent plan still awaiting a
  // verdict, falling back to the newest plan overall.
  const activePlan = useMemo(() => {
    if (routeId) return getPlan(routeId)
    if (plans.length === 0) return null
    const pending = [...plans].reverse().find((p) => p.decision === 'pending')
    return pending ?? plans[plans.length - 1]
  }, [routeId, plans, getPlan])

  const shikiConfig = useMemo(() => {
    const activeTheme = settings.theme || 'rose-pine'
    return SHIKI_THEME_MAP[activeTheme] || SHIKI_THEME_MAP['rose-pine']
  }, [settings.theme])

  useEffect(() => {
    const activeTheme = settings.theme || 'rose-pine'
    const root = document.documentElement
    root.classList.add('theme-switching')
    root.setAttribute('data-theme', activeTheme)
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.remove('theme-switching'))
    })
    return () => cancelAnimationFrame(id)
  }, [settings.theme])

  useEffect(() => {
    if (!poolManager) return
    poolManager
      .setRenderOptions({
        theme: {
          dark: shikiConfig.type === 'dark' ? shikiConfig.themeName : 'rose-pine',
          light: shikiConfig.type === 'light' ? shikiConfig.themeName : 'github-light',
        },
      })
      .catch((err) => console.error('Failed to set worker pool render options:', err))
  }, [poolManager, shikiConfig])

  useEffect(() => {
    const dark = shikiConfig.type === 'dark' ? shikiConfig.themeName : 'rose-pine'
    const light = shikiConfig.type === 'light' ? shikiConfig.themeName : 'github-light'
    preloadHighlighter({
      themes: Array.from(new Set([dark, light])),
      langs: [],
    }).catch(() => {})
  }, [shikiConfig])

  // Collapsible plans sidebar states matching App.tsx
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      const stored = getUiStateItem('diffing-sidebar-collapsed')
      if (stored != null) return stored === 'true'
    } catch {}
    return typeof window !== 'undefined' && window.innerWidth <= 768
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = getUiStateItem('diffing-sidebar-width')
      return stored ? Number(stored) : 320
    } catch {
      return 320
    }
  })

  useEffect(() => {
    try {
      setUiStateItem('diffing-sidebar-collapsed', String(sidebarCollapsed))
    } catch {}
  }, [sidebarCollapsed])

  const sidebarWidthRef = useRef(sidebarWidth)
  sidebarWidthRef.current = sidebarWidth
  const appRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const sidebarGuideRef = useRef<HTMLDivElement>(null)

  const SIDEBAR_MIN_WIDTH = 240
  const SIDEBAR_MAX_WIDTH = 640

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current
    const sidebarEl = sidebarRef.current
    const guideEl = sidebarGuideRef.current
    const sidebarLeft = sidebarEl ? sidebarEl.getBoundingClientRect().left : 0
    let latestWidth = startWidth
    let rafId = 0

    const flush = () => {
      rafId = 0
      if (guideEl) guideEl.style.transform = `translateX(${sidebarLeft + latestWidth}px)`
    }

    if (guideEl) {
      guideEl.style.transform = `translateX(${sidebarLeft + startWidth}px)`
      guideEl.classList.add('sidebar-resize-guide-active')
    }

    const handleMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      latestWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + delta))
      if (!rafId) rafId = requestAnimationFrame(flush)
    }

    const handleUp = () => {
      if (rafId) cancelAnimationFrame(rafId)
      if (guideEl) guideEl.classList.remove('sidebar-resize-guide-active')
      setSidebarWidth(latestWidth)
      try {
        setUiStateItem('diffing-sidebar-width', String(latestWidth))
      } catch {}
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  // Measured toolbar height — plan chrome can wrap to two rows on narrow viewports.
  useEffect(() => {
    const app = appRef.current
    const toolbar = toolbarRef.current
    if (!app || !toolbar) return

    const setOffset = () => {
      const h = toolbar.getBoundingClientRect().height
      app.style.setProperty('--plan-toolbar-offset', `${h}px`)
    }

    setOffset()
    if (typeof ResizeObserver === 'undefined') return

    const ro = new ResizeObserver(setOffset)
    ro.observe(toolbar)
    return () => ro.disconnect()
  }, [loaded, isLoading])

  // Vim keyboard shortcuts
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => !c)
  }, [])

  const toggleLineWrap = useCallback(() => {
    updateSettings({ lineWrap: !settings.lineWrap })
  }, [settings.lineWrap, updateSettings])

  const toggleLineNumbers = useCallback(() => {
    updateSettings({ showLineNumbers: !settings.showLineNumbers })
  }, [settings.showLineNumbers, updateSettings])

  const toggleViewMode = useCallback(() => {
    // Cycle source → rendered → split → source
    const order: PlanViewMode[] = ['source', 'rendered', 'split']
    const next = order[(order.indexOf(viewMode) + 1) % order.length]
    handleViewModeChange(next)
  }, [viewMode, handleViewModeChange])

  const cycleTabSize = useCallback(() => {
    const sizes = [2, 4, 8]
    const current = settings.defaultTabSize || 4
    const nextIndex = (sizes.indexOf(current) + 1) % sizes.length
    updateSettings({ defaultTabSize: sizes[nextIndex] })
  }, [settings.defaultTabSize, updateSettings])

  const navigatePlan = useCallback(
    (direction: 'next' | 'prev') => {
      if (plans.length === 0) return
      const sorted = [...plans].sort((a, b) => b.createdAt - a.createdAt)
      let nextIndex = 0
      if (activePlan) {
        const currentIndex = sorted.findIndex((p) => p.id === activePlan.id)
        if (currentIndex !== -1) {
          if (direction === 'next') {
            nextIndex = Math.min(currentIndex + 1, sorted.length - 1)
          } else {
            nextIndex = Math.max(currentIndex - 1, 0)
          }
        }
      }
      const nextPlan = sorted[nextIndex]
      navigate(`/plan/${nextPlan.id}`)
    },
    [plans, activePlan],
  )

  const handlePlanSelect = useCallback(
    (id: string) => {
      navigate(`/plan/${id}`)
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches) {
        setSidebarCollapsed(true)
      }
    },
    [],
  )

  const planKeymapActions = useMemo(
    () => ({
      onNavigatePlan: navigatePlan,
      onToggleViewMode: toggleViewMode,
      onToggleZenMode: toggleZenMode,
      onToggleCommentsRail: toggleCommentsRail,
      onToggleOutline: toggleOutline,
      onCycleTabSize: cycleTabSize,
      onToggleSidebar: toggleSidebar,
      onToggleLineWrap: toggleLineWrap,
      onToggleLineNumbers: toggleLineNumbers,
      onOpenTheme: () => setThemeModalOpen(true),
      onOpenShortcuts: () => setShortcutsHelpOpen(true),
    }),
    [
      navigatePlan,
      toggleViewMode,
      toggleZenMode,
      toggleCommentsRail,
      toggleOutline,
      cycleTabSize,
      toggleSidebar,
      toggleLineWrap,
      toggleLineNumbers,
    ],
  )
  usePlanReviewKeymaps(planKeymapActions)

  const openCommentCount = useMemo(() => {
    if (!activePlan) return 0
    return (activePlan.comments ?? []).filter((c) => c.status === 'open').length
  }, [activePlan])

  if (isLoading || !loaded) {
    return (
      <div
        className="app plan-app skeleton-app"
        style={
          {
            '--sidebar-width': `${sidebarWidth}px`,
          } as React.CSSProperties
        }
      >
        <header className="skeleton-toolbar">
          <div className="skeleton-item skeleton-logo"></div>
          <div className="skeleton-item skeleton-stats"></div>
          <div className="skeleton-item skeleton-actions"></div>
        </header>

        <div className="app-body">
          <aside
            className={`sidebar plan-sidebar skeleton-sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
          >
            {!sidebarCollapsed && (
              <>
                <div className="skeleton-search"></div>
                <div className="skeleton-tree-nodes">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="skeleton-tree-node">
                      <div className="skeleton-node-icon"></div>
                      <div className="skeleton-node-text"></div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>
          {!sidebarCollapsed && <div className="sidebar-resize-handle skeleton-resize-handle" />}

          <main className="main plan-main skeleton-main">
            <div className="file-diff-card skeleton-card">
              <div className="skeleton-card-header">
                <div className="skeleton-card-title"></div>
                <div className="skeleton-card-badge"></div>
              </div>
              <div className="skeleton-card-body">
                <div className="skeleton-code-line"></div>
                <div className="skeleton-code-line"></div>
                <div className="skeleton-code-line"></div>
                <div className="skeleton-code-line"></div>
                <div className="skeleton-code-line"></div>
                <div className="skeleton-code-line"></div>
              </div>
            </div>
          </main>
        </div>
      </div>
    )
  }

  return (
    <HapticsProvider enabled={settings.haptics ?? true} soundsEnabled={settings.sounds ?? true}>
      <div
        className={`app plan-app ${aiRailOpen ? 'app-ai-open' : ''}`}
        ref={appRef}
        style={
          {
            '--sidebar-width': `${sidebarWidth}px`,
          } as React.CSSProperties
        }
      >
        <div className="sidebar-resize-guide" ref={sidebarGuideRef} aria-hidden="true" />

        <div className="toolbar plan-app-toolbar" ref={toolbarRef}>
          <div className="toolbar-left">
            <button
              className="toolbar-mobile-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              aria-label="Toggle sidebar"
              title={sidebarCollapsed ? 'Open sidebar' : 'Close sidebar'}
            >
              <Menu size={18} />
            </button>
            <Tooltip content="Back to diff review" side="bottom">
              <button
                className="btn btn-sm plan-toolbar-back"
                onClick={() => navigate('/')}
                aria-label="Back to the diff review"
              >
                <ArrowLeft size={14} />
                <span className="btn-label">Diff</span>
              </button>
            </Tooltip>
            <div className="plan-toolbar-brand">
              <BrandMark size={18} className="plan-app-brand" />
              <div className="plan-toolbar-brand-text">
                <h1 className="toolbar-title plan-app-title">Plans</h1>
                {activePlan ? (
                  <span className="plan-toolbar-active" title={activePlan.title}>
                    {activePlan.title}
                  </span>
                ) : (
                  <span className="plan-toolbar-count">
                    {plans.length} plan{plans.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="plan-view-toggle" role="group" aria-label="Plan view mode">
            {(
              [
                {
                  id: 'source' as const,
                  label: 'Source',
                  icon: Code2,
                  tip: 'Source — select lines to comment',
                },
                {
                  id: 'rendered' as const,
                  label: 'Read',
                  icon: FileText,
                  tip: 'Read — rendered markdown (highlight to comment)',
                },
                {
                  id: 'split' as const,
                  label: 'Split',
                  icon: Columns2,
                  tip: 'Split — source + rendered (drag the divider to resize)',
                },
              ] as const
            ).map(({ id, label, icon: Icon, tip }) => {
              const isActive = effectiveViewMode === id
              const splitNarrowHint =
                id === 'split' && isNarrowSplit && viewMode === 'split'
                  ? ' — opens when the window is wider'
                  : ''
              return (
              <Tooltip key={id} content={`${tip} · m to cycle${splitNarrowHint}`} side="bottom">
                <button
                  type="button"
                  className={`plan-view-toggle-btn ${isActive ? 'is-active' : ''}`}
                  aria-pressed={isActive}
                  aria-label={tip}
                  onClick={() => handleViewModeChange(id)}
                >
                  <Icon size={13} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              </Tooltip>
              )
            })}
          </div>

          <div className="toolbar-right">
            <AiModelPicker onOpenAssistant={() => setAiRailOpen(true)} />
            <Popover
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              ariaLabel="Settings"
              className="settings-popover"
              trigger={
                <button
                  className={`btn btn-sm settings-btn ${settingsOpen ? 'btn-active' : ''}`}
                  title="Settings (⌘,)"
                  aria-label="Settings"
                >
                  <Settings size={14} />
                  <span className="btn-label">Settings</span>
                </button>
              }
            >
              <div className="popover-scroll settings-panel">
                <AiConnectionsPanel />
                <div className="settings-section-label">Appearance</div>
                <div className="settings-item settings-item-spaced">
                  <span>Theme</span>
                  <button
                    className="btn btn-sm settings-btn"
                    onClick={() => {
                      setSettingsOpen(false)
                      setThemeModalOpen(true)
                    }}
                  >
                    <Palette size={14} className="settings-item-icon" />
                    <span>Switch Theme...</span>
                  </button>
                </div>

                <div className="settings-section-label">Plan chrome</div>
                <label className="settings-item">
                  <input
                    type="checkbox"
                    checked={tocOpen}
                    onChange={(e) => handleTocOpenChange(e.target.checked)}
                  />
                  Show outline
                </label>
                <label className="settings-item">
                  <input
                    type="checkbox"
                    checked={commentsRailOpen}
                    onChange={(e) => handleCommentsRailOpenChange(e.target.checked)}
                  />
                  Show comments panel
                </label>

                <div className="settings-section-label">Display</div>
                <label className="settings-item">
                  <input
                    type="checkbox"
                    checked={settings.lineWrap}
                    onChange={(e) => updateSettings({ lineWrap: e.target.checked })}
                  />
                  Wrap long lines
                </label>
                <label className="settings-item">
                  <input
                    type="checkbox"
                    checked={settings.showLineNumbers}
                    onChange={(e) => updateSettings({ showLineNumbers: e.target.checked })}
                  />
                  Show line numbers
                </label>
                <label className="settings-item">
                  <input
                    type="checkbox"
                    checked={settings.showStatusBar ?? true}
                    onChange={(e) => updateSettings({ showStatusBar: e.target.checked })}
                  />
                  Show status bar
                </label>
                <div className="settings-item settings-item-spaced">
                  <span>Hover highlight</span>
                  <Select
                    value={settings.lineHoverHighlight}
                    onValueChange={(v) => updateSettings({ lineHoverHighlight: v as any })}
                    options={HOVER_OPTS}
                    ariaLabel="Hover highlight"
                  />
                </div>
                <div className="settings-item settings-item-spaced">
                  <span>Font size</span>
                  <Select
                    value={String(settings.fontSize)}
                    onValueChange={(v) => updateSettings({ fontSize: Number(v) })}
                    options={FONT_SIZE_OPTS}
                    ariaLabel="Font size"
                  />
                </div>
                <div className="settings-item settings-item-spaced">
                  <span>Default tab size</span>
                  <Select
                    value={String(settings.defaultTabSize)}
                    onValueChange={(v) => updateSettings({ defaultTabSize: Number(v) })}
                    options={TAB_SIZE_OPTS}
                    ariaLabel="Default tab size"
                  />
                </div>
              </div>
            </Popover>

            {activePlan && (
              <SubmitPlanReviewPopover
                openCommentCount={openCommentCount}
                onSubmit={(verdict, comment) => submitDecision(activePlan.id, verdict, comment)}
                submitting={submitting}
                agentWaiting={agentWaiting}
                currentDecision={activePlan.decision}
              />
            )}
          </div>
        </div>

        {!sidebarCollapsed && (
          <div
            className="sidebar-mobile-backdrop"
            onClick={() => setSidebarCollapsed(true)}
            aria-hidden="true"
          />
        )}

        <div className="app-body">
          <aside
            ref={sidebarRef}
            className={`sidebar plan-sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
          >
            <div className="plan-sidebar-content">
              <PlanList
                plans={plans}
                activeId={activePlan?.id ?? null}
                onSelect={handlePlanSelect}
                onDelete={(id) => {
                  removePlan(id)
                  if (activePlan?.id === id) navigate('/plan')
                }}
                collapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
              />
            </div>
          </aside>
          {!sidebarCollapsed && (
            <div
              className="sidebar-resize-handle"
              onMouseDown={handleSidebarResizeStart}
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              tabIndex={0}
            />
          )}

          <main className="main plan-main">
            {activePlan ? (
              <PlanReview
                key={activePlan.id}
                plan={activePlan}
                theme={settings.theme || 'rose-pine'}
                fontSize={settings.fontSize}
                monoFontFamily={resolveMonoFont(settings.monoFont)}
                defaultTabSize={settings.defaultTabSize}
                lineWrap={settings.lineWrap}
                showLineNumbers={settings.showLineNumbers}
                lineHoverHighlight={settings.lineHoverHighlight}
                viewMode={effectiveViewMode}
                onViewModeChange={handleViewModeChange}
                editorIDE={settings.editorIDE}
                tocOpen={tocOpen}
                onTocOpenChange={handleTocOpenChange}
                commentsRailOpen={commentsRailOpen}
                onCommentsRailOpenChange={handleCommentsRailOpenChange}
                zenMode={zenMode}
                onZenModeChange={handleZenModeChange}
              />
            ) : (
              <PlanEmptyState hasPlans={plans.length > 0} notFound={!!routeId} />
            )}
          </main>
        </div>

        {activePlan && (
          <AiAssistantRail
            open={aiRailOpen}
            onClose={() => setAiRailOpen(false)}
            surface="plan"
            title="Ask about this plan"
            context={{
              kind: 'plan',
              planId: activePlan.id,
              title: activePlan.title,
              version: activePlan.version,
              body: activePlan.body,
            }}
          />
        )}

        <ThemeModal
          open={themeModalOpen}
          activeTheme={settings.theme || 'rose-pine'}
          onThemeChange={(theme) => updateSettings({ theme })}
          onClose={() => setThemeModalOpen(false)}
        />
        <AgentActivityToast
          activity={
            agentActivity
              ? {
                  at: agentActivity.at,
                  commentId: agentActivity.commentId,
                  filePath: `plan · ${agentActivity.planId.slice(0, 8)}`,
                  model: agentActivity.model,
                  body: agentActivity.body,
                }
              : null
          }
          onDismiss={clearAgentActivity}
          onJump={() => {
            if (!agentActivity) return
            navigate(`/plan/${agentActivity.planId}`)
            // After navigation, scroll to the thread on next frame.
            requestAnimationFrame(() => {
              document
                .getElementById(`plan-comment-${agentActivity.commentId}`)
                ?.scrollIntoView({ behavior: scrollBehavior(), block: 'center' })
            })
          }}
        />
        <VimStatusBar
          activeFile={activePlan ? activePlan.title : null}
          onShowHelp={() => setShortcutsHelpOpen(true)}
          placeholder="No active plan (J/K to jump)"
          visible={settings.showStatusBar ?? true}
        />
        <ShortcutsHelpModal
          isOpen={shortcutsHelpOpen}
          onClose={() => setShortcutsHelpOpen(false)}
          mode="plan"
        />
      </div>
    </HapticsProvider>
  )
}

function PlanEmptyState({ hasPlans, notFound }: { hasPlans: boolean; notFound: boolean }) {
  return (
    <div className="plan-empty-state">
      <div className="plan-empty-icon" aria-hidden="true">
        <ClipboardList size={28} />
      </div>
      {notFound ? (
        <>
          <h2 className="plan-empty-title">Plan not found</h2>
          <p className="plan-empty-body">
            It may have been deleted. Pick another from the list, or submit a new one.
          </p>
        </>
      ) : hasPlans ? (
        <>
          <h2 className="plan-empty-title">Select a plan</h2>
          <p className="plan-empty-body">Choose one from the sidebar to start reviewing.</p>
        </>
      ) : (
        <>
          <h2 className="plan-empty-title">No plans yet</h2>
          <p className="plan-empty-body">
            Agents submit a plan, you review it here, then they continue on approval.
          </p>
          <div className="plan-empty-steps">
            <code>diffing plan submit PLAN.md</code>
            <code>diffing plan await</code>
          </div>
        </>
      )}
    </div>
  )
}
