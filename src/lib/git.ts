import { execFileSync, execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  isSafePath,
  toSafeLiteralRelativePath,
  toSafeRelativePath,
} from "./path.js";
import {
  closeNativeRepositoryFs,
  getNativeRepositoryFs,
  NativeFsError,
} from "./native-fs.js";
import {
  parseSync as parseEditorConfig,
  type ProcessedFileConfig,
} from "editorconfig";

const execFileAsync = promisify(execFile);

// Files on disk may use LF, CRLF (typical on Windows) or even bare CR endings
// (very rare, but legal). When we synthesise a unified diff for an untracked
// file we want one diff line per source line *without* a trailing `\r` —
// otherwise the diff viewer renders a stray carriage return on every added
// line. Mirrors the `/\r?\n/` already used by the git-log parser below.
function splitLines(content: string): string[] {
  return content.split(/\r\n|\n|\r/);
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
  ".avif",
]);

export function isImageFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function isBinaryFile(absolutePath: string): boolean {
  try {
    const buffer = readFileSync(absolutePath);
    const bytesToCheck = Math.min(buffer.length, 8192);
    for (let i = 0; i < bytesToCheck; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export async function getFileContent(
  filePath: string,
  version: "old" | "new",
): Promise<Buffer | null> {
  const root = getRepoRoot();
  if (typeof filePath !== "string") throw new NativeFsError("invalid-path");
  const relPath = toSafeLiteralRelativePath(filePath, root);
  if (!relPath) throw new NativeFsError("invalid-path");
  if (version === "new") {
    try {
      return (await getNativeRepositoryFs(root).read(relPath)).bytes;
    } catch (error) {
      if (error instanceof NativeFsError && error.code === "not-found")
        return null;
      throw error;
    }
  }
  // Historical blobs are Git data, not paths to reopen in the working tree.
  try {
    const { stdout } = await execFileAsync("git", ["show", `HEAD:${relPath}`], {
      encoding: "buffer",
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch {
    return null;
  }
}

let cachedRepoRoot: string | null = null;
const editorConfigCache = new Map<string, ProcessedFileConfig>();
type RepoMetadata = { repoName: string; branch: string; headToken: string };
let cachedRepoMetadata: RepoMetadata | null = null;
let tabSizeCache: { key: string; map: Record<string, number> } | null = null;

function gitHeadToken(): string {
  try {
    const root = getRepoRoot();
    return readFileSync(join(root, ".git", "HEAD"), "utf-8").trim();
  } catch {
    return "";
  }
}

export function _resetRepoRootCache(): void {
  closeNativeRepositoryFs();
  cachedRepoRoot = null;
  editorConfigCache.clear();
  cachedRepoMetadata = null;
  tabSizeCache = null;
}

export function isGitRepo(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function getRepoRoot(): string {
  if (cachedRepoRoot !== null) return cachedRepoRoot;
  cachedRepoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).trim();
  return cachedRepoRoot;
}

export function getRepoName(): string {
  return getRepoMetadata().repoName;
}

export function getBranchName(): string {
  return getRepoMetadata().branch;
}

export function getRepoMetadata(): { repoName: string; branch: string } {
  const headToken = gitHeadToken();
  if (cachedRepoMetadata && cachedRepoMetadata.headToken === headToken) {
    return {
      repoName: cachedRepoMetadata.repoName,
      branch: cachedRepoMetadata.branch,
    };
  }
  const repoName = basename(getRepoRoot());
  let branch = "";
  try {
    branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      stdio: "pipe",
      encoding: "utf-8",
    }).trim();
  } catch {
    branch = "";
  }
  cachedRepoMetadata = { repoName, branch, headToken };
  return { repoName, branch };
}

export async function getRepoMetadataAsync(): Promise<{
  repoName: string;
  branch: string;
}> {
  const headToken = gitHeadToken();
  if (cachedRepoMetadata && cachedRepoMetadata.headToken === headToken) {
    return {
      repoName: cachedRepoMetadata.repoName,
      branch: cachedRepoMetadata.branch,
    };
  }
  const repoName = basename(await getRepoRootAsync());
  const branch = await getBranchNameAsync();
  cachedRepoMetadata = { repoName, branch, headToken };
  return { repoName, branch };
}

// Force standard unified diff regardless of user's git config
// (e.g. diff.external = difftastic, color.ui = always).
// Never execute repository-configured diff drivers or textconv commands while
// producing review data. Both can invoke arbitrary local programs.
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"] as const;

export function getCustomGitDiff(args: string[]): string {
  return execFileSync("git", ["diff", ...DIFF_FLAGS, ...args], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

export function getGitDiff(
  options: { staged?: boolean; untracked?: boolean } = {},
): string {
  const parts: string[] = [];

  // unstaged changes (always included as the base)
  const unstaged = execFileSync("git", ["diff", ...DIFF_FLAGS], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (unstaged) parts.push(unstaged);

  // staged changes
  if (options.staged) {
    const staged = execFileSync("git", ["diff", ...DIFF_FLAGS, "--staged"], {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (staged) parts.push(staged);
  }

  // untracked files
  if (options.untracked) {
    const untrackedPatch = getUntrackedFilesDiff();
    if (untrackedPatch) parts.push(untrackedPatch);
  }

  return parts.join("\n");
}

export function getTabSizeForFiles(
  filePaths: string[],
): Record<string, number> {
  const key = [...filePaths].sort().join("\0");
  if (tabSizeCache?.key === key) {
    return tabSizeCache.map;
  }
  const root = getRepoRoot();
  const result: Record<string, number> = {};
  for (const filePath of filePaths) {
    try {
      const absPath = join(root, filePath);
      const config = parseEditorConfig(absPath, { cache: editorConfigCache });
      const size =
        config.tab_width ??
        (config.indent_size === "tab" ? undefined : config.indent_size);
      if (typeof size === "number") {
        result[filePath] = size;
      }
    } catch {
      // skip files that fail to resolve
    }
  }
  tabSizeCache = { key, map: result };
  return result;
}

export async function getTabSizeForFilesAsync(
  filePaths: string[],
): Promise<Record<string, number>> {
  return getTabSizeForFiles(filePaths);
}

export function getUntrackedFilePaths(): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    },
  ).trim();
  return output ? output.split("\n") : [];
}

function getUntrackedFilesDiff(): string {
  const root = getRepoRoot();
  const output = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    },
  ).trim();

  if (!output) return "";

  const files = output.split("\n");
  const patches: string[] = [];

  for (const file of files) {
    const absolutePath = join(root, file);
    if (isBinaryFile(absolutePath)) {
      const patch = [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "index 0000000..0000001",
        `Binary files /dev/null and b/${file} differ`,
      ].join("\n");
      patches.push(patch);
    } else {
      try {
        const content = readFileSync(absolutePath, "utf-8");
        const lines = splitLines(content);
        const diffLines = lines.map((l: string) => `+${l}`);
        const patch = [
          `diff --git a/${file} b/${file}`,
          "new file mode 100644",
          "index 0000000..0000001",
          "--- /dev/null",
          `+++ b/${file}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...diffLines,
        ].join("\n");
        patches.push(patch);
      } catch {
        // skip unreadable files
      }
    }
  }

  return patches.length > 0 ? "\n" + patches.join("\n") : "";
}

export async function getRepoRootAsync(): Promise<string> {
  if (cachedRepoRoot !== null) return cachedRepoRoot;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { encoding: "utf-8" },
    );
    cachedRepoRoot = stdout.trim();
    return cachedRepoRoot;
  } catch {
    return "";
  }
}

export async function getBranchNameAsync(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf-8" },
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function getUntrackedFilePathsAsync(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    return trimmed ? trimmed.split("\n") : [];
  } catch {
    return [];
  }
}

async function getUntrackedFilesDiffAsync(): Promise<string> {
  const root = await getRepoRootAsync();
  const filePaths = await getUntrackedFilePathsAsync();

  if (filePaths.length === 0) return "";

  const patches: string[] = [];

  const fileDiffPromises = filePaths.map(async (file) => {
    const absolutePath = join(root, file);
    if (isBinaryFile(absolutePath)) {
      return [
        `diff --git a/${file} b/${file}`,
        "new file mode 100644",
        "index 0000000..0000001",
        `Binary files /dev/null and b/${file} differ`,
      ].join("\n");
    } else {
      try {
        const content = await readFile(absolutePath, "utf-8");
        const lines = splitLines(content);
        const diffLines = lines.map((l: string) => `+${l}`);
        return [
          `diff --git a/${file} b/${file}`,
          "new file mode 100644",
          "index 0000000..0000001",
          "--- /dev/null",
          `+++ b/${file}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...diffLines,
        ].join("\n");
      } catch {
        return "";
      }
    }
  });

  const results = await Promise.all(fileDiffPromises);
  for (const r of results) {
    if (r) patches.push(r);
  }

  return patches.length > 0 ? "\n" + patches.join("\n") : "";
}

export async function getCustomGitDiffAsync(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", ...DIFF_FLAGS, ...args],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
}

export async function getGitDiffAsync(
  options: { staged?: boolean; untracked?: boolean } = {},
): Promise<string> {
  const unstagedPromise = execFileAsync("git", ["diff", ...DIFF_FLAGS], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  })
    .then(({ stdout }) => stdout)
    .catch(() => "");

  const stagedPromise = options.staged
    ? execFileAsync("git", ["diff", ...DIFF_FLAGS, "--staged"], {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
      })
        .then(({ stdout }) => stdout)
        .catch(() => "")
    : Promise.resolve("");

  const untrackedPromise = options.untracked
    ? getUntrackedFilesDiffAsync()
    : Promise.resolve("");

  const [unstaged, staged, untrackedPatch] = await Promise.all([
    unstagedPromise,
    stagedPromise,
    untrackedPromise,
  ]);

  const parts: string[] = [];
  if (unstaged) parts.push(unstaged);
  if (staged) parts.push(staged);
  if (untrackedPatch) parts.push(untrackedPatch);

  return parts.join("\n");
}

/**
 * Lists every file the working tree knows about (tracked + untracked,
 * excluding standard-ignored paths). Used by the Phase D file viewer to
 * power a path picker.
 */
export function listRepoFiles(): string[] {
  try {
    const tracked = execFileSync("git", ["ls-files"], {
      encoding: "utf-8",
      maxBuffer: 100 * 1024 * 1024,
    }).trim();
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 },
    ).trim();
    const set = new Set<string>();
    for (const list of [tracked, untracked]) {
      if (!list) continue;
      for (const line of list.split("\n")) {
        if (line) set.add(line);
      }
    }
    return [...set].sort();
  } catch {
    return [];
  }
}

