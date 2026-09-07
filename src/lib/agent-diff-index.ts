/**
 * In-process unified-diff index for token-efficient agent inspection.
 *
 * Mirrors the TUI Agent API response shapes (`/api/diff/summary|files|hunks|slice|search`)
 * so web and gh-pr sessions can share the same inspect CLI / MCP tools without
 * embedding the Rust sparse spool. Suitable for patches already held in memory
 * (PR sessions, web `git diff` results).
 */

import { createHash } from "node:crypto";
import {
  capPathMatches,
  compilePathspecGlob,
  displayPath,
  fileMatchesPath,
  isLockfileNoise,
  parseExcludeList,
  type InspectScopeError,
  type PathMatcher,
} from "./inspect-scope.js";

export type IndexedChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "binary";

export type IndexedLineKind = "context" | "add" | "del";

export interface IndexedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading: string;
  /** Logical row of this hunk's header within its file (0 = file header). */
  rowStart: number;
  /** Body rows after the hunk header (not including the header itself). */
  lineCount: number;
}

export type ViewRow =
  | {
      type: "fileHeader";
      fileIndex: number;
      path: string;
      kind: IndexedChangeKind;
      binary: boolean;
    }
  | {
      type: "hunkHeader";
      hunkIndex: number;
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      heading: string;
    }
  | {
      type: "line";
      hunkIndex: number;
      kind: IndexedLineKind;
      oldLineno: number | null;
      newLineno: number | null;
      content: string;
    }
  | {
      type: "noNewline";
      hunkIndex: number;
    };

export interface IndexedFile {
  oldPath: string | null;
  newPath: string | null;
  kind: IndexedChangeKind;
  isBinary: boolean;
  hunks: IndexedHunk[];
  /** Logical rows including file header and each hunk header. */
  rowCount: number;
  additions: number;
  deletions: number;
  /** Precomputed logical rows for slice/search (includes headers). */
  rows: ViewRow[];
}

export interface AgentDiffIndex {
  generation: number;
  complete: boolean;
  files: IndexedFile[];
  totalRows: number;
  totalHunks: number;
  additions: number;
  deletions: number;
  patchBytes: number;
  omittedPaths?: string[];
}

export interface Viewport {
  generation: number;
  fileIndex: number;
  startRow: number;
  nextRow: number | null;
  totalRows: number;
  truncated: boolean;
  estimatedBytes: number;
  rows: ViewRow[];
}

export interface SearchHit {
  fileIndex: number;
  path: string;
  row: number;
  oldLineno: number | null;
  newLineno: number | null;
  preview: string;
}

export interface SearchPage {
  generation: number;
  hits: SearchHit[];
  nextFile: number | null;
  nextRow: number | null;
  truncated: boolean;
  estimatedBytes: number;
}

export interface DirectorySummary {
  path: string;
  files: number;
  hunks: number;
  additions: number;
  deletions: number;
}

export interface SummaryResponse {
  generation: number;
  complete: boolean;
  files: number;
  hunks: number;
  rows: number;
  additions: number;
  deletions: number;
  patchBytes: number;
  changes: Record<string, number>;
  directories: DirectorySummary[];
  exclude?: string[];
  next: string[];
  omittedPaths?: string[];
}

export interface FilesPage {
  generation: number;
  returned: number;
  total: number;
  matched: number;
  path?: string;
  nextCursor: number | null;
  files: Array<{
    index: number;
    path: string;
    oldPath: string | null;
    newPath: string | null;
    kind: IndexedChangeKind;
    binary: boolean;
    hunks: number;
    rows: number;
    additions: number;
    deletions: number;
  }>;
}

export interface HunksPage {
  generation: number;
  file: number;
  path: string;
  returned: number;
  total: number;
  nextCursor: number | null;
  hunks: IndexedHunk[];
}

const MAX_PAGE_LINES = 1000;
const DEFAULT_SLICE_LINES = 120;
const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

let nextGeneration = 1;

export function createEmptyIndex(
  generation = nextGeneration++,
  complete = true,
  omittedPaths?: string[],
): AgentDiffIndex {
  return {
    generation,
    complete,
    files: [],
    totalRows: 0,
    totalHunks: 0,
    additions: 0,
    deletions: 0,
    patchBytes: 0,
    ...(omittedPaths && omittedPaths.length > 0 ? { omittedPaths } : {}),
  };
}

