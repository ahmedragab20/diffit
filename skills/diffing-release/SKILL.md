---
name: diffing-release
description: Cut and ship a diffing product release through its release script and CI. Use when a diffing contributor asks to bump, tag, publish or ship diffing itself; preview with a dry run first and get explicit approval before anything is pushed.
license: MIT
metadata:
  author: ahmedragab20
  version: "0.20.1"
user_invocable: true
---

# Release diffing (contributors only)

## Use this when

Someone is releasing the **diffing product** itself. A consumer project's own release is a different job. Installed-skill users need to locate the intended product checkout first; these commands belong there and nowhere else.

## Before you start

Read the current `scripts/release.mjs` and `.github/workflows/native-tui.yml` in that checkout — they are the source of truth for what ships. Confirm the requested bump and who authorized shipping. Commits, pushes, tags, npm publication and GitHub release creation each need that authorization; this recipe grants none of them.

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

Swap the bump flag for the agreed one. The dry run reads local files and history and prints the proposed version, changelog, build and shipping actions without performing them. It **skips the real clean-tree, branch and sync preflight**, so a clean dry run is not proof of release readiness.

Inspect the proposed changelog: it takes `feat` and `fix` subjects since the previous tag, minus release-maintenance entries. If it says "No user-facing changes", confirm a release is still wanted.

Show the human the proposed version and its publication effects, and wait for their approval to ship.

### 2. Run the approved release

```bash
pnpm release --patch
```

The real script:

1. Requires a clean working tree on `main`; fetches `origin` and rejects a branch ahead of or behind `origin/main`.
2. Updates six version occurrences across `package.json`, `Cargo.toml`, two `Cargo.lock` packages and the two site fallback strings, then prepends the changelog section.
3. Runs `pnpm build && pnpm test` unless the human explicitly accepts `--no-verify`.
4. Stages, commits `chore(release): prepare vX.Y.Z`, tags `vX.Y.Z`, and pushes `main` plus the tag.

Satisfy the preflight by landing or setting aside work deliberately, with the human's say-so — not by staging, stashing, resetting or cleaning around it, and not by hand-bumping past the script. A failed build leaves local release edits on disk; inspect them before doing anything else.

### 3. Verify CI and publication

The tag triggers `native-tui.yml`: build seven native targets, build and package the root, verify the install, publish npm through OIDC trusted publishing, verify the published package, then create the GitHub release. Local npm authentication plays no part.

```bash
gh run list --workflow=native-tui.yml
gh run watch RUN_ID
npm view diffing version
gh release list --limit 2
```

Pick the run for the actual tag rather than the newest one. Confirm both the expected npm version and the GitHub release; a successful push is only the first step.

## Recovery

| Failure | Action |
| --- | --- |
| Dirty/wrong/ahead-or-behind checkout | Stop and report; the human decides what happens to that work |
| Build/test failure | Inspect the release edits and the failure before any rerun |
| Main pushed but tag/publish uncertain | Inspect the local and remote tag and the workflow state before retrying |
| Local bundle check lacks other platforms | CI builds all seven; report what you could verify |
| npm publish fails | Check CI and trusted-publisher configuration; publication stays in CI |
| npm exists but GitHub release is missing | Inspect the CI create-release job; manual recovery needs explicit authorization |

A published tag stays published: recreating one, force-pushing, or retrying past a failed verification each need an explicit human decision. [Recovery and safety](../diffing/references/recovery-and-safety.md) covers ambiguous mutation outcomes.

## Done

Report the released version with evidence that the intended CI run, the npm package and the GitHub release all succeeded. If one is missing, name it as the remaining blocker.

[Router](../diffing/SKILL.md) · [Sessions](../diffing/references/sessions-and-transports.md) · [Headless API](../diffing/references/headless-api.md) · [Recovery](../diffing/references/recovery-and-safety.md)
