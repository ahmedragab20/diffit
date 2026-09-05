import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export type DiffAlgorithm = 'minimal' | 'patience' | 'histogram' | 'myers'
export type WordDiffMode = 'color' | 'plain' | 'porcelain' | 'none'
export type ColorMovedMode = 'default' | 'plain' | 'blocks' | 'zebra' | 'dimmed-zebra' | 'no'
export type SubmoduleFormat = 'diff' | 'log' | 'short'
export type DiffOutputFormat =
  | 'patch'
  | 'raw'
  | 'numstat'
  | 'shortstat'
  | 'stat'
  | 'summary'
  | 'name-only'
  | 'name-status'
  | 'dirstat'

export type OutputMode = 'auto' | 'web' | 'terminal' | 'tui'

export interface DiffOptions {
  // ── Revisions ──────────────────────────────────────────
  /** Commits, branches, tags, ... ranges — everything before `--` pathspec */
  revisions: string[]

  /** --staged | --cached — show staged changes (against HEAD) */
  staged: boolean

  /** --merge — show merge conflicts */
  merge: boolean

  // ── Path limiting ──────────────────────────────────────
  /** File paths to limit the diff to */
  pathspecs: string[]

  // ── Diff algorithm ─────────────────────────────────────
  algorithm?: DiffAlgorithm
  indentHeuristic: boolean
  noIndentHeuristic: boolean
  anchored?: string

  // ── Whitespace ─────────────────────────────────────────
  ignoreSpaceChange: boolean
  ignoreAllSpace: boolean
  ignoreBlankLines: boolean
  ignoreCrAtEol: boolean
  wsErrorHighlight?: 'none' | 'default' | 'all'

  // ── Context lines ──────────────────────────────────────
  unifiedContext?: number
  interHunkContext?: number
  functionContext: boolean

  // ── Word-level diff ────────────────────────────────────
  wordDiff?: WordDiffMode
  wordDiffRegex?: string
  colorWords?: string

  // ── Moved / copied detection ───────────────────────────
  colorMoved?: ColorMovedMode
  colorMovedWs?: 'no' | 'ignore-space-at-eol' | 'ignore-space-change' | 'ignore-all-space' | 'allow-indentation-change'
  findCopies?: number
  findCopiesHarder: boolean
  findRenames?: number
  breakRewrites?: string | number
  noRenames: boolean

  // ── Merge / conflict stages ───────────────────────────
  /** --base — compare with stage 1 (merge base) */
  base: boolean
  /** --ours — compare with stage 2 (our branch) */
  ours: boolean
  /** --theirs — compare with stage 3 (their branch) */
  theirs: boolean

  // ── Output format ──────────────────────────────────────
  outputFormat?: DiffOutputFormat
  patchWithRaw: boolean
  patchWithStat: boolean
  compactSummary: boolean
  /** Width/params for `--stat[=…]` when set via `=`. */
  statParam?: string
  dirstat?: string
  dirstatByFile?: string
  cumulative: boolean

  // ── Filtering ──────────────────────────────────────────
  diffFilter?: string
  pickaxeString?: string
  pickaxeRegex?: string
  pickaxeAll: boolean

  // ── Output control ─────────────────────────────────────
  outputFile?: string
  exitCode: boolean
  quiet: boolean
  suppressPatch: boolean

  // ── Prefixes ───────────────────────────────────────────
  srcPrefix?: string
  dstPrefix?: string
  noPrefix: boolean
  linePrefix?: string

  // ── Submodule ─────────────────────────────────────────
  submodule?: SubmoduleFormat

  // ── Misc git options ───────────────────────────────────
  binary: boolean
  fullIndex: boolean
  text: boolean
  textconv: boolean
  noExtDiff: boolean
  extDiff?: string
  itaVisible: boolean
  relative?: string
  noRelative: boolean
  ignoreSubmodules?: 'none' | 'untracked' | 'dirty' | 'all'
  check: boolean

  // ── diffing-specific ────────────────────────────────────
  /** How to output the diff result */
  outputMode: OutputMode

  /** Server port (web mode) */
  port?: number

  /** Bind host (web mode) */
  host: string

  /** Skip auto browser-open (web mode) */
  noOpen: boolean

  /** Disable API authentication when binding to all interfaces (LAN exposure). */
  insecureNoAuth: boolean

  /**
   * Reuse the active review (print/open URL) instead of starting another.
   */
  reuseSession: boolean

  /**
   * Stop the active review before starting a replacement.
   */
  replaceSession: boolean

  /**
   * Always start a separate review, even when a compatible one is live.
   */
  newSession: boolean

  /** Print help and exit */
  help: boolean

  /** Print version and exit */
  version: boolean

  /** Skip the first-run setup gate on interactive launch */
  skipSetup: boolean

  /** Whether unstaged working-tree changes should be included (web mode default) */
  includeUnstaged: boolean
  /** Whether untracked files should be included (web mode default) */
  includeUntracked: boolean

  /** Opt into the experimental native-Rust TUI. */
  tui: boolean
  /** Open the focused, read-only native diff viewer. */
  viewOnly: boolean
  /** Opt into the experimental GPU render backend (requires --tui). */
  gpu: boolean

  /**
   * Open a GitHub PR review session instead of a working-tree diff.
   * Set by `--gh-pr <ref>` (bare number, `owner/repo#N`, or full URL).
   */
  ghPr?: string