/**
 * Parse a unified multi-file patch into an agent-facing index.
 * Generation is assigned automatically unless provided (for cache control).
 */
export function buildAgentDiffIndex(
  patch: string,
  generation: number = nextGeneration++,
  options?: { complete?: boolean; omittedPaths?: string[] },
): AgentDiffIndex {
  const complete = options?.complete ?? true;
  const omittedPaths = options?.omittedPaths;
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (!patch.trim()) {
    return {
      ...createEmptyIndex(generation, complete, omittedPaths),
      patchBytes,
    };
  }

  const lines = patch.split(/\r?\n/);
  const files: IndexedFile[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const gitHeader = parseGitFileHeader(line);
    if (!gitHeader) {
      i++;
      continue;
    }

    const [oldPathRaw, newPathRaw] = gitHeader;
    let oldPath: string | null = oldPathRaw === "/dev/null" ? null : oldPathRaw;
    let newPath: string | null = newPathRaw === "/dev/null" ? null : newPathRaw;
    let isBinary = false;
    let kind: IndexedChangeKind = "modified";
    const fileStart = i;
    i++;

    // Scan headers until first hunk or next file.
    while (i < lines.length) {
      const h = lines[i];
      if (h.startsWith("diff --git ")) break;
      if (h.startsWith("@@ ")) break;
      if (h.startsWith("Binary files ") || h.startsWith("GIT binary patch")) {
        isBinary = true;
      }
      if (h.startsWith("new file mode")) kind = "added";
      else if (h.startsWith("deleted file mode")) kind = "deleted";
      else if (h.startsWith("rename from ")) {
        kind = "renamed";
        oldPath = decodeGitPath(h.slice("rename from ".length));
      } else if (h.startsWith("rename to ")) {
        kind = "renamed";
        newPath = decodeGitPath(h.slice("rename to ".length));
      } else if (h.startsWith("--- ")) {
        const p = decodeGitPath(h.slice(4));
        oldPath = p === "/dev/null" ? null : stripSidePrefix(p, "a/");
      } else if (h.startsWith("+++ ")) {
        const p = decodeGitPath(h.slice(4));
        newPath = p === "/dev/null" ? null : stripSidePrefix(p, "b/");
      }
      i++;
    }

    if (isBinary) kind = "binary";
    else if (!oldPath && newPath) kind = "added";
    else if (oldPath && !newPath) kind = "deleted";

    const displayPath = newPath ?? oldPath ?? "";
    const rows: ViewRow[] = [];
    const hunks: IndexedHunk[] = [];
    let additions = 0;
    let deletions = 0;
    const fileIndex = files.length;

    rows.push({
      type: "fileHeader",
      fileIndex,
      path: displayPath,
      kind,
      binary: isBinary,
    });

    if (!isBinary) {
      while (i < lines.length) {
        const h = lines[i];
        if (h.startsWith("diff --git ")) break;
        const hunkMatch =
          /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(h);
        if (!hunkMatch) {
          i++;
          continue;
        }

        const oldStart = Number(hunkMatch[1]);
        const oldLines = hunkMatch[2] != null ? Number(hunkMatch[2]) : 1;
        const newStart = Number(hunkMatch[3]);
        const newLines = hunkMatch[4] != null ? Number(hunkMatch[4]) : 1;
        const heading = (hunkMatch[5] ?? "").replace(/^\s/, "");
        const hunkIndex = hunks.length;
        const rowStart = rows.length;

        rows.push({
          type: "hunkHeader",
          hunkIndex,
          oldStart,
          oldLines,
          newStart,
          newLines,
          heading,
        });

        i++;
        let oldLineno = oldStart;
        let newLineno = newStart;
        let bodyCount = 0;

        while (i < lines.length) {
          const body = lines[i];
          if (body.startsWith("diff --git ") || body.startsWith("@@ ")) break;
          if (body.startsWith("\\ No newline at end of file")) {
            rows.push({ type: "noNewline", hunkIndex });
            bodyCount++;
            i++;
            continue;
          }

          // Empty line at EOF of patch may be a trailing split artifact.
          if (body === "" && i === lines.length - 1) {
            i++;
            break;
          }

          const prefix = body[0];
          if (prefix === "+") {
            rows.push({
              type: "line",
              hunkIndex,
              kind: "add",
              oldLineno: null,
              newLineno,
              content: body.slice(1),
            });
            newLineno++;
            additions++;
            bodyCount++;
            i++;
            continue;
          }
          if (prefix === "-") {
            rows.push({
              type: "line",
              hunkIndex,
              kind: "del",
              oldLineno,
              newLineno: null,
              content: body.slice(1),
            });
            oldLineno++;
            deletions++;
            bodyCount++;
            i++;
            continue;
          }
          if (prefix === " " || body === "") {
            // Context lines start with space; some tools emit bare empty lines as context.
            const content = prefix === " " ? body.slice(1) : body;
            rows.push({
              type: "line",
              hunkIndex,
              kind: "context",
              oldLineno,
              newLineno,
              content,
            });
            oldLineno++;
            newLineno++;
            bodyCount++;
            i++;
            continue;
          }
          // Unknown line — stop hunk body to avoid mis-parse.
          break;
        }

        hunks.push({
          oldStart,
          oldLines,
          newStart,
          newLines,
          heading,
          rowStart,
          lineCount: bodyCount,
        });
      }
    } else {
      // Skip remainder of binary file section until next file header.
      while (i < lines.length && !lines[i].startsWith("diff --git ")) i++;
    }

    // Avoid unused variable warning for fileStart in optimized builds.
    void fileStart;

    files.push({
      oldPath,
      newPath,
      kind,
      isBinary,
      hunks,
      rowCount: rows.length,
      additions,
      deletions,
      rows,
    });
  }

  let totalRows = 0;
  let totalHunks = 0;
  let totalAdd = 0;
  let totalDel = 0;
  for (const f of files) {
    totalRows += f.rowCount;
    totalHunks += f.hunks.length;
    totalAdd += f.additions;
    totalDel += f.deletions;
  }

  return {
    generation,
    complete,
    files,
    totalRows,
    totalHunks,
    additions: totalAdd,
    deletions: totalDel,
    patchBytes,
    ...(omittedPaths && omittedPaths.length > 0 ? { omittedPaths } : {}),
  };
}

