import { useState, useEffect, useRef, useMemo } from 'react'
import { scrollBehavior } from "../lib/motion.js";
import { Search, X, Check, Type } from 'lucide-react'
import { Modal } from '../primitives/Modal'

// Popular coding/monospace fonts shown when Local Font Access API is unavailable
const CURATED_FONTS = [
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'Courier New',
  'Dank Mono',
  'Fantasque Sans Mono',
  'Fira Code',
  'Fira Mono',
  'Geist Mono',
  'Hack',
  'IBM Plex Mono',
  'Inconsolata',
  'Input Mono',
  'JetBrains Mono',
  'Maple Mono',
  'Menlo',
  'Monaco',
  'Monoid',
  'Monaspace Argon',
  'Monaspace Krypton',
  'Monaspace Neon',
  'Monaspace Radon',
  'Monaspace Xenon',
  'Noto Sans Mono',
  'Operator Mono',
  'Roboto Mono',
  'SF Mono',
  'Source Code Pro',
  'Space Mono',
  'Ubuntu Mono',
  'Victor Mono',
]

async function loadSystemFonts(): Promise<string[]> {
  if ('queryLocalFonts' in window) {
    try {
      const fonts = await (window as any).queryLocalFonts()
      const families = [...new Set(fonts.map((f: any) => f.family as string))]
      return (families as string[]).sort((a, b) => a.localeCompare(b))
    } catch {
      // Permission denied or not supported — fall through to curated list
    }
  }
  return CURATED_FONTS
}

interface FontPickerModalProps {
  open: boolean
  title: string
  defaultLabel: string
  activeFont: string | null | undefined
  onFontChange: (font: string | null) => void
  onClose: () => void
}

export function FontPickerModal({
  open,
  title,
  defaultLabel,
  activeFont,
  onFontChange,
  onClose,
}: FontPickerModalProps) {
  const [search, setSearch] = useState('')
  const [fonts, setFonts] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!open) return
    setSearch('')
    setFocusedIndex(0)
    setTimeout(() => searchInputRef.current?.focus(), 50)
    if (fonts.length > 0) return
    setLoading(true)
    loadSystemFonts().then((result) => {
      setFonts(result)
      setLoading(false)
    })
  }, [open])

  // Items: "Default" entry first, then filtered fonts
  const filteredFonts = useMemo(() => {
    const q = search.toLowerCase().trim()
    return q ? fonts.filter((f) => f.toLowerCase().includes(q)) : fonts
  }, [fonts, search])

  // Total items = "Default" + filtered fonts
  const totalItems = filteredFonts.length + 1

  useEffect(() => {
    if (focusedIndex >= totalItems) setFocusedIndex(Math.max(0, totalItems - 1))
  }, [totalItems, focusedIndex])

  useEffect(() => {
    if (!open) return
    const el = focusedIndex === 0 ? itemRefs.current[0] : itemRefs.current[focusedIndex]
    el?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() })
  }, [focusedIndex, open])

  const handleSelect = (font: string | null) => {
    onFontChange(font)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (totalItems === 0) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setFocusedIndex((p) => Math.min(p + 1, totalItems - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setFocusedIndex((p) => Math.max(p - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        if (focusedIndex === 0) handleSelect(null)
        else if (filteredFonts[focusedIndex - 1]) handleSelect(filteredFonts[focusedIndex - 1])
        break
    }
  }

  const isDefault = !activeFont

  return (
    <Modal open={open} onClose={onClose} className="theme-modal" ariaLabel={`${title} Modal`}>
      <div className="theme-modal-content" onKeyDown={handleKeyDown}>
        {/* Header */}
        <div className="theme-modal-header">
          <div className="theme-modal-title-row">
            <h2 className="theme-modal-title">{title}</h2>
            <button className="theme-modal-close-btn" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <div className="theme-modal-search-wrapper">
            <Search className="theme-modal-search-icon" size={16} />
            <input
              ref={searchInputRef}
              type="text"
              className="theme-modal-search-input"
              placeholder="Search fonts..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setFocusedIndex(0) }}
            />
            {search && (
              <button
                className="theme-modal-clear-btn"
                onClick={() => { setSearch(''); setFocusedIndex(0); searchInputRef.current?.focus() }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* List */}
        <div ref={listRef} className="theme-modal-list">
          {loading ? (
            <div className="theme-modal-empty">
              <p className="theme-modal-empty-text">Loading fonts…</p>
            </div>
          ) : (
            <div className="font-picker-list">
              {/* Default option */}
              <button
                key="__default__"
                ref={(el) => { itemRefs.current[0] = el }}
                type="button"
                className={`font-picker-item ${isDefault ? 'active' : ''} ${focusedIndex === 0 ? 'focused' : ''}`}
                onClick={() => handleSelect(null)}
                onMouseEnter={() => setFocusedIndex(0)}
              >
                <span className="font-picker-name font-picker-default-name">
                  <Type size={13} style={{ marginRight: '6px', opacity: 0.6 }} />
                  {defaultLabel}
                </span>
                <span className="font-picker-status">
                  {isDefault && <Check size={14} className="theme-check-icon" />}
                </span>
              </button>

              {filteredFonts.length === 0 && search ? (
                <div className="theme-modal-empty" style={{ paddingTop: '16px' }}>
                  <p className="theme-modal-empty-text">No fonts matching "{search}"</p>
                  <button className="btn btn-sm" onClick={() => { setSearch(''); setFocusedIndex(0); searchInputRef.current?.focus() }}>
                    Reset Search
                  </button>
                </div>
              ) : (
                filteredFonts.map((font, idx) => {
                  const isActive = activeFont === font
                  const isFocused = focusedIndex === idx + 1
                  return (
                    <button
                      key={font}
                      ref={(el) => { itemRefs.current[idx + 1] = el }}
                      type="button"
                      className={`font-picker-item ${isActive ? 'active' : ''} ${isFocused ? 'focused' : ''}`}
                      onClick={() => handleSelect(font)}
                      onMouseEnter={() => setFocusedIndex(idx + 1)}
                    >
                      <span className="font-picker-name" style={{ fontFamily: `"${font}", ui-monospace, monospace` }}>
                        {font}
                      </span>
                      <span className="font-picker-status">
                        {isActive && <Check size={14} className="theme-check-icon" />}
                      </span>
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="theme-modal-footer">
          <span className="theme-footer-item"><kbd>↑</kbd> <kbd>↓</kbd> Navigate</span>
          <span className="theme-footer-item"><kbd>Enter</kbd> Select</span>
          <span className="theme-footer-item"><kbd>ESC</kbd> Close</span>
        </div>
      </div>
    </Modal>
  )
}
