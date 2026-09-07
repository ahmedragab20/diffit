---
name: diffing-mockup-author
description: Author product-grounded HTML mockup screens for diffing visual review. Use only when a mockup is requested or accepted, before submit_mockup, or when revising screen states and stable data-diffing regions from human feedback.
---

# Author a reviewable mockup

## Use this when

The human requested or accepted an HTML mockup. Do not generate one merely because a UI change is large. Authoring is separate from [submission and review](../diffing-mockup-review/SKILL.md); implementation waits for approval.

## Before you start

Select a local web session for the consumer. Keep all mockup HTML out of the consumer source tree: submit inline or on stdin. If staging is unavoidable, use `~/.diffing/…/mockup-sources/`.

Read the design system:

```js
get_design_system({})
```

```bash
diffing design show
```

Use published tokens, fonts, guidelines and component patterns. A returned system may be a draft: do not assume it is published. If absent, inspect real product styles/screens; optional `extract_design_system({})` / `diffing design extract` creates a draft, not a published system. Propose changes with `propose_design_system`; publish only on explicit human request.

## Recipe

### 1. Define the screen set

List stable screen IDs before writing markup. Each distinct state is a screen: `imports-empty`, `imports-loaded`, `imports-error`, `dialog-open`. Maximum **24 screens** per mockup.

Do not hide reviewable states behind JS tabs, accordions, dropdowns or toggles. Depict the open/closed/selected states in separate screens. A static rendering of controls is fine; state-swapping behavior is not needed. Viewport controls already cover desktop/tablet/mobile: add responsive screens only when composition/state genuinely differs.

### 2. Match the product

- Use realistic copy and data; no filler names or invented brand palette.
- Prefer existing CSS/tokens, not Tailwind/Google Fonts CDNs or generic Inter-and-indigo styling.
- Tag major regions with stable `data-diffing` values so comments can target future revisions.
- Prefer body fragments with `mode:'fragment'` when using the published host design shell. Use `mode:'document'` for a self-contained document; do not assume a missing/draft design system will provide styles.

Minimal screen shape, with styling to be drawn from the actual product:

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

Use `designSystem:'SYSTEM_ID'` only for the intended system; optional `planId` links the plan. `emptyHtml`/`loadedHtml` are the authored source, not filenames. Multi-screen submission creates one version, rather than one version per added screen.

Read returned `hints`: state hints flag hidden interactive states; style hints flag generic/external styling. Inspect each warning and correct applicable issues with a guarded screen revision. Hints are advisory, not a substitute for reviewing the markup.

## Recovery

Use [mockup review](../diffing-mockup-review/SKILL.md) for `inspect_mockup` and `revise_mockup` with `expectedVersion`. A successful revision already bumps the version; do not resubmit it again. `comment-only` permits discussion, not markup/product edits. The UI's Ask AI is human-triggered; do not start inference to complete this workflow.

## Done

The state set is reviewable, product-grounded and submitted with stable anchors. Share its returned URL and park for human approval; do not implement the product UI yet.

[Sessions and transports](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md) · [Recovery and safety](../diffing/references/recovery-and-safety.md)
