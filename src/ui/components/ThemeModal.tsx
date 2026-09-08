import { useState, useMemo, useEffect, useRef } from 'react'
import { scrollBehavior } from "../lib/motion.js";
import { Search, X, Check, Moon, Sun } from 'lucide-react'
import { Modal } from '../primitives/Modal'
import { BrandMark } from './BrandMark'

export interface ThemeOption {
  id: string
  name: string
  type: 'dark' | 'light'
  colors: { bg: string; secondary: string; accent: string }
}

export const THEMES: ThemeOption[] = [
  // 1. Nord
  { id: 'nord', name: 'Nord', type: 'dark', colors: { bg: '#2e3440', secondary: '#242933', accent: '#88c0d0' } },
  
  // 2. GitHub themes
  { id: 'github-dark', name: 'GitHub Dark', type: 'dark', colors: { bg: '#0d1117', secondary: '#161b22', accent: '#58a6ff' } },
  { id: 'github-dark-dimmed', name: 'GitHub Dark Dimmed', type: 'dark', colors: { bg: '#22272e', secondary: '#1c2128', accent: '#539bf5' } },
  { id: 'github-dark-high-contrast', name: 'GitHub Dark HC', type: 'dark', colors: { bg: '#0a0c10', secondary: '#010409', accent: '#409eff' } },
  { id: 'github-light', name: 'GitHub Light', type: 'light', colors: { bg: '#ffffff', secondary: '#f6f8fa', accent: '#0969da' } },
  { id: 'github-light-high-contrast', name: 'GitHub Light HC', type: 'light', colors: { bg: '#ffffff', secondary: '#f6f8fa', accent: '#0969da' } },
  
  // 3. Dracula & One Dark
  { id: 'dracula', name: 'Dracula', type: 'dark', colors: { bg: '#282a36', secondary: '#1e1f29', accent: '#bd93f9' } },
  { id: 'one-dark', name: 'One Dark', type: 'dark', colors: { bg: '#282c34', secondary: '#21252b', accent: '#61afef' } },
  
  // 4. Synthwave & Tokyo Night
  { id: 'synthwave-84', name: 'Synthwave \'84', type: 'dark', colors: { bg: '#2b213a', secondary: '#241b2f', accent: '#f92aad' } },
  { id: 'tokyo-night', name: 'Tokyo Night', type: 'dark', colors: { bg: '#1a1b26', secondary: '#16161e', accent: '#7aa2f7' } },
  
  // 5. Catppuccin Family
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', type: 'dark', colors: { bg: '#1e1e2e', secondary: '#181825', accent: '#cba6f7' } },
  { id: 'catppuccin-frappe', name: 'Catppuccin Frappé', type: 'dark', colors: { bg: '#303446', secondary: '#292c3c', accent: '#ca9ee6' } },
  { id: 'catppuccin-macchiato', name: 'Catppuccin Macchiato', type: 'dark', colors: { bg: '#24273a', secondary: '#1e2030', accent: '#c6a0f6' } },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', type: 'light', colors: { bg: '#eff1f5', secondary: '#e6e9ef', accent: '#8839ef' } },
  
  // 6. Solarized & Monokai
  { id: 'solarized-dark', name: 'Solarized Dark', type: 'dark', colors: { bg: '#002b36', secondary: '#073642', accent: '#268bd2' } },
  { id: 'solarized-light', name: 'Solarized Light', type: 'light', colors: { bg: '#fdf6e3', secondary: '#eee8d5', accent: '#268bd2' } },
  { id: 'monokai', name: 'Monokai', type: 'dark', colors: { bg: '#272822', secondary: '#1d1e19', accent: '#f92672' } },
  
  // 7. Ayu Family
  { id: 'ayu-dark', name: 'Ayu Dark', type: 'dark', colors: { bg: '#0a0e14', secondary: '#0d1117', accent: '#e6b450' } },
  { id: 'ayu-light', name: 'Ayu Light', type: 'light', colors: { bg: '#fafafa', secondary: '#f3f3f3', accent: '#ff9900' } },
  
  // 8. Nordfox / Nightfox Family
  { id: 'nightfox', name: 'Nightfox', type: 'dark', colors: { bg: '#192330', secondary: '#131a24', accent: '#719cd6' } },
  { id: 'nordfox', name: 'Nordfox', type: 'dark', colors: { bg: '#2e3440', secondary: '#232831', accent: '#81a1c1' } },
  { id: 'duskfox', name: 'Duskfox', type: 'dark', colors: { bg: '#232136', secondary: '#1d1b2d', accent: '#86b3b3' } },
  { id: 'terafox', name: 'Terafox', type: 'dark', colors: { bg: '#152528', secondary: '#0f1c1e', accent: '#5a93aa' } },
  { id: 'carbonfox', name: 'Carbonfox', type: 'dark', colors: { bg: '#161616', secondary: '#111111', accent: '#78a9ff' } },
  { id: 'dayfox', name: 'Dayfox', type: 'light', colors: { bg: '#f6f2ee', secondary: '#ebe5df', accent: '#2848a9' } },
  { id: 'dawnfox', name: 'Dawnfox', type: 'light', colors: { bg: '#eae5e5', secondary: '#e0d8d8', accent: '#614d85' } },

  // 9. Other popular dark/light themes
  { id: 'andromeeda', name: 'Andromeeda', type: 'dark', colors: { bg: '#090b10', secondary: '#0e1117', accent: '#00e8c6' } },
  { id: 'aurora-x', name: 'Aurora X', type: 'dark', colors: { bg: '#07090f', secondary: '#0c0e15', accent: '#2eb5e5' } },
  { id: 'dark-plus', name: 'Dark+ (VS Code)', type: 'dark', colors: { bg: '#1e1e1e', secondary: '#252526', accent: '#0e639c' } },
  { id: 'light-plus', name: 'Light+ (VS Code)', type: 'light', colors: { bg: '#ffffff', secondary: '#f3f3f3', accent: '#007acc' } },
  { id: 'houston', name: 'Houston (Astro)', type: 'dark', colors: { bg: '#131415', secondary: '#17191e', accent: '#ff5d01' } },
  { id: 'laserwave', name: 'Laserwave', type: 'dark', colors: { bg: '#1b1d28', secondary: '#181a23', accent: '#ffe261' } },
  
  // 10. Material Family
  { id: 'material-theme', name: 'Material Theme', type: 'dark', colors: { bg: '#263238', secondary: '#1e272c', accent: '#80cbd8' } },
  { id: 'material-theme-darker', name: 'Material Darker', type: 'dark', colors: { bg: '#212121', secondary: '#1a1a1a', accent: '#80cbd8' } },
  { id: 'material-theme-lighter', name: 'Material Lighter', type: 'light', colors: { bg: '#fafafa', secondary: '#eeeded', accent: '#80cbd8' } },
  { id: 'material-theme-ocean', name: 'Material Ocean', type: 'dark', colors: { bg: '#0f111a', secondary: '#090b10', accent: '#80cbd8' } },
  { id: 'material-theme-palenight', name: 'Material Palenight', type: 'dark', colors: { bg: '#292d3e', secondary: '#202331', accent: '#80cbd8' } },
  
  // 11. Minimal & High Contrast
  { id: 'min-dark', name: 'Min Dark', type: 'dark', colors: { bg: '#1f1f1f', secondary: '#181818', accent: '#ffffff' } },
  { id: 'min-light', name: 'Min Light', type: 'light', colors: { bg: '#ffffff', secondary: '#f5f5f5', accent: '#111111' } },
  { id: 'night-owl', name: 'Night Owl', type: 'dark', colors: { bg: '#011627', secondary: '#0b2942', accent: '#7fdbca' } },
  { id: 'one-light', name: 'One Light', type: 'light', colors: { bg: '#fafafa', secondary: '#f0f0f0', accent: '#40a9ff' } },
  { id: 'plastic', name: 'Plastic', type: 'dark', colors: { bg: '#21252b', secondary: '#1b1d23', accent: '#61afef' } },
  { id: 'poimandres', name: 'Poimandres', type: 'dark', colors: { bg: '#1b1e28', secondary: '#171922', accent: '#50cad2' } },
  
  // 12. Rosé Pine Family
  { id: 'rose-pine', name: 'Rosé Pine (Main)', type: 'dark', colors: { bg: '#191724', secondary: '#1f1d2e', accent: '#c4a7e7' } },
  { id: 'rose-pine-moon', name: 'Rosé Pine Moon', type: 'dark', colors: { bg: '#232136', secondary: '#2a283e', accent: '#c4a7e7' } },
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', type: 'light', colors: { bg: '#faf4ed', secondary: '#f2e9e1', accent: '#907aa9' } },
  
  // 13. Slack Themes
  { id: 'slack-dark', name: 'Slack Dark', type: 'dark', colors: { bg: '#1a1d21', secondary: '#222529', accent: '#36c5f0' } },
  { id: 'slack-ochre', name: 'Slack Ochre', type: 'dark', colors: { bg: '#222222', secondary: '#2b2b2b', accent: '#e8912d' } },
  
  // 14. Other dark/light popular choices
  { id: 'vesper', name: 'Vesper', type: 'dark', colors: { bg: '#101010', secondary: '#161616', accent: '#ffc600' } },
  { id: 'vitesse-black', name: 'Vitesse Black', type: 'dark', colors: { bg: '#000000', secondary: '#0b0b0b', accent: '#4d9375' } },
  { id: 'vitesse-dark', name: 'Vitesse Dark', type: 'dark', colors: { bg: '#121212', secondary: '#181818', accent: '#4d9375' } },
  { id: 'vitesse-light', name: 'Vitesse Light', type: 'light', colors: { bg: '#ffffff', secondary: '#fafafa', accent: '#1b655f' } },
]