const DIRECTORY_CAP = 20;

export function indexSummary(
  index: AgentDiffIndex,
  excludeRaw?: string | string[],
): SummaryResponse | InspectScopeError {
  const exclude = parseExcludeList(excludeRaw);
  if ("error" in exclude) return exclude;
  const skipLockfiles = exclude.includes("lockfiles");
  const counted = skipLockfiles
    ? index.files.filter(
        (file) => !isLockfileNoise(displayPath(file.oldPath, file.newPath)),
      )
    : index.files;

  const changes: Record<string, number> = {};
  let hunks = 0;
  let rows = 0;
  let additions = 0;
  let deletions = 0;
  for (const file of counted) {
    changes[file.kind] = (changes[file.kind] ?? 0) + 1;
    hunks += file.hunks.length;
    rows += file.rowCount;
    additions += file.additions;
    deletions += file.deletions;
  }

  const summary: SummaryResponse = {
    generation: index.generation,
    complete: index.complete,
    files: counted.length,
    hunks,
    rows,
    additions,
    deletions,
    patchBytes: index.patchBytes,
    changes,
    directories: summarizeDirectories(counted),
    next: ["diff_files", "diff_search", "diff_slice"],
  };
  if (exclude.length > 0) summary.exclude = exclude;
  if (index.omittedPaths && index.omittedPaths.length > 0) {
    summary.omittedPaths = index.omittedPaths;
  }
  return summary;
}

function summarizeDirectories(files: IndexedFile[]): DirectorySummary[] {
  const buckets = new Map<string, DirectorySummary>();
  for (const file of files) {
    const path = displayPath(file.oldPath, file.newPath);
    const slash = path.indexOf("/");
    const dir = slash < 0 ? "." : path.slice(0, slash);
    const bucket = buckets.get(dir) ?? {
      path: dir,
      files: 0,
      hunks: 0,
      additions: 0,
      deletions: 0,
    };
    bucket.files += 1;
    bucket.hunks += file.hunks.length;
    bucket.additions += file.additions;
    bucket.deletions += file.deletions;
    buckets.set(dir, bucket);
  }
  const ranked = [...buckets.values()].sort((a, b) => {
    if (b.files !== a.files) return b.files - a.files;
    return b.additions + b.deletions - (a.additions + a.deletions);
  });
  if (ranked.length <= DIRECTORY_CAP) return ranked;
  const head = ranked.slice(0, DIRECTORY_CAP);
  const rest = ranked.slice(DIRECTORY_CAP);
  const other: DirectorySummary = {
    path: "+other",
    files: 0,
    hunks: 0,
    additions: 0,
    deletions: 0,
  };
  for (const bucket of rest) {
    other.files += bucket.files;
    other.hunks += bucket.hunks;
    other.additions += bucket.additions;
    other.deletions += bucket.deletions;
  }
  head.push(other);
  return head;
}