  /**
   * `diffing show <revspec>...` — render the given commits with metadata
   * banners in the UI. Strictly opt-in via the `show` subcommand; never
   * inferred from `revisions`.
   */
  showMode: boolean
  /**
   * Raw revspecs as given to `show`. Forwarded to `git rev-list`/`git log`
   * so any form (single SHA, multiple SHAs, ranges, tags) is handled by
   * git itself.
   */
  showRevspecs: string[]
}

export const DEFAULTS: DiffOptions = {
  revisions: [],
  staged: false,
  merge: false,
  pathspecs: [],
  indentHeuristic: true,
  noIndentHeuristic: false,
  ignoreSpaceChange: false,
  ignoreAllSpace: false,
  ignoreBlankLines: false,
  ignoreCrAtEol: false,
  functionContext: false,
  patchWithRaw: false,
  patchWithStat: false,
  compactSummary: false,
  cumulative: false,
  pickaxeAll: false,
  exitCode: false,
  quiet: false,
  suppressPatch: false,
  noPrefix: false,
  binary: false,
  fullIndex: false,
  text: false,
  textconv: false,
  noExtDiff: false,
  itaVisible: false,
  noRelative: false,
  findCopiesHarder: false,
  noRenames: false,
  base: false,
  ours: false,
  theirs: false,
  check: false,
  outputMode: 'auto',
  host: '127.0.0.1',
  noOpen: false,
  insecureNoAuth: false,
  reuseSession: false,
  replaceSession: false,
  newSession: false,
  help: false,
  version: false,
  skipSetup: false,
  includeUnstaged: true,
  includeUntracked: true,
  tui: false,
  viewOnly: false,
  gpu: false,
  showMode: false,
  showRevspecs: [],
}

/**
 * All git-diff option definitions for `node:util.parseArgs`.
 * Categorised to match `git diff --help`.
 */
export const GIT_DIFF_OPTIONS = {
  // ── Staging / merge ──────────────────────────────────
  staged: { type: 'boolean' as const },
  cached: { type: 'boolean' as const },
  merge: { type: 'boolean' as const },

  // ── Diff algorithm ──────────────────────────────────
  'diff-algorithm': { type: 'string' as const },
  'indent-heuristic': { type: 'boolean' as const, default: true },
  'no-indent-heuristic': { type: 'boolean' as const },
  anchored: { type: 'string' as const },

  // ── Whitespace ──────────────────────────────────────
  'ignore-space-change': { type: 'boolean' as const, short: 'b' },
  'ignore-all-space': { type: 'boolean' as const, short: 'w' },
  'ignore-blank-lines': { type: 'boolean' as const },
  'ignore-cr-at-eol': { type: 'boolean' as const },
  'ws-error-highlight': { type: 'string' as const },

  // ── Context ─────────────────────────────────────────
  'unified': { type: 'string' as const, short: 'U' },
  'inter-hunk-context': { type: 'string' as const },
  'function-context': { type: 'boolean' as const, short: 'W' },

  // ── Word diff ───────────────────────────────────────
  'word-diff': { type: 'string' as const },
  'word-diff-regex': { type: 'string' as const },
  'color-words': { type: 'string' as const },

  // ── Moved / copied ──────────────────────────────────
  'color-moved': { type: 'string' as const },
  'color-moved-ws': { type: 'string' as const },
  'find-copies': { type: 'string' as const, short: 'C' },
  'find-copies-harder': { type: 'boolean' as const },
  'find-renames': { type: 'string' as const, short: 'M' },
  'break-rewrites': { type: 'string' as const, short: 'B' },
  'no-renames': { type: 'boolean' as const },

  // ── Output format ───────────────────────────────────
  patch: { type: 'boolean' as const, short: 'p' },
  'no-patch': { type: 'boolean' as const, short: 's' },
  raw: { type: 'boolean' as const },
  'patch-with-raw': { type: 'boolean' as const },
  'patch-with-stat': { type: 'boolean' as const },
  numstat: { type: 'boolean' as const },
  shortstat: { type: 'boolean' as const },
  stat: { type: 'string' as const },
  summary: { type: 'boolean' as const },
  'name-only': { type: 'boolean' as const },
  'name-status': { type: 'boolean' as const },
  check: { type: 'boolean' as const },
  'compact-summary': { type: 'boolean' as const },
  dirstat: { type: 'string' as const },
  'dirstat-by-file': { type: 'string' as const },
  cumulative: { type: 'boolean' as const },

  // ── Filtering ───────────────────────────────────────
  'diff-filter': { type: 'string' as const },
  S: { type: 'string' as const },
  G: { type: 'string' as const },
  'pickaxe-all': { type: 'boolean' as const },

  // ── Output control ──────────────────────────────────
  output: { type: 'string' as const, short: 'o' },
  'exit-code': { type: 'boolean' as const },
  quiet: { type: 'boolean' as const },

  // ── Prefixes ────────────────────────────────────────
  'src-prefix': { type: 'string' as const },
  'dst-prefix': { type: 'string' as const },
  'no-prefix': { type: 'boolean' as const },
  'line-prefix': { type: 'string' as const },

  // ── Submodule ───────────────────────────────────────
  submodule: { type: 'string' as const },

  // ── Misc git options ────────────────────────────────
  binary: { type: 'boolean' as const },
  'no-binary': { type: 'boolean' as const },
  'full-index': { type: 'boolean' as const },
  text: { type: 'boolean' as const, short: 'a' },
  textconv: { type: 'boolean' as const },
  'no-textconv': { type: 'boolean' as const },
  'no-ext-diff': { type: 'boolean' as const },
  'ext-diff': { type: 'string' as const },
  'ita-visible': { type: 'boolean' as const },
  'ita-invisible-in-index': { type: 'boolean' as const },
  relative: { type: 'string' as const },
  'no-relative': { type: 'boolean' as const },
  'ignore-submodules': { type: 'string' as const },

  // ── Merge / conflict stages ──────────────────────────
  base: { type: 'boolean' as const },
  ours: { type: 'boolean' as const },
  theirs: { type: 'boolean' as const },
} as const

