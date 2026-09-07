import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const gridline = readFileSync(resolve(root, 'src/ui/styles/gridline.css'), 'utf8')
const globalCss = readFileSync(resolve(root, 'src/ui/styles/global.css'), 'utf8')
const main = readFileSync(resolve(root, 'src/ui/main.tsx'), 'utf8')
const mergeConflictResolver = readFileSync(
  resolve(root, 'src/ui/components/MergeConflictResolver.tsx'),
  'utf8',
)
const searchPalette = readFileSync(resolve(root, 'src/ui/components/SearchPalette.tsx'), 'utf8')
const commentBubble = readFileSync(resolve(root, 'src/ui/components/CommentBubble.tsx'), 'utf8')
const planCommentBubble = readFileSync(
  resolve(root, 'src/ui/components/PlanCommentBubble.tsx'),
  'utf8',
)
const commentForm = readFileSync(resolve(root, 'src/ui/components/CommentForm.tsx'), 'utf8')
const commentTracker = readFileSync(resolve(root, 'src/ui/components/CommentTracker.tsx'), 'utf8')
const existingPrCommentBubble = readFileSync(
  resolve(root, 'src/ui/components/ExistingPrCommentBubble.tsx'),
  'utf8',
)
const fileDiffCard = readFileSync(resolve(root, 'src/ui/components/FileDiffCard.tsx'), 'utf8')
const planReview = readFileSync(resolve(root, 'src/ui/components/PlanReview.tsx'), 'utf8')
const embeddedCommentStyles = readFileSync(
  resolve(root, 'src/ui/lib/embeddedCommentStyles.ts'),
  'utf8',
)

const GRIDLINE_ROLES = [
  'canvas',
  'surface',
  'raised',
  'element',
  'selected',
  'hover',
  'active',
  'selected-hover',
  'text',
  'text-subtle',
  'muted',
  'code',
  'gutter',
  'rule-subtle',
  'rule',
  'focus',
  'accent',
  'info',
  'positive',
  'warning',
  'negative',
  'added-surface',
  'removed-surface',
] as const

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ]
}

function luminance(hex: string): number {
  const channels = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(left: string, right: string): number {
  const a = luminance(left)
  const b = luminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function mixHex(foreground: string, background: string, foregroundWeight: number): string {
  const front = hexToRgb(foreground)
  const back = hexToRgb(background)
  return `#${front
    .map((channel, index) =>
      Math.round(channel * foregroundWeight + back[index] * (1 - foregroundWeight)),
    )
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`
}

function declarations(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[\da-fA-F]{6})\s*;/g)].map((match) => [match[1], match[2]]),
  )
}