function scopedFiles(
  index: AgentDiffIndex,
  path: string | undefined,
):
  | {
      matcher?: PathMatcher;
      entries: Array<{ index: number; file: IndexedFile }>;
    }
  | InspectScopeError {
  if (path == null || path === "") {
    return { entries: index.files.map((file, i) => ({ index: i, file })) };
  }
  const matcher = compilePathspecGlob(path);
  if ("error" in matcher) return matcher;
  const entries = index.files.flatMap((file, i) =>
    fileMatchesPath(matcher, file.oldPath, file.newPath)
      ? [{ index: i, file }]
      : [],
  );
  return { matcher, entries };
}

export function resolveInspectFile(
  index: AgentDiffIndex,
  file: number | undefined,
  path: string | undefined,
): { fileIndex: number } | InspectScopeError {
  const hasFile = file != null;
  const hasPath = path != null && path !== "";
  if (hasFile && hasPath) {
    return { error: "path and file are mutually exclusive", status: 400, path };
  }
  if (!hasFile && !hasPath) {
    return { error: "file or path is required", status: 400 };
  }
  if (hasFile) return { fileIndex: file };
  const scoped = scopedFiles(index, path);
  if ("error" in scoped) return scoped;
  if (scoped.entries.length === 0) {
    return { error: "path matched no files", status: 404, path };
  }
  if (scoped.entries.length > 1) {
    return {
      error: "path matched multiple files; narrow the glob or pass file",
      status: 409,
      path,
      matches: capPathMatches(
        scoped.entries.map(({ index, file }) => ({
          index,
          path: displayPath(file.oldPath, file.newPath),
        })),
      ),
    };
  }
  return { fileIndex: scoped.entries[0].index };
}

export function indexFiles(
  index: AgentDiffIndex,
  cursor = 0,
  limit = 100,
  path?: string,
): FilesPage | InspectScopeError {
  const scoped = scopedFiles(index, path);
  if ("error" in scoped) return scoped;
  const safeLimit = clamp(limit, 1, MAX_PAGE_LINES);
  const start = Math.max(0, cursor);
  const end = Math.min(scoped.entries.length, start + safeLimit);
  const files = scoped.entries.slice(start, end).map(({ index, file }) => ({
    index,
    path: displayPath(file.oldPath, file.newPath),
    oldPath: file.oldPath,
    newPath: file.newPath,
    kind: file.kind,
    binary: file.isBinary,
    hunks: file.hunks.length,
    rows: file.rowCount,
    additions: file.additions,
    deletions: file.deletions,
  }));
  const page: FilesPage = {
    generation: index.generation,
    returned: files.length,
    total: index.files.length,
    matched: scoped.entries.length,
    nextCursor: end < scoped.entries.length ? end : null,
    files,
  };
  if (path) page.path = path;
  return page;
}

export function indexHunks(
  index: AgentDiffIndex,
  fileIndex: number,
  cursor = 0,
  limit = 100,
  generation?: number,
): HunksPage | InspectScopeError {
  if (generation !== undefined && generation !== index.generation) {
    return {
      error: `stale generation ${generation}; current generation is ${index.generation}`,
      status: 409,
    };
  }
  const file = index.files[fileIndex];
  if (!file) return { error: "file index not found", status: 404 };
  const safeLimit = clamp(limit, 1, MAX_PAGE_LINES);
  const start = Math.min(Math.max(0, cursor), file.hunks.length);
  const end = Math.min(file.hunks.length, start + safeLimit);
  return {
    generation: index.generation,
    file: fileIndex,
    path: file.newPath ?? file.oldPath ?? "",
    returned: end - start,
    total: file.hunks.length,
    nextCursor: end < file.hunks.length ? end : null,
    hunks: file.hunks.slice(start, end),
  };
}