/** Options that are diffing-specific, not git-diff options. */
export const DIFFING_OPTIONS = {
  port: { type: 'string' as const },
  host: { type: 'string' as const },
  'no-open': { type: 'boolean' as const, default: false },
  'insecure-no-auth': { type: 'boolean' as const, default: false },
  'reuse-session': { type: 'boolean' as const, default: false },
  'replace-session': { type: 'boolean' as const, default: false },
  'new-session': { type: 'boolean' as const, default: false },
  web: { type: 'boolean' as const, default: false },
  terminal: { type: 'boolean' as const, default: false },
  tui: { type: 'boolean' as const, default: false },
  view: { type: 'boolean' as const, default: false },
  gpu: { type: 'boolean' as const, default: false },
  'gh-pr': { type: 'string' as const },
  'skip-setup': { type: 'boolean' as const, default: false },
  help: { type: 'boolean' as const, short: 'h' },
  version: { type: 'boolean' as const },
}

function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf-8'))
    return pkg.version
  } catch {
    return 'unknown'
  }
}

export function printHelp(): void {
  const version = getVersion()
  console.log(`diffing v${version} – Local code review tool for git diffs

Usage: diffing [<git diff options>] [<revision>...] [-- <path>...]
       diffing --web [<git diff options>] [<revision>...] [-- <path>...]
       diffing view [<git diff options>] [<revision>...] [-- <path>...]
       diffing [server options]

Git Diff Options (drop-in replacement for git diff):`)
  printGitDiffHelp()

  console.log(`
Diffing Server Options:
  --port <port>        Port to run the server on (default: random available port)
  --host <host>        Host address to bind to (default: 127.0.0.1). Loopback
                       binds require a per-session API token. To expose the
                       review UI on your LAN, pass 0.0.0.0 together with
                       --insecure-no-auth (disables API authentication).
  --insecure-no-auth   Required when binding to wildcard addresses (0.0.0.0
                       or ::). Disables API authentication entirely, including
                       loopback token issuance (unsafe on shared networks).
  --no-open            Don't open the browser automatically
  --reuse-session      Open the active review, regardless of its scope
  --replace-session    Stop the active review and start a replacement
  --new-session        Start a separate review even when the scope already exists
  --skip-setup         Skip the first-run setup prompt (interactive TTY only)
  --gh-pr <ref>        Open a GitHub PR review session (number, owner/repo#N, or URL)
                       Same as: diffing "gh pr <ref>"

Output Modes:
  By default diffing auto-selects the best output mode:
  - Terminal mode: when output is a pipe, redirect, or non-TTY
  - Web or TUI:   saved preference for an interactive terminal (web by default)

  Force a mode with --web, --terminal, --tui, or --view flags.
  Change the interactive default with: diffing mode <web|tui>
  --view opens a focused, read-only diff browser with fff-powered search.
  --tui is experimental and opt-in. It opens a native-Rust terminal
  interface that mirrors the web dashboard. Falls back to git diff
  output if the environment cannot support a TUI (piped stdin, CI,
  missing binary).

Subcommands:
  setup|init|onboard   First-time setup wizard (skills, MCP, doctor)
  view [diff options]    Browse diffs in the focused read-only native TUI
  show <revspec>...    Drop-in for 'git show'. Renders commit metadata
                       above the diff. Accepts commits, ranges, tags.
  await-review         Block until human clicks Send to agent; print XML
  comments [--open] [--format xml|json|md]
  reply <id> --body …  Reply on a comment thread
  resolve|unresolve <id>
  comment edit|delete <id>
  progress --message … Live agent progress toast
  url                  Print the active review base URL
  sessions             List, select, open, and stop running review sessions
  plan <submit|await|list|show|versions|reply|resolve>
  gh <status|overview|threads|reviews|pr-fetch|pr-list-comments|pr-review>
  mcp [--repo PATH]    Stdio MCP server for agents
  inspect <summary|files|hunks|slice|search>
                       Bounded reads from a running web, TUI, or PR session
  mode [web|tui]       Get or set the default interactive review mode
  doctor               Environment self-check
  completion <bash|zsh|fish>
  update               Check for a newer npm release

Custom ranges (e.g. main..feature) and 'gh pr' sessions also display a
"what is this diff" banner in the web UI summarising the diff source.

Examples:
  diffing                        Review uncommitted changes (preferred UI)
  diffing setup                  Run the first-time setup wizard
  diffing --staged               Review staged changes
  diffing HEAD~3                 Review last 3 commits
  diffing main..feature          Compare branches
  diffing show HEAD              Review a single commit's metadata + diff
  diffing show HEAD~3..HEAD      Review the last 3 commits as a series
  diffing show HEAD -- src/      Limit a commit review to a directory
  diffing "gh pr 1234"           Review a GitHub pull request
  diffing --diff-algorithm=patience src/  Diff with patience algorithm
  diffing -U10                   Diff with 10 context lines
  diffing --word-diff=color      Word-level diff in color
  diffing -b -w                  Ignore whitespace changes
  diffing --host 0.0.0.0 --insecure-no-auth
                       Expose the review UI on the LAN without API tokens
  diffing view                   Browse the working-tree diff in the TUI
  diffing view --staged          Browse staged changes
  diffing --view main..feature   Browse a branch comparison
  diffing --tui                  Open the experimental TUI (native Rust)
  diffing mode tui               Use the TUI by default in interactive terminals
  diffing await-review           Agent: wait for human handoff
  diffing plan submit PLAN.md    Agent: submit a plan for approval
  diffing mcp --repo /abs/path   MCP server bound to one repository

Note: 'diffing <sha>' runs 'git diff <sha>' (working tree vs <sha>); it
is not the same as 'diffing show <sha>'. Use 'show' when you want to
review a commit's changes.

Full reference: docs/cli.md (bundled in the repository).`)
}