export interface MergeStatus {
  inMerge: boolean;
  conflicts: string[];
}

/**
 * Reports whether the repo is currently in the middle of a merge and which
 * files have unresolved conflicts. Used by the Phase C merge-conflict UI to
 * decide when to render the @pierre/diffs UnresolvedFile component.
 */
export function getMergeStatus(): MergeStatus {
  let root: string;
  try {
    root = getRepoRoot();
  } catch {
    return { inMerge: false, conflicts: [] };
  }
  const mergeHead = join(root, ".git", "MERGE_HEAD");
  let inMerge = false;
  try {
    readFileSync(mergeHead);
    inMerge = true;
  } catch {
    inMerge = false;
  }

  let conflicts: string[] = [];
  try {
    const out = execFileSync(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    ).trim();
    conflicts = out ? out.split("\n") : [];
  } catch {
    conflicts = [];
  }
  return { inMerge: inMerge || conflicts.length > 0, conflicts };
}

export function gitAddFile(filePath: string): void {
  execFileSync("git", ["add", "--", filePath], { stdio: "pipe" });
}

/**
 * Returns a unified diff for a single working-tree file (covers unstaged
 * and untracked changes). Used by the Phase E hunk-revert flow to derive
 * the exact patch text we need to `git apply --reverse`.
 */
