---
name: diffing-mockup-author
description: Write product-grounded HTML mockup screens for diffing visual review - real product styles, one screen per state, stable data-diffing anchors. Use when a mockup has been requested or accepted, before submitting it, or when revising screens from human feedback.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.1"
user_invocable: true
---

# Author a reviewable mockup

## Use this when

The human asked for an HTML mockup or accepted the offer of one. A large UI change on its own is not the trigger. Authoring is separate from [submission and review](../diffing-mockup-review/SKILL.md), and implementation waits for approval.

## Before you start

```js
review_session_status({})  // consumer's local web session
get_design_system({})      // published tokens, fonts, guidelines, components
```

```bash
diffing design show
```

Build on the published system. A returned system can still be a draft — check before relying on it. With none available, read the real product styles and screens. `extract_design_system({})` / `diffing design extract` creates a draft, `propose_design_system` proposes changes, and `publish_design_system` runs only on explicit human request.

Keep mockup HTML out of the consumer source tree: submit inline or on stdin, and stage under `~/.diffing/…/mockup-sources/` only when unavoidable.

## Recipe

### 1. Define the screen set

List stable screen IDs before writing markup. Each distinct state is its own screen: `imports-empty`, `imports-loaded`, `imports-error`, `dialog-open`. Cap: **24 screens** per mockup.

Reviewable states belong in separate screens, not behind JS tabs, accordions, dropdowns or toggles — depict open, closed and selected as their own screens. Rendering the controls statically is enough; state-swapping behavior is not needed. Viewport controls already cover desktop, tablet and mobile, so add a responsive screen only when the composition or state genuinely differs.

### 2. Match the product

- Realistic copy and data, drawn from the product rather than filler names or an invented palette.
- Existing CSS and tokens, over Tailwind/Google Fonts CDNs or generic Inter-and-indigo styling.
- Stable `data-diffing` values on major regions, so comments can target them across revisions.
- `mode:'fragment'` when the published host design shell will wrap the body fragment; `mode:'document'` for a self-contained document that carries its own styles.

Minimal screen shape, styled from the actual product:

```html
<section data-diffing="imports-empty">
  <h2>No imports yet</h2>
  <p>Choose a file to preview its rows before importing.</p>
  <button type="button">Choose file</button>
</section>
```

### 3. Submit all states together

```js
submit_mockup({
  title: 'Import states', mode: 'fragment',
  screens: [
    { id: 'imports-empty', label: 'Empty', html: emptyHtml },
    { id: 'imports-loaded', label: 'Loaded', html: loadedHtml },
  ],
})
```

`emptyHtml` and `loadedHtml` are the authored source strings, not filenames. Set `designSystem:'SYSTEM_ID'` for a specific system, and optional `planId` to link the plan. One multi-screen submission creates one version.

Read the returned `hints`: state hints flag hidden interactive states, style hints flag generic or external styling. Inspect each one and fix what applies with a guarded screen revision. Hints are advisory — they do not replace reading your own markup.

## Recovery

[Mockup review](../diffing-mockup-review/SKILL.md) covers `inspect_mockup` and `revise_mockup` with `expectedVersion`. A successful revision already bumps the version, so it needs no resubmission. `comment-only` allows discussion, with markup and product left alone. The UI's Ask AI is human-triggered.

## Done

The state set is reviewable, product-grounded and submitted with stable anchors. Share its returned URL and park for human approval; the product UI waits for the verdict.

[Router](../diffing/SKILL.md) · [Mockup review](../diffing-mockup-review/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md) · [Recovery](../diffing/references/recovery-and-safety.md)