function printGitDiffHelp(): void {
  // Categorised flags matching git-diff(1)
  console.log(`
  Revision / Range:
    --staged, --cached      Show staged changes
    --merge                 Show merge conflicts

  Diff Algorithm:
    --diff-algorithm=<A>    Choose diff algorithm (minimal, patience, histogram, myers)
    --indent-heuristic      Enable indent heuristic (default: on)
    --no-indent-heuristic   Disable indent heuristic
    --anchored=<TEXT>       Anchor diff algorithm to <TEXT>

  Whitespace:
    -b, --ignore-space-change       Ignore changes in amount of whitespace
    -w, --ignore-all-space          Ignore whitespace when comparing lines
    --ignore-blank-lines            Ignore blank lines
    --ignore-cr-at-eol              Ignore carriage-return at EOL
    --ws-error-highlight=<KIND>     Highlight whitespace errors (none, default, all)

  Context:
    -U<n>, --unified=<n>           Generate diffs with <n> lines of context
    --inter-hunk-context=<n>        Show <n> lines between diff hunks
    -W, --function-context          Show whole function as context

  Word Diff:
    --word-diff=<MODE>              Word diff (color, plain, porcelain, none)
    --word-diff-regex=<REGEX>       Regex to determine a word
    --color-words[=<REGEX>]         Word diff with color

  Moved / Copied Detection:
    --color-moved=<MODE>            Color moved lines (no, default, plain, blocks, zebra, dimmed-zebra)
    --color-moved-ws=<MODE>         How whitespace is treated in --color-moved
    -C[<n>], --find-copies[=<n>]    Detect copies
    --find-copies-harder            Spend extra cycles to find copies
    -M[<n>], --find-renames[=<n>]   Detect renames
    -B[<n>], --break-rewrites[=<n>] Break complete rewrite changes into delete/add pairs
    --no-renames                    Turn off rename detection

  Merge / Conflict:
    --base                          Compare with merge base (stage 1)
    --ours                          Compare with our branch (stage 2)
    --theirs                        Compare with their branch (stage 3)

  Output Format:
    -p, --patch                     Generate patch (default)
    -s, --no-patch                  Suppress diff output
    --raw                           Generate raw diff
    --patch-with-raw                Both patch and raw output
    --patch-with-stat               Both patch and stat
    --numstat                       Machine-friendly stat: additions/deletions per file
    --shortstat                     Summary of additions/deletions
    --stat[=<width>]                Diffstat with graph
    --summary                       Extended header summary
    --name-only                     Show only names of changed files
    --name-status                   Show only names and status of changed files
    --check                         Check if diff introduces whitespace errors
    --compact-summary               Compact summary for submodule changes
    --dirstat[=<param>]             Directory-level change stats
    --dirstat-by-file[=<param>]     Per-file directory stats
    --cumulative                    Cumulative directory stats

  Filtering:
    --diff-filter=[(A|C|D|M|R|T|U|X|B)...[*]]
    -S<string>                      Look for differences that change number of occurrences of <string>
    -G<regex>                       Look for differences whose patch text contains <regex>
    --pickaxe-all                   Show all changes with -S or -G

  Output Control:
    -o, --output=<file>             Write diff to <file>
    --exit-code                     Exit with 1 if differences, 0 if not
    --quiet                         Disable all output, imply --exit-code

  Prefixes:
    --src-prefix=<PREFIX>           Source prefix (default: "a/")
    --dst-prefix=<PREFIX>           Destination prefix (default: "b/")
    --no-prefix                     Do not show source/destination prefixes
    --line-prefix=<PREFIX>          Prepend <PREFIX> to every line

  Submodule:
    --submodule=<FORMAT>            Submodule diff format (diff, log, short)

  Miscellaneous:
    --binary                        Output binary diff (apply patch to binary files)
    --no-binary                     Don't output binary diff
    --full-index                    Show full blob object names
    -a, --text                      Treat all files as text
    --textconv                      Allow external text conversion filters
    --no-textconv                   Disallow external text conversion filters
    --no-ext-diff                   Disallow external diff drivers
    --ext-diff=<CMD>                Allow external diff driver
    --ita-visible                   Include intent-to-add files
    --ignore-submodules=<WHEN>      Ignore submodule changes
    --relative[=<path>]             Show changes relative to <path>
    --no-relative                   Don't show relative paths`)
}

/**
 * Pre-process argv to handle git's optional-value flags.
 *
 * `-C`, `-M`, `-B` and their long forms (`--find-copies`, `--find-renames`,
 * `--break-rewrites`) take an **optional** numeric argument in git — when the
 * value is omitted, git uses the default similarity threshold (40%, 50%, 50%
 * respectively for `-B`'s percentage component, 60% for the `x` part of
 * `Bx/y`). `node:util.parseArgs` always consumes the next token as the value
 * for `type: 'string'`, which means `diffing -C main..feature` would
 * swallow `main..feature` as the `-C` value instead of treating it as a
 * revision.
 *
 * This function rewrites the input argv so that:
 *  - `-C` (no attached value) followed by a non-digit → `--find-copies=40`
 *  - `-C` (no attached value) followed by a digit    → left as-is so
 *                                                       parseArgs consumes
 *                                                       the numeric value
 *  - `-C40` (attached value)                          → left as-is
 *  - `--find-copies` (no value) followed by a digit   → `--find-copies=<n>`
 *  - `--find-copies=40` (attached value)               → left as-is
 *
 * The defaults mirror git's own behaviour: 40, 50, 50/60.
 */
