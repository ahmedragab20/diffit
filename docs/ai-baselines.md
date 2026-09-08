# AI baselines

These are offline, synthetic baselines—not live-model validation.

## Commands

- `pnpm bench:ai` runs the context benchmark.
- `pnpm eval:ai` replays the citation/evaluation corpus.
- Add `--silent` for machine-readable output: `pnpm --silent bench:ai` or `pnpm --silent eval:ai`.
- Test: `pnpm exec vitest run src/lib/ai/evaluation/__tests__/baseline.test.ts`.

All commands generate synthetic data, read no checkout evidence or credentials, and perform no provider or network inference. Exit status 0 means the runner completed; it is not an acceptance or quality gate.

## Context benchmark

`src/lib/ai/evaluation/context-baseline.ts` reports version `context-baseline-v1` for `small-complete-diff` and `focused-large-diff`. The legacy `buildAiPrompt` is compared as a serialized prompt (including instruction overhead) with JSON containing the full patch and relevant full attachment. Reports include input/prompt hashes and bytes, a bytes/4 token estimate (not actual usage), required-text preservation, truncation, first-call and warm p50/p95 time, sampled process RSS (not precise peak or isolated memory), and zero remote fetches.

First-call timing excludes module imports and fixture generation. Warm timing does not imply a production cache. Browser measurements, provider time, `cacheBytes`, and human-approved thresholds remain null/false—not zero or passed. Do not treat latency as a fixed threshold; it is noisy.

Observed byte baseline:

- Small: 4,976 full versus 6,627 prompt; required evidence preserved.
- Large: 1,986,404 full versus 101,214 prompt (94.9% reduction), but unchanged-conversion is **MISSING**. These savings are not an acceptable optimization.

## Retrieval benchmark

`src/lib/ai/evaluation/retrieval-baseline.ts` reports version `retrieval-baseline-v1` over the same two fixtures, so the two implementations are comparable rather than separately reported. Instead of serializing the whole context, it maps the capture, locates each required text, and reads only those lines — the path the typed evidence tools make possible.

Observed against the legacy prompt on identical fixtures:

- Small: 1,764 bytes retrieved versus 6,627 prompt; required evidence preserved.
- Large: 1,794 bytes retrieved versus 101,214 prompt; **required evidence preserved**, including the `unchanged-conversion` line the legacy prompt drops.

The large-fixture result is the one that matters: the legacy path buys its reduction by discarding required evidence, and retrieval does not. `returnedLines` counts lines a read actually returned — it is evidence coverage, never a claim about model attention. Byte counts are measurements on synthetic fixtures, not approved thresholds; `humanApprovedThresholds` stays false. Browser latency (keydown to second animation frame) and JS heap are sampled by `pnpm test:ai:e2e`; those numbers are observations, not approved ceilings.

## Replay evaluation

`replay.ts` and `corpus.ts` define `synthetic-review-v1` with eight hand-authored cases: clean, cross-file, large, incomplete, stale, adversarial, conflicting-pr, and flawed-plan. Citations are deliberately invalid or omitted/stale in applicable fixtures.

Checks cover source hash/revision/line/exact quote, duplicate IDs and normalized claims, and unique cited-source counts. Exact anchors do not prove findings are correct. Citation coverage is not actual-read coverage. The adversarial fixture is not evidence of model injection resistance. Actual-read coverage and human precision/recall/usefulness remain null/not adjudicated. No model, prompt, usage, or live compatibility is measured.

Fixture changes require version/hash review; never quietly revise a baseline to pass.

## Browser component baseline

`pnpm test:ai:e2e` runs `tests/ai-browser/baseline.spec.ts` against a host `fixture.tsx` that mounts the production `AiProvider`, `AiAssistantRail`, and styles. It covers nine cases: diff, PR diff, and plan on desktop, narrow, and reduced-motion viewports. HTTP requests are intercepted before navigation; external origins and unknown APIs are rejected. The fixture serves empty `/api/ai/evidence` snapshots so the shipped rail's findings fetch is not treated as an unknown API. The fixture Vite config has no backend proxy or session-token bridge. Draft writes are synthetic and in-memory only.

Install Chromium (POSIX shell syntax) with `PLAYWRIGHT_BROWSERS_PATH=0 pnpm exec playwright install chromium --only-shell`; the runner uses a workspace-local browser path. An explicitly installed executable can be selected with `DIFFING_AI_BROWSER_EXECUTABLE=/absolute/path/to/chromium pnpm test:ai:e2e`. There is no silent fallback. The Chromium download pinned by Playwright 1.63.0 timed out, so the observed baseline used explicit cached Chromium 151.0.7922.34. It is not pinned-browser or platform certification. Browser download is network setup; tests make no live provider calls.

Artifacts are written to `~/.diffing/ai-browser/<first12 SHA256(cwd)>/report.json`, with test results in the sibling `results/` directory. The report records 20 keydowns per case to the second animation frame (not confirmed paint), p50/p95, long tasks during loaded-component→typing→reopen, scroll/draft restoration, viewport, and computed motion. Observed local values were p95 64–68ms, repeated 50–80ms long tasks, typing preserving scroll 0, reopen jumping to the bottom, drafts restored 9/9, reduced transitions 0.00001s versus 0.08s, and zero unknown requests. These are observed baseline values, not approved acceptance gates; timing is noisy and is not hardcoded as CI thresholds. Browser metrics live in this separate report; `bench:ai` still reports `browserMeasurements` null.

## Scope

This is a component baseline, not evidence from an integrated full-application toolkit workflow. jsdom tests are not rendered-browser evidence, and existing tests, build, and compiler gates remain separate.
