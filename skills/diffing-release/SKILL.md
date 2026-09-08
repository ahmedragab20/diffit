---
name: diffing-release
description: Prepare and publish a new diffing product release through its release script and CI. Use when a contributor asks to bump, tag, ship or release diffing itself; preview first and require explicit approval before pushing or publishing.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.0"
user_invocable: true
---

# Release diffing (contributors only)

## Use this when

Release the **diffing product**, not a consumer project's code. Installed-skill users must locate the intended product checkout; do not run these commands in an unrelated consumer repository.

## Before you start

Read the current `scripts/release.mjs` and `.github/workflows/native-tui.yml` in that checkout. Confirm the requested version bump and shipping authority. This recipe does not authorize commits, pushes, tags, npm publication or GitHub release creation on its own.

| Bump | Use |
| --- | --- |
| `--patch` (default) | Fixes/polish |
| `--minor` | New user-facing features |
| `--major` | Breaking changes |

## Recipe

### 1. Preview

```bash
pnpm release --dry-run --patch
```

Replace the bump flag as agreed. Dry-run reads local files/history and prints proposed version/changelog/build/shipping actions without performing them. It **skips the real clean-tree/branch/sync preflight**, so a dry-run pass does not prove release readiness.

Inspect the proposed changelog. It selects `feat`/`fix` subjects since the previous tag, excluding release-maintenance entries. If it says “No user-facing changes”, confirm that a release is still intended.

Present the proposed version and publication effects to the human. Do not proceed until they approve shipping.

### 2. Run the approved release

```bash
pnpm release --patch
```

The real script:

1. Requires a clean working tree on `main`; fetches `origin` and rejects ahead/behind `origin/main`.
2. Updates six version occurrences across `package.json`, `Cargo.toml`, two `Cargo.lock` packages, and the two site fallback strings; prepends the changelog section.
3. Runs `pnpm build && pnpm test` unless the human explicitly accepts `--no-verify`.
4. Stages the changes, commits `chore(release): prepare vX.Y.Z`, tags `vX.Y.Z`, and pushes `main` plus the tag.

Do not stage, stash, reset or clean unrelated work to satisfy preflight. Do not hand-bump around the script. A failed build leaves local release edits that must be inspected before continuing.

### 3. Verify CI/publication

The tag triggers `native-tui.yml`: build seven native targets, build/package the root, verify install, publish npm via OIDC trusted publishing, verify the published package, then create the GitHub release. Local npm authentication is not part of this flow.

```bash
gh run list --workflow=native-tui.yml
gh run watch RUN_ID
npm view diffing version
gh release list --limit 2
```

Select the run for the actual tag, not simply the newest run. Confirm both the expected npm version and GitHub release; successful local push alone is not a completed release.

## Recovery

| Failure | Action |
| --- | --- |
| Dirty/wrong/ahead-or-behind checkout | Stop and report; do not discard work or force the branch |
| Build/test failure | Inspect release edits and failure; do not rerun a version bump blindly |
| Main pushed but tag/publish uncertain | Inspect local/remote tag and workflow state before retrying |
| Local bundle check lacks other platforms | CI builds all seven; do not fabricate missing binaries |
| npm publish fails | Check CI/trusted-publisher configuration; do not publish locally |
| npm exists but GitHub release is missing | Inspect the CI create-release job; any manual recovery needs explicit authorization |

Never force-push, recreate a published tag, or bypass failed verification as an automatic retry. See [Recovery and safety](../diffing/references/recovery-and-safety.md) for ambiguous mutation outcomes.

## Done

Report the released version and evidence that the intended CI run, npm package and GitHub release succeeded. If one is missing, state the remaining blocker instead of claiming completion.

[Router](../diffing/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md) · [Recovery](../diffing/references/recovery-and-safety.md)