export function getFilePatch(filePath: string): string {
  try {
    const unstaged = execFileSync(
      "git",
      ["diff", ...DIFF_FLAGS, "--", filePath],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    if (unstaged) return unstaged;
  } catch {
    // fall through
  }
  // Untracked: synthesize a new-file patch like getGitDiff does.
  try {
    const root = getRepoRoot();
    const absolutePath = join(root, filePath);
    if (isBinaryFile(absolutePath)) return "";
    const content = readFileSync(absolutePath, "utf-8");
    const lines = splitLines(content);
    return [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      "index 0000000..0000001",
      "--- /dev/null",
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * Extracts the Nth hunk text from a single-file patch. Returns the lines
 * from `@@ ... @@` through the line before the next `@@` (or EOF).
 */
export function extractHunk(patch: string, hunkIndex: number): string | null {
  const lines = patch.split("\n");
  const hunkStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("@@ ")) hunkStarts.push(i);
  }
  if (hunkIndex < 0 || hunkIndex >= hunkStarts.length) return null;
  const start = hunkStarts[hunkIndex];
  const end =
    hunkIndex + 1 < hunkStarts.length
      ? hunkStarts[hunkIndex + 1]
      : lines.length;
  return lines.slice(start, end).join("\n");
}

/** Header lines that the per-file patch needs in order for `git apply` to
 * recognize the target. Stops just before the first `@@` hunk header. */
export function extractPatchHeader(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@ ")) break;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Reverts a single hunk from the working tree by piping a minimal patch to
 * `git apply --reverse`. Throws if git rejects the apply (typically because
 * the file has shifted since the diff was rendered).
 */
export function revertHunk(filePath: string, hunkIndex: number): void {
  const patch = getFilePatch(filePath);
  if (!patch) {
    throw new Error("No diff available for this file");
  }
  const header = extractPatchHeader(patch);
  const hunk = extractHunk(patch, hunkIndex);
  if (!hunk) {
    throw new Error(`Hunk ${hunkIndex} not found`);
  }
  const minimal = `${header}\n${hunk}\n`;
  execFileSync("git", ["apply", "--reverse", "-"], {
    input: minimal,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function getProjectStorageDir(customRepoRoot?: string): string {
  const root = customRepoRoot || getRepoRoot();
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const repoName = basename(root);
  return join(homedir(), ".diffing", `${repoName}-${hash}`);
}

export interface BlameEntry {
  commit: string;
  author: string;
  date: string;
  line: number;
  content: string;
  summary: string;
}

export interface RecentCommit {
  hash: string;
  author: string;
  date: string;
  summary: string;
}

export interface HunkHistory {
  blame: BlameEntry[];
  recentCommits: RecentCommit[];
}

/**
 * Retrieves git blame for deleted lines and recent log history for the file,
 * providing context on what commit introduced the deleted code.
 */
export function getHunkHistory(
  filePath: string,
  deletionStart: number,
  deletionCount: number,
  revision = "HEAD",
): HunkHistory {
  const root = getRepoRoot();
  if (!isSafePath(filePath, root)) {
    throw new Error("Forbidden file path");
  }

  const blame: BlameEntry[] = [];

  if (deletionCount > 0) {
    try {
      const blameOut = execFileSync(
        "git",
        [
          "blame",
          "--date=format:%Y-%m-%d",
          "-L",
          `${deletionStart},+${deletionCount}`,
          revision,
          "--",
          filePath,
        ],
        { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
      );

      const lines = blameOut.split("\n");
      const commitHashes = new Set<string>();

      for (const line of lines) {
        if (!line.trim()) continue;
        const match = line.match(
          /^(\^?[0-9a-fA-F]+) \((.*?) (\d{4}-\d{2}-\d{2}) (\d+)\)(?: (.*))?$/,
        );
        if (match) {
          const [_, commit, author, date, lineNum, content] = match;
          const cleanCommit = commit.startsWith("^") ? commit.slice(1) : commit;
          blame.push({
            commit: cleanCommit,
            author: author.trim(),
            date,
            line: parseInt(lineNum, 10),
            content: content || "",
            summary: "", // filled below
          });
          commitHashes.add(cleanCommit);
        }
      }

      // Fetch commit summaries
      const commitSummaries: Record<string, string> = {};
      for (const hash of commitHashes) {
        try {
          const summary = execFileSync(
            "git",
            ["show", "-s", "--format=%s", hash],
            { encoding: "utf-8" },
          ).trim();
          commitSummaries[hash] = summary;
        } catch {
          commitSummaries[hash] = "Unknown commit";
        }
      }

      for (const entry of blame) {
        entry.summary = commitSummaries[entry.commit] || "Unknown commit";
      }
    } catch (err: any) {
      console.warn("Failed to get git blame for hunk history:", err.message);
    }
  }

  const recentCommits: RecentCommit[] = [];
  try {
    const logOut = execFileSync(
      "git",
      [
        "log",
        "-n",
        "5",
        "--date=format:%Y-%m-%d",
        "--format=%h|%an|%ad|%s",
        "--",
        filePath,
      ],
      { encoding: "utf-8" },
    );

    for (const line of logOut.split("\n")) {
      if (!line.trim()) continue;
      const [hash, author, date, summary] = line.split("|");
      if (hash && author && date && summary) {
        recentCommits.push({
          hash,
          author: author.trim(),
          date,
          summary: summary.trim(),
        });
      }
    }
  } catch (err: any) {
    console.warn("Failed to get git log for hunk history:", err.message);
  }

  return { blame, recentCommits };
}

// ── `diffing show` support ─────────────────────────────────────────────
// `parseGitShowRaw` is a pure, dependency-free parser for the output of
//   git log --no-walk --reverse -p --pretty=raw --no-color --no-ext-diff <commits>
// It tolerates: optional `parent` headers (root commits have none), multiple
// parents (merge commits), `gpgsig` blocks of indented continuation lines,
// commits with empty bodies, and commits where the diff is empty (path-filtered
// out entirely). Keeping this in `lib/git.ts` colocates it with the producer
// (`getShowDiff`) and the rest of the git glue.

export interface CommitInfo {
  /** 40-char commit SHA. */
  sha: string;
  /** 7-char short SHA. */
  shortSha: string;
  /** Parent SHAs; empty for root commits, 1 for normal, 2+ for merges. */
  parents: string[];
  /** First line of the commit message. */
  subject: string;
  /** Remaining lines of the commit message (may be empty). */
  body: string;
  authorName: string;
  authorEmail: string;
  /** ISO 8601 (`%aI`) — we convert from git's `%at %ai` to ISO inline. */
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  /** Unified diff for *this commit only*. Empty if path-filtered out. */
  patch: string;
}

/**
 * Parse the output of `git log --pretty=raw -p` into `CommitInfo[]`.
 *
 * The `raw` format emits one record per commit:
 *
 *   commit <sha>
 *   tree <sha>
 *   parent <sha>            (zero or more; merges have ≥ 2)
 *   author <name> <email> <unix-time> <tz>
 *   committer <name> <email> <unix-time> <tz>
 *   gpgsig -----BEGIN ...   (optional; continuation lines start with a single space)
 *    <indented body>
 *
 *       <indented commit message — 4 spaces of indent>
 *
 *   diff --git a/... b/...  (the per-commit patch; may be empty)
 *   ...
 *
 * Records are separated by blank lines but the unambiguous boundary is the
 * next line beginning with `commit <40-hex>` at column 0.
 */
export function parseGitShowRaw(raw: string): CommitInfo[] {
  if (!raw) return [];

  const out: CommitInfo[] = [];
  const lines = raw.split("\n");

  // Find the start indices of each commit record.
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^commit [0-9a-f]{40}\b/.test(lines[i])) starts.push(i);
  }
  if (starts.length === 0) return [];

  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    const slice = lines.slice(begin, end);
    const info = parseSingleCommitRaw(slice);
    if (info) out.push(info);
  }
  return out;
}

function parseSingleCommitRaw(lines: string[]): CommitInfo | null {
  const first = lines[0] ?? "";
  const shaMatch = first.match(/^commit ([0-9a-f]{40})/);
  if (!shaMatch) return null;
  const sha = shaMatch[1];

  let i = 1;
  const parents: string[] = [];
  let authorName = "";
  let authorEmail = "";
  let authorDate = "";
  let committerName = "";
  let committerEmail = "";
  let committerDate = "";

  // Header section: every `key value` line at column 0, plus possible
  // multi-line headers (`gpgsig` followed by indented continuation lines).
  // The header section ends at the first blank line.
  while (i < lines.length) {
    const line = lines[i];
    if (line === "") break;

    // Skip continuation lines for the previous multi-line header.
    if (line.startsWith(" ")) {
      i++;
      continue;
    }

    const idx = line.indexOf(" ");
    const key = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? "" : line.slice(idx + 1);

    switch (key) {
      case "tree":
        // ignored — we don't expose the tree SHA
        break;
      case "parent":
        if (value) parents.push(value);
        break;
      case "author": {
        const ident = parseIdent(value);
        authorName = ident.name;
        authorEmail = ident.email;
        authorDate = ident.date;
        break;
      }
      case "committer": {
        const ident = parseIdent(value);
        committerName = ident.name;
        committerEmail = ident.email;
        committerDate = ident.date;
        break;
      }
      // `gpgsig`, `mergetag`, `encoding`, etc. — accept and skip; their
      // continuation lines are absorbed by the `startsWith(' ')` branch.
      default:
        break;
    }
    i++;
  }

  // Skip the blank line.
  if (i < lines.length && lines[i] === "") i++;

  // Commit message: indented by 4 spaces. Subject is the first non-empty
  // message line; body is everything after the first blank message line.
  const msgLines: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    // The diff portion never starts with 4-space indent, so any line that
    // doesn't start with `    ` AND isn't blank ends the message.
    if (line.startsWith("    ")) {
      msgLines.push(line.slice(4));
      i++;
      continue;
    }
    if (line === "") {
      msgLines.push("");
      i++;
      continue;
    }
    break;
  }
  const { subject, body } = splitMessage(msgLines);

  // Everything from `diff --git` (or `Binary files ...`) onwards is the patch.
  // Allow blank lines in between (git sometimes pads). Stop at EOF.
  let patchStart = -1;
  for (let j = i; j < lines.length; j++) {
    const line = lines[j];
    if (line.startsWith("diff --git ") || line.startsWith("Binary files ")) {
      patchStart = j;
      break;
    }
    if (line === "") continue;
    // Any non-empty, non-diff line at this point is unexpected; bail.
    break;
  }
  const patch =
    patchStart === -1
      ? ""
      : lines.slice(patchStart).join("\n").replace(/\n+$/, "\n");

  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents,
    subject,
    body,
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate,
    patch,
  };
}

/**
 * Parse a `Name <email> <unix-seconds> <±HHMM>` ident line into structured
 * fields. The email is bracketed; the timestamp is split out and converted to
 * ISO 8601 for consumers.
 */
function parseIdent(value: string): {
  name: string;
  email: string;
  date: string;
} {
  // Example: "Ahmed Ragab <a@b.com> 1780269243 +0300"
  const match = value.match(/^(.*?)\s+<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/);
  if (!match) return { name: value, email: "", date: "" };
  const [, name, email, secs, tz] = match;
  return { name, email, date: unixToIso(Number(secs), tz) };
}

function unixToIso(secs: number, tz: string): string {
  if (!Number.isFinite(secs)) return "";
  // Render in the commit's own timezone so reviewers see the time the author
  // typed it. `Date#toISOString` is always UTC; we hand-roll the offset.
  const sign = tz.startsWith("-") ? -1 : 1;
  const tzHours = Number(tz.slice(1, 3));
  const tzMins = Number(tz.slice(3, 5));
  const offsetMs = sign * (tzHours * 60 + tzMins) * 60_000;
  const d = new Date(secs * 1000 + offsetMs);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `${tz.slice(0, 3)}:${tz.slice(3)}`
  );
}

function splitMessage(msgLines: string[]): { subject: string; body: string } {
  if (msgLines.length === 0) return { subject: "", body: "" };
  // Trim leading/trailing blank lines that git pads with.
  let start = 0;
  while (start < msgLines.length && msgLines[start] === "") start++;
  let stop = msgLines.length;
  while (stop > start && msgLines[stop - 1] === "") stop--;
  if (start >= stop) return { subject: "", body: "" };
  const subject = msgLines[start];
  // Skip the blank line between subject and body (git's convention).
  let bodyStart = start + 1;
  if (bodyStart < stop && msgLines[bodyStart] === "") bodyStart++;
  const body = msgLines.slice(bodyStart, stop).join("\n");
  return { subject, body };
}

/**
 * Resolve any combination of revspecs (single SHAs, ranges, tags) into an
 * ordered, oldest-first list of commits, then fetch each commit's metadata
 * + per-commit diff in a single `git log` invocation. Returns both the
 * structured `commits[]` (for the UI's metadata banners) and a concatenated
 * `patch` string (for the existing patch-parsing pipeline that powers the
 * file tree and tab-size detection).
 *
 * Caps the resolved commit list at `MAX_SHOW_COMMITS` to keep the page snappy
 * on large ranges; over-limit commits are dropped silently from the response
 * but the count is preserved on the `truncated` field so the UI can warn.
 */
export const MAX_SHOW_COMMITS = 100;

export async function getShowDiff(
  revspecs: string[],
  pathspecs: string[] = [],
): Promise<{ commits: CommitInfo[]; patch: string; truncated: number }> {
  if (revspecs.length === 0) return { commits: [], patch: "", truncated: 0 };

  // 1. Resolve revspecs to a flat, ordered commit list. `git rev-list` accepts
  // every form we care about (single SHA, range, tag, `^X Y`); `--no-walk`
  // makes bare revspecs resolve to *just that commit* (without it, `HEAD`
  // would walk the entire history), while ranges still expand normally.
  // `--reverse` gives oldest-first which matches reading order for a series
  // review.
  let shaList: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "rev-list",
        "--no-walk",
        "--reverse",
        ...revspecs,
        ...(pathspecs.length ? ["--", ...pathspecs] : []),
      ],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    shaList = stdout.split("\n").filter(Boolean);
  } catch {
    return { commits: [], patch: "", truncated: 0 };
  }

  if (shaList.length === 0) return { commits: [], patch: "", truncated: 0 };

  // 2. Cap the list. Over-limit ranges still render the first N commits +
  // a "truncated" badge in the UI rather than freezing the browser.
  const truncated = Math.max(0, shaList.length - MAX_SHOW_COMMITS);
  const trimmed =
    truncated === 0 ? shaList : shaList.slice(0, MAX_SHOW_COMMITS);

  // 3. Fetch metadata + per-commit diff in one shot. `--no-walk` ensures only
  // these exact commits are shown (no ancestor traversal); `--reverse` keeps
  // the same oldest-first ordering as step 1.
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        "--no-walk",
        "--reverse",
        "-p",
        "--pretty=raw",
        ...DIFF_FLAGS,
        ...trimmed,
        ...(pathspecs.length ? ["--", ...pathspecs] : []),
      ],
      { encoding: "utf-8", maxBuffer: 200 * 1024 * 1024 },
    );
    raw = stdout;
  } catch {
    return { commits: [], patch: "", truncated: 0 };
  }

  const commits = parseGitShowRaw(raw);
  const patch = commits
    .map((c) => c.patch)
    .filter(Boolean)
    .join("\n");
  return { commits, patch, truncated };
}