export function indexSlice(
  index: AgentDiffIndex,
  fileIndex: number,
  startRow = 0,
  maxLines = DEFAULT_SLICE_LINES,
  maxBytes = DEFAULT_MAX_BYTES,
  generation?: number,
): Viewport | { error: string; status: number } {
  if (generation !== undefined && generation !== index.generation) {
    return {
      error: `stale generation ${generation}; current generation is ${index.generation}`,
      status: 409,
    };
  }
  const file = index.files[fileIndex];
  if (!file) {
    return {
      generation: index.generation,
      fileIndex,
      startRow,
      nextRow: null,
      totalRows: 0,
      truncated: false,
      estimatedBytes: 0,
      rows: [],
    };
  }

  const lineBudget = clamp(maxLines, 1, MAX_PAGE_LINES);
  const byteBudget = clamp(maxBytes, 1, MAX_BODY_BYTES);
  const start = Math.min(Math.max(0, startRow), file.rowCount);
  const rows: ViewRow[] = [];
  let estimatedBytes = 0;
  let truncated = false;
  let cursor = start;

  while (cursor < file.rowCount && rows.length < lineBudget) {
    const row = file.rows[cursor];
    const cost = viewRowCost(row);
    if (estimatedBytes + cost > byteBudget && rows.length > 0) {
      truncated = true;
      break;
    }
    rows.push(row);
    estimatedBytes += cost;
    cursor++;
  }

  if (cursor < file.rowCount && rows.length >= lineBudget) {
    truncated = true;
  }

  return {
    generation: index.generation,
    fileIndex,
    startRow: start,
    nextRow: cursor < file.rowCount ? cursor : null,
    totalRows: file.rowCount,
    truncated,
    estimatedBytes,
    rows,
  };
}

export function indexSearch(
  index: AgentDiffIndex,
  query: string,
  fileStart = 0,
  rowStart = 0,
  limit = 100,
  maxBytes = DEFAULT_MAX_BYTES,
  generation?: number,
  path?: string,
): SearchPage | InspectScopeError {
  if (generation !== undefined && generation !== index.generation) {
    return {
      error: `stale generation ${generation}; current generation is ${index.generation}`,
      status: 409,
    };
  }

  let matcher: PathMatcher | undefined;
  if (path) {
    const compiled = compilePathspecGlob(path);
    if ("error" in compiled) return compiled;
    matcher = compiled;
  }

  const q = query.toLowerCase();
  if (!q) {
    return {
      generation: index.generation,
      hits: [],
      nextFile: null,
      nextRow: null,
      truncated: false,
      estimatedBytes: 0,
    };
  }
  const hitLimit = clamp(limit, 1, MAX_PAGE_LINES);
  const byteBudget = clamp(maxBytes, 1, MAX_BODY_BYTES);
  const hits: SearchHit[] = [];
  let estimatedBytes = 0;
  let truncated = false;
  let nextFile: number | null = null;
  let nextRow: number | null = null;

  outer: for (let fi = Math.max(0, fileStart); fi < index.files.length; fi++) {
    const file = index.files[fi];
    if (matcher && !fileMatchesPath(matcher, file.oldPath, file.newPath))
      continue;
    const path = file.newPath ?? file.oldPath ?? "";
    const pathMatch = path.toLowerCase().includes(q);
    const rowBegin = fi === fileStart ? Math.max(0, rowStart) : 0;

    for (let ri = rowBegin; ri < file.rows.length; ri++) {
      const row = file.rows[ri];
      let preview = "";
      let oldLineno: number | null = null;
      let newLineno: number | null = null;
      let matched = false;

      if (row.type === "fileHeader") {
        if (pathMatch && ri === 0) {
          preview = path;
          matched = true;
        }
      } else if (row.type === "hunkHeader") {
        const text = `@@ -${row.oldStart},${row.oldLines} +${row.newStart},${row.newLines} @@ ${row.heading}`;
        if (text.toLowerCase().includes(q)) {
          preview = text;
          matched = true;
        }
      } else if (row.type === "line") {
        if (row.content.toLowerCase().includes(q)) {
          preview = row.content;
          oldLineno = row.oldLineno;
          newLineno = row.newLineno;
          matched = true;
        }
      }

      if (!matched) continue;

      const cost = preview.length + path.length + 32;
      if (estimatedBytes + cost > byteBudget && hits.length > 0) {
        truncated = true;
        nextFile = fi;
        nextRow = ri;
        break outer;
      }
      hits.push({
        fileIndex: fi,
        path,
        row: ri,
        oldLineno,
        newLineno,
        preview: preview.slice(0, 400),
      });
      estimatedBytes += cost;
      if (hits.length >= hitLimit) {
        // Continue coordinates for the next hit after this one.
        const nr = ri + 1;
        if (nr < file.rows.length) {
          nextFile = fi;
          nextRow = nr;
        } else if (fi + 1 < index.files.length) {
          nextFile = fi + 1;
          nextRow = 0;
        }
        truncated = nextFile != null;
        break outer;
      }
    }
  }

  return {
    generation: index.generation,
    hits,
    nextFile,
    nextRow,
    truncated,
    estimatedBytes,
  };
}