function preprocessOptionalValueArgs(rawArgs: string[]): string[] {
  const SHORTS: Record<string, { long: string; def: string }> = {
    C: { long: 'find-copies', def: '40' },
    M: { long: 'find-renames', def: '50' },
    B: { long: 'break-rewrites', def: '50/60' },
  }
  const LONGS = new Set(['find-copies', 'find-renames', 'break-rewrites'])
  /** Git accepts values only as `--flag=value` for these; never `--flag value`. */
  const ATTACHED_ONLY_LONGS = new Set([
    'stat',
    'dirstat',
    'relative',
    'word-diff',
    'color-moved',
    'submodule',
  ])

  const startsWithDigit = (s: string | undefined): boolean =>
    typeof s === 'string' && /^[0-9]/.test(s)

  const out: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]

    // Standalone short form: exactly "-C" / "-M" / "-B" (no attached value).
    if (arg.length === 2 && arg[0] === '-' && SHORTS[arg[1]!]) {
      const cfg = SHORTS[arg[1]!]!
      const next = rawArgs[i + 1]
      if (startsWithDigit(next)) {
        // parseArgs will correctly consume the next arg as the value.
        out.push(arg)
      } else {
        // Use the default threshold and don't consume the next arg.
        out.push(`--${cfg.long}=${cfg.def}`)
      }
      continue
    }

    // Long form without "=": "--find-copies" / "--find-renames" / "--break-rewrites".
    const longMatch = /^--(find-copies|find-renames|break-rewrites)$/.exec(arg)
    if (longMatch) {
      const name = longMatch[1]!
      if (!LONGS.has(name)) {
        out.push(arg)
        continue
      }
      const next = rawArgs[i + 1]
      if (startsWithDigit(next)) {
        out.push(`--${name}=${next}`)
        i++ // consume the value
      } else {
        const def = name === 'find-copies' ? '40' : name === 'find-renames' ? '50' : '50/60'
        out.push(`--${name}=${def}`)
      }
      continue
    }

    // Attached-value-only long flags: `--stat main` must not consume `main` as the width.
    const attachedOnlyMatch = /^--(stat|dirstat|relative|word-diff|color-moved|submodule)$/.exec(arg)
    if (attachedOnlyMatch) {
      const name = attachedOnlyMatch[1]!
      if (ATTACHED_ONLY_LONGS.has(name)) {
        out.push(`--${name}=`)
      } else {
        out.push(arg)
      }
      continue
    }

    // Long form with "=" attached, or anything else: pass through unchanged.
    out.push(arg)
  }
  return out
}

/**
 * Parse raw `process.argv` slice into typed DiffOptions.
 *
 * Strategy:
 * 1. Pre-process optional-value args (`-C`, `-M`, `-B`, long forms) so they
 *    don't swallow following revisions like `main..feature`.
 * 2. Split argv into: [diffing options] [git revisions] [-- pathspecs]
 * 3. Parse known flags via node:util.parseArgs
 * 4. Anything unknown / positional becomes a revision or pathspec
 */