export interface CommitSeriesSummary {
  /** Total commits found by `git log` (capped at `MAX_SHOW_COMMITS`). */
  commitCount: number;
  /** Commits dropped past the cap; 0 when nothing was truncated. */
  truncated: number;
  /** First line of each commit message, oldest-first. */
  subjects: string[];
  /** De-duplicated authors in commit order. */
  authors: string[];
  /** Earliest author date (ISO 8601) across the visible commits. */
  fromDate?: string;
  /** Latest author date (ISO 8601) across the visible commits. */
  toDate?: string;
}

/**
 * Cheap summary of a revspec series: just subject + author + date. Used by
 * the diff overview banner to render "what am I looking at?" for custom
 * non-show revisions (e.g. `diffing main..feature`).
 *
 * Uses `git log --no-walk --reverse --pretty=%s%x00%an%x00%aI`. The NUL
 * separators avoid the `|` ambiguity the older `getHunkHistory` parser
 * suffers from; we keep that call alone rather than refactoring it.
 *
 * `--no-walk` keeps single-SHA revspecs cheap (just that commit's metadata)
 * while ranges still expand normally. Reuses the same `MAX_SHOW_COMMITS`
 * cap as `getShowDiff` so the banner and the per-commit view agree.
 */
export async function getCommitSeriesSummary(
  revspecs: string[],
  pathspecs: string[] = [],
): Promise<CommitSeriesSummary> {
  const empty: CommitSeriesSummary = {
    commitCount: 0,
    truncated: 0,
    subjects: [],
    authors: [],
  };
  if (revspecs.length === 0) return empty;

  // First, count how many commits the revspec resolves to so we know the
  // truncation count. Use `git rev-list` (no per-commit metadata) so this
  // stays O(commits) memory and CPU, not the larger fetch we already do for
  // show mode. `--reverse` matches reading order for a series review.
  let shaList: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "rev-list",
        "--no-walk",
        "--reverse",
        ...revspecs,
        ...(pathspecs.length ? ["--", ...pathspecs] : []),
      ],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    shaList = stdout.split("\n").filter(Boolean);
  } catch {
    return empty;
  }

  const totalCommits = shaList.length;
  if (totalCommits === 0) return empty;

  const truncated = Math.max(0, totalCommits - MAX_SHOW_COMMITS);
  const trimmed =
    truncated === 0 ? shaList : shaList.slice(0, MAX_SHOW_COMMITS);

  // Now fetch subject + author + date for the (capped) commit set. NUL is
  // the only character git never emits in a commit message, so it's a safe
  // field separator. We don't need patch data here.
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        "--no-walk",
        "--reverse",
        "--pretty=%s%x00%an%x00%aI",
        ...DIFF_FLAGS,
        ...trimmed,
        ...(pathspecs.length ? ["--", ...pathspecs] : []),
      ],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
    raw = stdout;
  } catch {
    return { ...empty, commitCount: totalCommits, truncated };
  }

  const subjects: string[] = [];
  const authors: string[] = [];
  const seenAuthors = new Set<string>();
  let fromDate: string | undefined;
  let toDate: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\u0000");
    const subject = parts[0] ?? "";
    const author = parts[1] ?? "";
    const date = parts[2] ?? "";
    if (subject) subjects.push(subject);
    if (author && !seenAuthors.has(author)) {
      seenAuthors.add(author);
      authors.push(author);
    }
    if (date) {
      if (!fromDate || date < fromDate) fromDate = date;
      if (!toDate || date > toDate) toDate = date;
    }
  }

  return {
    commitCount: totalCommits,
    truncated,
    subjects,
    authors,
    fromDate,
    toDate,
  };
}