function viewRowCost(row: ViewRow): number {
  switch (row.type) {
    case "fileHeader":
      return row.path.length + 32;
    case "hunkHeader":
      return row.heading.length + 48;
    case "line":
      return row.content.length + 16;
    case "noNewline":
      return 24;
  }
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Parse Git's file header, including core.quotePath-style C-quoted paths. */
function parseGitFileHeader(line: string): [string, string] | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const first = consumeGitToken(rest, 0);
    if (!first) return null;
    let cursor = first.next;
    while (cursor < rest.length && /\s/.test(rest[cursor])) cursor++;
    const second = consumeGitToken(rest, cursor);
    if (!second) return null;
    return [
      stripSidePrefix(decodeGitPath(first.token), "a/"),
      stripSidePrefix(decodeGitPath(second.token), "b/"),
    ];
  }

  // Match the TUI parser's heuristic for legal, unquoted spaces in paths.
  const separator = rest.lastIndexOf(" b/");
  if (separator < 0) return null;
  return [
    stripSidePrefix(rest.slice(0, separator), "a/"),
    stripSidePrefix(rest.slice(separator + 1), "b/"),
  ];
}

function consumeGitToken(
  input: string,
  start: number,
): { token: string; next: number } | null {
  if (input[start] !== '"') {
    const end = input.indexOf(" ", start);
    return {
      token: input.slice(start, end < 0 ? input.length : end),
      next: end < 0 ? input.length : end,
    };
  }
  let escaped = false;
  for (let i = start + 1; i < input.length; i++) {
    const char = input[i];
    if (!escaped && char === '"') {
      return { token: input.slice(start, i + 1), next: i + 1 };
    }
    if (!escaped && char === "\\") escaped = true;
    else escaped = false;
  }
  return null;
}

function stripSidePrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Decode the byte escapes emitted by Git for quoted pathnames. */
function decodeGitPath(raw: string): string {
  const input = raw.trim();
  if (!(input.startsWith('"') && input.endsWith('"'))) return input;
  const bytes: number[] = [];
  const pushText = (value: string) => bytes.push(...Buffer.from(value, "utf8"));

  for (let i = 1; i < input.length - 1; i++) {
    const char = input[i];
    if (char !== "\\") {
      const codePoint = input.codePointAt(i)!;
      pushText(String.fromCodePoint(codePoint));
      if (codePoint > 0xffff) i++;
      continue;
    }

    const escaped = input[++i];
    if (escaped == null) break;
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    if (escaped in simple) {
      bytes.push(simple[escaped]);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (
        octal.length < 3 &&
        i + 1 < input.length - 1 &&
        /[0-7]/.test(input[i + 1])
      ) {
        octal += input[++i];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    pushText(escaped);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Cache helper: rebuild only when patch fingerprint changes. */
export class AgentDiffIndexCache {
  private index: AgentDiffIndex | null = null;
  private fingerprint: string | null = null;

  getOrBuild(
    patch: string,
    complete = true,
    omittedPaths?: string[],
  ): AgentDiffIndex {
    const fp = createHash("sha256")
      .update(complete ? "1" : "0")
      .update("\0")
      .update((omittedPaths ?? []).join("\0"))
      .update("\0")
      .update(patch)
      .digest("base64url");
    if (this.index && this.fingerprint === fp) return this.index;
    this.index = buildAgentDiffIndex(patch, undefined, {
      complete,
      omittedPaths,
    });
    this.fingerprint = fp;
    return this.index;
  }

  clear(): void {
    this.index = null;
    this.fingerprint = null;
  }
}