export function parseDiffOptions(
  rawArgs: string[],
  defaultInteractiveMode: Extract<OutputMode, 'web' | 'tui'> = 'web',
): DiffOptions {
  const allOptions = { ...GIT_DIFF_OPTIONS, ...DIFFING_OPTIONS }

  const preprocessed = preprocessOptionalValueArgs(rawArgs)

  const { values, positionals } = parseArgs({
    options: allOptions,
    allowPositionals: true,
    strict: false, // allow unknown git args to pass through as revisions
    args: preprocessed,
  })

  // DEFAULTS is exported as a convenient immutable template. Its array fields
  // must never be shared with parser results: parseDiffOptions mutates these
  // arrays while collecting revisions/pathspecs, and callers parse repeatedly
  // in long-lived processes such as the MCP server.
  const opts: DiffOptions = {
    ...DEFAULTS,
    revisions: [],
    pathspecs: [],
    showRevspecs: [],
  }

  // ── diffing-specific flags ──────────────────────────
  if (values.help) opts.help = true
  if (values.version) opts.version = true
  if (values.port) opts.port = parseInt(values.port as string, 10)
  if (values.host) opts.host = values.host as string
  if (values['no-open']) opts.noOpen = true
  if (values['insecure-no-auth']) opts.insecureNoAuth = true
  if (values['reuse-session']) opts.reuseSession = true
  if (values['replace-session']) opts.replaceSession = true
  if (values['new-session']) opts.newSession = true
  if (values['gh-pr']) opts.ghPr = String(values['gh-pr'])
  if (values['skip-setup']) opts.skipSetup = true
  if (values.view) opts.viewOnly = true

  // ── Staging / merge ───────────────────────────────
  if (values.staged || values.cached) opts.staged = true
  if (values.merge) opts.merge = true

  // ── Algorithm ─────────────────────────────────────
  const algo = values['diff-algorithm'] as string | undefined
  if (algo && ['minimal', 'patience', 'histogram', 'myers'].includes(algo)) {
    opts.algorithm = algo as DiffAlgorithm
  }
  if (values['no-indent-heuristic']) {
    opts.noIndentHeuristic = true
    opts.indentHeuristic = false
  }
  if (values.anchored) opts.anchored = values.anchored as string

  // ── Whitespace ────────────────────────────────────
  if (values['ignore-space-change']) opts.ignoreSpaceChange = true
  if (values['ignore-all-space']) opts.ignoreAllSpace = true
  if (values['ignore-blank-lines']) opts.ignoreBlankLines = true
  if (values['ignore-cr-at-eol']) opts.ignoreCrAtEol = true
  const wsh = values['ws-error-highlight'] as string | undefined
  if (wsh && ['none', 'default', 'all'].includes(wsh)) {
    opts.wsErrorHighlight = wsh as 'none' | 'default' | 'all'
  }

  // ── Context ───────────────────────────────────────
  if (values.unified) opts.unifiedContext = parseInt(values.unified as string, 10)
  if (values['inter-hunk-context']) opts.interHunkContext = parseInt(values['inter-hunk-context'] as string, 10)
  if (values['function-context']) opts.functionContext = true

  // ── Word diff ─────────────────────────────────────
  const wd = values['word-diff'] as string | undefined
  if (wd && ['color', 'plain', 'porcelain', 'none'].includes(wd)) {
    opts.wordDiff = wd as WordDiffMode
  }
  if (values['word-diff-regex']) opts.wordDiffRegex = values['word-diff-regex'] as string
  if (values['color-words']) {
    opts.wordDiff = 'color'
    opts.wordDiffRegex = (values['color-words'] as string) || undefined
  }

  // ── Moved/copied ──────────────────────────────────
  const cm = values['color-moved'] as string | undefined
  if (cm && ['default', 'plain', 'blocks', 'zebra', 'dimmed-zebra', 'no'].includes(cm)) {
    opts.colorMoved = cm as ColorMovedMode
  }
  const cmw = values['color-moved-ws'] as string | undefined
  if (cmw && ['no', 'ignore-space-at-eol', 'ignore-space-change', 'ignore-all-space', 'allow-indentation-change'].includes(cmw)) {
    opts.colorMovedWs = cmw as DiffOptions['colorMovedWs']
  }
  if (values['find-copies'] !== undefined) {
    const v = values['find-copies'] as string
    opts.findCopies = v ? parseInt(v, 10) : 40 // -C defaults to 40% similarity
  }
  if (values['find-copies-harder']) opts.findCopiesHarder = true
  if (values['find-renames'] !== undefined) {
    const v = values['find-renames'] as string
    opts.findRenames = v ? parseInt(v, 10) : 50 // -M defaults to 50%
  }
  if (values['break-rewrites'] !== undefined) opts.breakRewrites = values['break-rewrites'] as string
  if (values['no-renames']) opts.noRenames = true

  // ── Merge / conflict stages ────────────────────────
  if (values.base) opts.base = true
  if (values.ours) opts.ours = true
  if (values.theirs) opts.theirs = true

  // ── Output format ─────────────────────────────────
  if (values.raw) opts.outputFormat = 'raw'
  if (values.numstat) opts.outputFormat = 'numstat'
  if (values.shortstat) opts.outputFormat = 'shortstat'
  if (values.stat !== undefined) {
    opts.outputFormat = 'stat'
    const statVal = values.stat as string
    if (statVal) opts.statParam = statVal
  }
  if (values.summary) opts.outputFormat = 'summary'
  if (values['name-only']) opts.outputFormat = 'name-only'
  if (values['name-status']) opts.outputFormat = 'name-status'
  if (values['patch-with-raw']) opts.patchWithRaw = true
  if (values['patch-with-stat']) opts.patchWithStat = true
  if (values['compact-summary']) opts.compactSummary = true
  if (values.dirstat) opts.dirstat = values.dirstat as string
  if (values['dirstat-by-file']) opts.dirstatByFile = values['dirstat-by-file'] as string
  if (values.cumulative) opts.cumulative = true
  if (values['no-patch']) {
    opts.outputFormat = undefined
    opts.suppressPatch = true
  }
  if (values.check) {
    opts.outputFormat = undefined
    opts.check = true
  }

  // ── Filtering ─────────────────────────────────────
  if (values['diff-filter']) opts.diffFilter = values['diff-filter'] as string
  if (values.S) opts.pickaxeString = values.S as string
  if (values.G) opts.pickaxeRegex = values.G as string
  if (values['pickaxe-all']) opts.pickaxeAll = true

  // ── Output control ────────────────────────────────
  if (values.output) opts.outputFile = values.output as string
  if (values['exit-code']) opts.exitCode = true
  if (values.quiet) { opts.quiet = true; opts.exitCode = true }

  // ── Prefixes ──────────────────────────────────────
  if (values['src-prefix']) opts.srcPrefix = values['src-prefix'] as string
  if (values['dst-prefix']) opts.dstPrefix = values['dst-prefix'] as string
  if (values['no-prefix']) opts.noPrefix = true
  if (values['line-prefix']) opts.linePrefix = values['line-prefix'] as string

  // ── Submodule ─────────────────────────────────────
  const sm = values.submodule as string | undefined
  if (sm && ['diff', 'log', 'short'].includes(sm)) {
    opts.submodule = sm as SubmoduleFormat
  }

  // ── Misc ──────────────────────────────────────────
  if (values.binary) opts.binary = true
  if (values['no-binary']) opts.binary = false
  if (values['full-index']) opts.fullIndex = true
  if (values.text) opts.text = true
  if (values.textconv) opts.textconv = true
  if (values['no-textconv']) opts.textconv = false
  if (values['no-ext-diff']) opts.noExtDiff = true
  if (values['ext-diff']) opts.extDiff = values['ext-diff'] as string
  if (values['ita-visible'] || values['ita-invisible-in-index']) opts.itaVisible = true
  if (values.relative !== undefined) opts.relative = values.relative as string || undefined
  if (values['no-relative']) opts.noRelative = true
  if (values['ignore-submodules']) {
    const ig = values['ignore-submodules'] as string
    if (['none', 'untracked', 'dirty', 'all'].includes(ig)) {
      opts.ignoreSubmodules = ig as DiffOptions['ignoreSubmodules']
    }
  }

  // ── Revisions: any positional args are revisions ──
  // When a `--` separator is present, args after it are pathspecs.
  // Revisions come from parseArgs positionals (not a raw pre-`--` scan) so
  // option values like `--port 8080` are never mistaken for revisions.
  const dashDashIdx = rawArgs.indexOf('--')
  if (dashDashIdx >= 0) {
    for (let i = dashDashIdx + 1; i < rawArgs.length; i++) {
      opts.pathspecs.push(rawArgs[i])
    }
    const pathspecSet = new Set(opts.pathspecs)
    for (const p of positionals) {
      if (!pathspecSet.has(p)) opts.revisions.push(p)
    }
  } else {
    // No -- separator → positional args are revisions
    for (const p of positionals) {
      opts.revisions.push(p)
    }
  }

  // ── Determine output mode ─────────────────────────
  // Explicit --view / --tui / --web / --terminal flags win over the saved
  // interactive preference. GitHub PR reviews remain web-only.
  if (values.view) opts.outputMode = 'tui'
  else if (values.tui) opts.outputMode = 'tui'
  else if (values.web) opts.outputMode = 'web'
  else if (values.terminal) opts.outputMode = 'terminal'

  // Default: saved preference for a TTY, terminal for pipes/redirects.
  if (process.stdout.isTTY && opts.outputMode === 'auto') {
    opts.outputMode = values['gh-pr'] ? 'web' : defaultInteractiveMode
  } else if (!process.stdout.isTTY && opts.outputMode === 'auto') {
    opts.outputMode = 'terminal'
  }

  // The native index accepts only a conventional unified patch. Flags that
  // replace or decorate that format retain exact git behavior by routing to
  // terminal mode instead of producing an empty or subtly corrupt TUI.
  if (
    opts.outputFormat ||
    opts.patchWithRaw ||
    opts.patchWithStat ||
    opts.compactSummary ||
    opts.dirstat ||
    opts.dirstatByFile ||
    opts.cumulative ||
    opts.suppressPatch ||
    opts.check ||
    opts.exitCode ||
    opts.quiet ||
    opts.outputFile ||
    opts.colorMoved ||
    opts.colorMovedWs ||
    opts.srcPrefix ||
    opts.dstPrefix ||
    opts.noPrefix ||
    opts.linePrefix ||
    (opts.submodule !== undefined && opts.submodule !== 'diff') ||
    opts.extDiff
  ) {
    opts.outputMode = 'terminal'
  }

  return opts
}