describe('Gridline Web design-system contract', () => {
  it('loads after the historical stylesheet so it remains canonical', () => {
    expect(main.indexOf("import './styles/global.css'")).toBeLessThan(
      main.indexOf("import './styles/gridline.css'"),
    )
  })

  it('maps every TUI Gridline semantic color role', () => {
    for (const role of GRIDLINE_ROLES) {
      expect(gridline, `missing --gl-${role}`).toContain(`--gl-${role}:`)
    }
  })

  it('keeps decorative effects out of persistent Gridline surfaces', () => {
    expect(gridline).not.toMatch(/linear-gradient|radial-gradient|saturate\(/)
    expect(gridline).not.toMatch(/border-left:\s*[3-9]px/)
    expect(gridline).not.toMatch(/border-right:\s*[3-9]px/)
    expect(gridline).not.toMatch(/background:\s*var\(--gl-accent\)/)
  })

  it('keeps hover, selection, and focus as separate interaction states', () => {
    expect(gridline).toMatch(/\.btn:hover:not\(:disabled\)[\s\S]*?background:\s*var\(--gl-hover\)/)
    expect(gridline).toMatch(
      /\.btn-primary:hover:not\(:disabled\)[\s\S]*?background:\s*var\(--gl-selected-hover\)/,
    )
    expect(gridline).toContain('.plan-verdict-option:hover:not(.plan-verdict-option-selected)')
    expect(gridline).toContain('.plan-verdict-option-selected')
    expect(gridline).toMatch(
      /\.plan-verdict-option-selected\s*\{[\s\S]*?border-color:\s*var\(--gl-focus\)/,
    )
  })

  it('caps comment cards against the viewport in both diff and plan surfaces', () => {
    expect(gridline).toContain('calc(100vw - 64px)')
    expect(gridline).toContain('.plan-read-comment-slot .comment-bubble-canvas')
    expect(gridline).toContain('.comment-canvas-footer-row .comment-reply-trigger')
  })

  it('keeps the PR toolbar and loading shell on final-layout geometry', () => {
    expect(gridline).toMatch(/\[data-density=['"]compact['"]\] \.toolbar/)
    expect(gridline).toContain('.pr-review-toolbar .toolbar-brand-text')
    expect(gridline).toContain('.skeleton-toolbar')
    expect(gridline).toContain('height: var(--gl-bar-height)')
  })

  it('normalizes every persistent diff, comment, plan, and PR card family', () => {
    const cardFamilies = [
      '.file-diff-card',
      '.comment-bubble-canvas',
      '.suggestion-card',
      '.image-preview-panel',
      '.hunk-preview-container',
      '.hunk-history-commit-card',
      '.plan-list-item',
      '.plan-general-section',
      '.plan-verdict-option',
      '.pr-existing-strip',
      '.pr-existing-bubble',
      '.pr-existing-suggestion',
      '.pr-review-activity',
      '.pr-conversation-timeline',
      '.pr-checks-panel',
      '.merge-conflict-card',
    ]

    for (const family of cardFamilies) {
      expect(gridline, `missing ${family} design-system coverage`).toContain(family)
    }
  })

  it('uses vivid semantic surfaces for every compact diff preview', () => {
    expect(gridline).toMatch(
      /\.pr-existing-suggestion-line\.is-removed,[\s\S]*?background:\s*var\(--gl-removed-surface\)/,
    )
    expect(gridline).toMatch(
      /\.pr-existing-suggestion-line\.is-added,[\s\S]*?background:\s*var\(--gl-added-surface\)/,
    )
    expect(gridline).toContain('.hunk-preview-line-deletion')
    expect(gridline).toContain('.hunk-preview-line-addition')
  })

  it('supports the actual focused and active selectors used by picker cards', () => {
    expect(gridline).toContain('.theme-modal-card.focused')
    expect(gridline).toContain('.theme-modal-card.active')
    expect(gridline).toContain('.font-picker-item.focused')
    expect(gridline).toContain('.font-picker-item.active')
  })

  it('keeps modal decisions above popovers with stable semantic action states', () => {
    expect(gridline).toContain('--gl-layer-modal-backdrop: 1800')
    expect(gridline).toContain('--gl-layer-modal: 1801')
    expect(globalCss).toContain('z-index: var(--gl-layer-modal-backdrop, 1800)')
    expect(globalCss).toContain('z-index: var(--gl-layer-modal, 1801)')
    expect(gridline).toMatch(
      /\.confirm-dialog-confirm-danger:hover:not\(:disabled\)[\s\S]*?background:\s*color-mix\(/,
    )
    expect(gridline).toMatch(
      /\.confirm-dialog-confirm-warning:hover:not\(:disabled\)[\s\S]*?background:\s*color-mix\(/,
    )
    expect(gridline).toMatch(
      /\.confirm-dialog-confirm-primary:hover:not\(:disabled\)[\s\S]*?background:\s*var\(--gl-selected-hover\)/,
    )
  })

  it('uses one centered search-style motion contract for every modal', () => {
    expect(globalCss).toMatch(
      /\.ui-modal-popup\[data-starting-style\],[\s\S]*?translate\(-50%, calc\(-50% \+ var\(--gl-dialog-motion-y, -10px\)\)\)[\s\S]*?scale\(var\(--gl-dialog-motion-scale, 0\.98\)\)/,
    )
    expect(globalCss).toMatch(
      /\.ui-modal-popup\.ui-modal--palette\[data-starting-style\],[\s\S]*?translate\(-50%, var\(--gl-dialog-motion-y, -10px\)\)[\s\S]*?scale\(var\(--gl-dialog-motion-scale, 0\.98\)\)/,
    )

    const neutralTransformRule = gridline.match(
      /\.ui-popover\[data-starting-style\],[\s\S]*?\{\s*transform:\s*none;\s*\}/,
    )?.[0]
    expect(neutralTransformRule).toBeTruthy()
    expect(neutralTransformRule).not.toContain('.ui-modal-popup')
  })

  it('keeps static comment-card visuals in the design layer', () => {
    for (const source of [commentBubble, planCommentBubble, commentForm]) {
      expect(source).not.toContain('style={{')
    }
    expect(gridline).toContain('.comment-node-meta')
    expect(gridline).toContain('.comment-delete-confirm-yes')
    expect(gridline).toContain('.comment-reply-editor')
    expect(gridline).toContain('.comment-preview-panel')
  })

  it('contains long comment content on every review surface', () => {
    for (const family of [
      '.comment-node-body',
      '.cmt-body',
      '.cmt-reply-body',
      '.pr-existing-bubble-body',
      '.pr-existing-reply p',
      '.plan-comment-source',
    ]) {
      expect(gridline, `missing wrapping coverage for ${family}`).toContain(family)
    }

    expect(gridline).toMatch(
      /\.comment-content-col\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?inline-size:\s*0;/,
    )
    expect(gridline).toMatch(
      /\.comment-node-body\s*\{[\s\S]*?inline-size:\s*100%;[\s\S]*?white-space:\s*normal;/,
    )
    expect(gridline).toMatch(
      /\.comment-node-body :where\(pre\)\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?white-space:\s*pre;/,
    )
    expect(gridline).toMatch(
      /\.plan-comment-source\s*\{[\s\S]*?max-inline-size:\s*100%;[\s\S]*?white-space:\s*pre-wrap;/,
    )
    expect(gridline).toContain('.comment-form-textarea')
    expect(globalCss).toMatch(
      /\.comment-collapsed-preview\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/,
    )

    for (const source of [fileDiffCard, planReview]) {
      expect(source).toContain('import { EMBEDDED_COMMENT_STYLES }')
      expect(source).toContain('${EMBEDDED_COMMENT_STYLES}')
    }
    expect(embeddedCommentStyles).toContain('flex: 1 1 0 !important')
    expect(embeddedCommentStyles).toContain('width: 0 !important')
    expect(embeddedCommentStyles).toContain('white-space: normal !important')
    expect(embeddedCommentStyles).toContain('overflow-x: auto !important')
    expect(embeddedCommentStyles).toContain('white-space: pre-wrap !important')

    expect(commentTracker).toContain('className="cmt-body markdown-body"')
    expect(commentTracker).toContain('className="cmt-reply-body markdown-body"')
    expect(existingPrCommentBubble).toContain('className="pr-existing-bubble-body markdown-body"')
  })

  it('passes Gridline roles through every embedded diff surface', () => {
    for (const source of [mergeConflictResolver, searchPalette]) {
      expect(source).toContain('--diffs-border: var(--gl-rule)')
      expect(source).toContain('--diffs-bg: var(--gl-canvas)')
      expect(source).toContain('color: var(--gl-gutter)')
    }
  })

  it('keeps addition and deletion semantics visible on selected diff lines', () => {
    for (const source of [fileDiffCard, planReview]) {
      expect(source).toContain(
        '[data-line].selected-line:not([data-line-type="addition"]):not([data-line-type="deletion"])',
      )
    }
  })

  it('keeps primary text AA-readable and focus indicators visible in every theme', () => {
    const rootBlock = globalCss.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(rootBlock).toBeTruthy()

    const themes: Array<[string, Record<string, string>]> = [
      ['default', declarations(rootBlock!)],
      ...[...globalCss.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]+)\}/g)]
        .map((match): [string, Record<string, string>] => [match[1], declarations(match[2])])
        .filter(([, values]) => values['bg-primary'] !== undefined),
    ]

    expect(themes).toHaveLength(53)
    for (const [name, values] of themes) {
      expect(
        contrast(values['text-primary'], values['bg-primary']),
        `${name} primary text contrast`,
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrast(values['border-focus'], values['bg-primary']),
        `${name} focus contrast`,
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps subtle and muted Gridline text readable across persistent theme surfaces', () => {
    const rootBlock = globalCss.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1]
    expect(rootBlock).toBeTruthy()

    const themes: Array<[string, Record<string, string>]> = [
      ['default', declarations(rootBlock!)],
      ...[...globalCss.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]+)\}/g)]
        .map((match): [string, Record<string, string>] => [match[1], declarations(match[2])])
        .filter(([, values]) => values['bg-primary'] !== undefined),
    ]

    for (const [name, values] of themes) {
      const subtle = mixHex(values['text-secondary'], values['text-primary'], 0.12)
      const muted = mixHex(values['text-secondary'], values['text-primary'], 0.18)
      const surfaces = {
        canvas: values['bg-primary'],
        surface: values['bg-secondary'],
        raised: mixHex(values['text-primary'], values['bg-secondary'], 0.02),
        element: mixHex(values['text-primary'], values['bg-secondary'], 0.03),
      }

      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        expect(
          contrast(subtle, surface),
          `${name} subtle text on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrast(muted, surface),
          `${name} muted text on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