interface ThemeModalProps {
  open: boolean
  activeTheme: string
  onThemeChange: (themeId: string) => void
  onClose: () => void
}

export function ThemeModal({ open, activeTheme, onThemeChange, onClose }: ThemeModalProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'dark' | 'light'>('all')
  const [focusedIndex, setFocusedIndex] = useState(0)
  
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listContainerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Reset focus and search state on open
  useEffect(() => {
    if (open) {
      setSearch('')
      setFilter('all')
      setFocusedIndex(0)
      setTimeout(() => {
        searchInputRef.current?.focus()
      }, 50)
    }
  }, [open])

  // Filter themes based on search term and tab selection
  const filteredThemes = useMemo(() => {
    const query = search.toLowerCase().trim()
    return THEMES.filter((t) => {
      const matchesSearch = t.name.toLowerCase().includes(query) || t.id.toLowerCase().includes(query)
      const matchesCategory = filter === 'all' || t.type === filter
      return matchesSearch && matchesCategory
    })
  }, [search, filter])

  // Keep focusedIndex bounded
  useEffect(() => {
    if (focusedIndex >= filteredThemes.length) {
      setFocusedIndex(Math.max(0, filteredThemes.length - 1))
    }
  }, [filteredThemes, focusedIndex])

  // Scroll focused element into view
  useEffect(() => {
    if (open && itemRefs.current[focusedIndex]) {
      itemRefs.current[focusedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: scrollBehavior(),
      })
    }
  }, [focusedIndex, open])

  // Handle grid keyboard navigation (2 columns layout)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const cols = 2
    const total = filteredThemes.length

    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }

    if (total === 0) return

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        setFocusedIndex((prev) => Math.min(prev + 1, total - 1))
        break
      case 'ArrowLeft':
        e.preventDefault()
        setFocusedIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'ArrowDown':
        e.preventDefault()
        if (focusedIndex + cols < total) {
          setFocusedIndex(focusedIndex + cols)
        } else {
          // Wrap or move to last item
          setFocusedIndex(total - 1)
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (focusedIndex - cols >= 0) {
          setFocusedIndex(focusedIndex - cols)
        }
        break
      case 'Enter':
        e.preventDefault()
        if (filteredThemes[focusedIndex]) {
          onThemeChange(filteredThemes[focusedIndex].id)
          onClose()
        }
        break
      default:
        break
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="theme-modal"
      ariaLabel="Theme Selector Modal"
    >
      <div className="theme-modal-content" onKeyDown={handleKeyDown}>
        {/* Header */}
        <div className="theme-modal-header">
          <div className="theme-modal-title-row">
            <BrandMark size={24} className="theme-modal-mark" />
            <h2 className="theme-modal-title">Select Color Theme</h2>
            <button className="theme-modal-close-btn" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
          
          {/* Search bar */}
          <div className="theme-modal-search-wrapper">
            <Search className="theme-modal-search-icon" size={16} />
            <input
              ref={searchInputRef}
              type="text"
              className="theme-modal-search-input"
              placeholder="Search themes... (e.g. nordfox, github)"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setFocusedIndex(0)
              }}
            />
            {search && (
              <button 
                className="theme-modal-clear-btn" 
                onClick={() => {
                  setSearch('')
                  setFocusedIndex(0)
                  searchInputRef.current?.focus()
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Filters */}
          <div className="theme-modal-filters">
            <button
              className={`theme-filter-tab ${filter === 'all' ? 'active' : ''}`}
              onClick={() => {
                setFilter('all')
                setFocusedIndex(0)
                searchInputRef.current?.focus()
              }}
            >
              All Themes ({THEMES.length})
            </button>
            <button
              className={`theme-filter-tab ${filter === 'dark' ? 'active' : ''}`}
              onClick={() => {
                setFilter('dark')
                setFocusedIndex(0)
                searchInputRef.current?.focus()
              }}
            >
              <Moon size={12} style={{ marginRight: '6px' }} />
              Dark ({THEMES.filter(t => t.type === 'dark').length})
            </button>
            <button
              className={`theme-filter-tab ${filter === 'light' ? 'active' : ''}`}
              onClick={() => {
                setFilter('light')
                setFocusedIndex(0)
                searchInputRef.current?.focus()
              }}
            >
              <Sun size={12} style={{ marginRight: '6px' }} />
              Light ({THEMES.filter(t => t.type === 'light').length})
            </button>
          </div>
        </div>

        {/* List of themes */}
        <div ref={listContainerRef} className="theme-modal-list">
          {filteredThemes.length === 0 ? (
            <div className="theme-modal-empty">
              <p className="theme-modal-empty-text">No themes matching "{search}"</p>
              <button 
                className="btn btn-sm" 
                onClick={() => {
                  setSearch('')
                  setFilter('all')
                  setFocusedIndex(0)
                  searchInputRef.current?.focus()
                }}
              >
                Reset Search
              </button>
            </div>
          ) : (
            <div className="theme-modal-grid">
              {filteredThemes.map((t, idx) => {
                const isActive = activeTheme === t.id
                const isFocused = focusedIndex === idx
                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      itemRefs.current[idx] = el
                    }}
                    type="button"
                    className={`theme-modal-card ${isActive ? 'active' : ''} ${isFocused ? 'focused' : ''}`}
                    onClick={() => {
                      onThemeChange(t.id)
                      onClose()
                    }}
                    onMouseEnter={() => setFocusedIndex(idx)}
                  >
                    <div className="theme-card-info">
                      <span className="theme-card-name">{t.name}</span>
                      <span className="theme-card-meta">
                        {t.type === 'dark' ? (
                          <span className="theme-meta-tag dark-tag">Dark</span>
                        ) : (
                          <span className="theme-meta-tag light-tag">Light</span>
                        )}
                      </span>
                    </div>

                    <div className="theme-card-right">
                      {/* Color swatches */}
                      <span className="theme-swatches">
                        <span className="theme-swatch" style={{ background: t.colors.bg }} title="Background" />
                        <span className="theme-swatch" style={{ background: t.colors.secondary }} title="Secondary" />
                        <span className="theme-swatch" style={{ background: t.colors.accent }} title="Accent" />
                      </span>

                      {/* Active indicator */}
                      <span className="theme-card-status">
                        {isActive && <Check size={14} className="theme-check-icon" />}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer shortcuts */}
        <div className="theme-modal-footer">
          <span className="theme-footer-item">
            <kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> Navigate
          </span>
          <span className="theme-footer-item">
            <kbd>Enter</kbd> Select
          </span>
          <span className="theme-footer-item">
            <kbd>ESC</kbd> Close
          </span>
        </div>
      </div>
    </Modal>
  )
}