/**
 * Build the `git diff` argument array from parsed options.
 * Returns args that can be spread into `git diff <args>`.
 */
export function buildGitDiffArgs(opts: DiffOptions): string[] {
  const args: string[] = []

  // ── Algorithm ─────────────────────────────────────
  if (opts.algorithm) args.push(`--diff-algorithm=${opts.algorithm}`)
  if (opts.noIndentHeuristic) args.push('--no-indent-heuristic')
  if (opts.anchored) args.push(`--anchored=${opts.anchored}`)

  // ── Staging / merge ───────────────────────────────
  if (opts.staged) args.push('--staged')
  if (opts.merge) args.push('--merge')
  if (opts.base) args.push('--base')
  if (opts.ours) args.push('--ours')
  if (opts.theirs) args.push('--theirs')

  // ── Whitespace ────────────────────────────────────
  if (opts.ignoreSpaceChange) args.push('--ignore-space-change')
  if (opts.ignoreAllSpace) args.push('--ignore-all-space')
  if (opts.ignoreBlankLines) args.push('--ignore-blank-lines')
  if (opts.ignoreCrAtEol) args.push('--ignore-cr-at-eol')
  if (opts.wsErrorHighlight) args.push(`--ws-error-highlight=${opts.wsErrorHighlight}`)

  // ── Context ───────────────────────────────────────
  if (opts.unifiedContext !== undefined) args.push(`--unified=${opts.unifiedContext}`)
  if (opts.interHunkContext !== undefined) args.push(`--inter-hunk-context=${opts.interHunkContext}`)
  if (opts.functionContext) args.push('--function-context')

  // ── Word diff ─────────────────────────────────────
  if (opts.wordDiff) {
    if (opts.wordDiff === 'color' && opts.wordDiffRegex && !opts.colorWords) {
      args.push(`--word-diff=color`)
      args.push(`--word-diff-regex=${opts.wordDiffRegex}`)
    } else if (opts.wordDiff === 'color' && opts.colorWords) {
      args.push(`--color-words=${opts.wordDiffRegex || '.'}`)
    } else {
      args.push(`--word-diff=${opts.wordDiff}`)
    }
  }
  if (opts.wordDiffRegex && opts.wordDiff !== 'color') {
    args.push(`--word-diff-regex=${opts.wordDiffRegex}`)
  }

  // ── Moved/copied ──────────────────────────────────
  if (opts.colorMoved) args.push(`--color-moved=${opts.colorMoved}`)
  if (opts.colorMovedWs) args.push(`--color-moved-ws=${opts.colorMovedWs}`)
  if (opts.findCopies !== undefined) {
    args.push(opts.findCopies === 40 ? '-C' : `-C${opts.findCopies}`)
  }
  if (opts.findCopiesHarder) args.push('--find-copies-harder')
  if (opts.findRenames !== undefined) {
    args.push(opts.findRenames === 50 ? '-M' : `-M${opts.findRenames}`)
  }
  if (opts.breakRewrites !== undefined) {
    args.push(`-B${opts.breakRewrites}`)
  }
  if (opts.noRenames) args.push('--no-renames')

  // ── Output format ─────────────────────────────────
  if (opts.outputFormat === 'raw') args.push('--raw')
  if (opts.outputFormat === 'numstat') args.push('--numstat')
  if (opts.outputFormat === 'shortstat') args.push('--shortstat')
  if (opts.outputFormat === 'stat') {
    args.push(opts.statParam ? `--stat=${opts.statParam}` : '--stat')
  }
  if (opts.outputFormat === 'summary') args.push('--summary')
  if (opts.outputFormat === 'name-only') args.push('--name-only')
  if (opts.outputFormat === 'name-status') args.push('--name-status')
  if (opts.patchWithRaw) args.push('--patch-with-raw')
  if (opts.patchWithStat) args.push('--patch-with-stat')
  if (opts.compactSummary) args.push('--compact-summary')
  if (opts.dirstat) args.push(`--dirstat=${opts.dirstat}`)
  if (opts.dirstatByFile) args.push(`--dirstat-by-file=${opts.dirstatByFile}`)
  if (opts.cumulative) args.push('--cumulative')
  if (opts.check) args.push('--check')
  if (opts.suppressPatch) args.push('--no-patch')

  // ── Filtering ─────────────────────────────────────
  if (opts.diffFilter) args.push(`--diff-filter=${opts.diffFilter}`)
  if (opts.pickaxeString) args.push(`-S${opts.pickaxeString}`)
  if (opts.pickaxeRegex) args.push(`-G${opts.pickaxeRegex}`)
  if (opts.pickaxeAll) args.push('--pickaxe-all')

  // ── Output control ────────────────────────────────
  if (opts.outputFile) args.push(`--output=${opts.outputFile}`)
  if (opts.exitCode) args.push('--exit-code')
  if (opts.quiet) args.push('--quiet')

  // ── Prefixes ──────────────────────────────────────
  if (opts.srcPrefix) args.push(`--src-prefix=${opts.srcPrefix}`)
  if (opts.dstPrefix) args.push(`--dst-prefix=${opts.dstPrefix}`)
  if (opts.noPrefix) args.push('--no-prefix')
  if (opts.linePrefix) args.push(`--line-prefix=${opts.linePrefix}`)

  // ── Submodule ─────────────────────────────────────
  if (opts.submodule) args.push(`--submodule=${opts.submodule}`)

  // ── Misc ──────────────────────────────────────────
  if (opts.binary) args.push('--binary')
  if (opts.fullIndex) args.push('--full-index')
  if (opts.text) args.push('--text')
  if (opts.textconv) args.push('--textconv')
  if (opts.noExtDiff) args.push('--no-ext-diff')
  if (opts.extDiff) args.push(`--ext-diff=${opts.extDiff}`)
  if (opts.itaVisible) args.push('--ita-visible')
  if (opts.relative !== undefined) {
    args.push(opts.relative ? `--relative=${opts.relative}` : '--relative')
  }
  if (opts.noRelative) args.push('--no-relative')
  if (opts.ignoreSubmodules) args.push(`--ignore-submodules=${opts.ignoreSubmodules}`)

  // ── Revisions ─────────────────────────────────────
  for (const rev of opts.revisions) {
    args.push(rev)
  }

  // ── Pathspecs ─────────────────────────────────────
  if (opts.pathspecs.length > 0) {
    args.push('--')
    args.push(...opts.pathspecs)
  }

  return args
}

/**
 * Build the machine-stable patch arguments consumed by the native index.
 * Presentation-only word/color modes are implemented by the renderer and
 * must not rewrite the unified patch stream that Rust parses.
 */
export function buildTuiGitDiffArgs(opts: DiffOptions): string[] {
  return buildGitDiffArgs({
    ...opts,
    revisions: opts.showMode ? [...opts.showRevspecs] : [...opts.revisions],
    pathspecs: [...opts.pathspecs],
    wordDiff: undefined,
    wordDiffRegex: undefined,
    colorWords: undefined,
    colorMoved: undefined,
    colorMovedWs: undefined,
  })
}

/**
 * Build the set of diffing-diff args used for the web UI.
 * Includes unstaged (always) + optionally staged/untracked.
 */
export function buildWebDiffArgs(opts: DiffOptions): string[] {
  const args: string[] = buildGitDiffArgs(opts)

  // Web mode always adds standardised flags
  if (!args.includes('--no-ext-diff')) args.unshift('--no-ext-diff')

  return args
}

/**
 * Transform a `parseDiffOptions(...)` result into a "show mode" variant:
 * moves any parsed revisions into `showRevspecs`, clears `revisions` (so the
 * existing diff-engine path does not try to `git diff` them), and sets the
 * `showMode` flag. Pathspecs and every other flag survive unchanged.
 *
 * Returns the same object for callsite ergonomics — the mutation is in-place
 * because `parseDiffOptions` always returns a fresh object.
 */
export function intoShowMode(opts: DiffOptions): DiffOptions {
  opts.showRevspecs = opts.revisions
  opts.revisions = []
  opts.showMode = true
  return opts
}
