// @vitest-environment node
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isPrDiffTooLargeError,
  fetchPrDiffViaFilesApi,
  fetchPrMetadataViaGh,
} from "../lib/github.js";

const resolved = { owner: "acme", repo: "widget", pullNumber: 42, ref: "42" };

const FILES_PAYLOAD = [
  {
    filename: "src/added.ts",
    status: "added",
    additions: 2,
    deletions: 0,
    patch: "@@ -0,0 +1,2 @@\n+new\n+file",
    sha: "aaa",
  },
  {
    filename: "src/gone.ts",
    status: "removed",
    additions: 0,
    deletions: 1,
    patch: "@@ -1 +0,0 @@\n-old",
    sha: "bbb",
  },
  {
    filename: "src/changed.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
    sha: "ccc",
  },
  {
    filename: "src/new.ts",
    previous_filename: "src/old.ts",
    status: "renamed",
    additions: 0,
    deletions: 0,
    patch: "@@ -1,2 +1,2 @@",
    sha: "ddd",
  },
  {
    filename: "bin/blob.png",
    status: "modified",
    additions: 0,
    deletions: 0,
    patch: null,
    sha: "eee",
  },
];

const EXPECTED_DIFF =
  "diff --git a/src/added.ts b/src/added.ts\n" +
  "new file mode 100644\n" +
  "--- /dev/null\n" +
  "+++ b/src/added.ts\n" +
  "@@ -0,0 +1,2 @@\n" +
  "+new\n" +
  "+file\n" +
  "diff --git a/src/gone.ts b/src/gone.ts\n" +
  "deleted file mode 100644\n" +
  "--- a/src/gone.ts\n" +
  "+++ /dev/null\n" +
  "@@ -1 +0,0 @@\n" +
  "-old\n" +
  "diff --git a/src/changed.ts b/src/changed.ts\n" +
  "--- a/src/changed.ts\n" +
  "+++ b/src/changed.ts\n" +
  "@@ -1 +1 @@\n" +
  "-old\n" +
  "+new\n" +
  "diff --git a/src/old.ts b/src/new.ts\n" +
  "--- a/src/old.ts\n" +
  "+++ b/src/new.ts\n" +
  "@@ -1,2 +1,2 @@\n" +
  "diff --git a/bin/blob.png b/bin/blob.png\n" +
  "Binary files a/bin/blob.png and b/bin/blob.png differ";

// gh metadata payload returned by `pr view` (snake_case, as gh emits it).
const META_PAYLOAD = {
  number: 42,
  title: "T",
  url: "https://github.com/acme/widget/pull/42",
  author: { login: "octocat", avatarUrl: "https://x.test/a.png" },
  baseRefOid: "b".repeat(40),
  headRefOid: "h".repeat(40),
  baseRefName: "main",
  headRefName: "feat",
  additions: 5,
  deletions: 3,
  changedFiles: 5,
  headRepositoryOwner: { login: "acme" },
  headRepository: { name: "widget" },
};

// Shared `gh`-stub plumbing: write the stub to a temp dir, prepend the dir to
// PATH, point GH_CALL_LOG at a fresh file, and record every invocation as a
// JSON array of argv per line.
let binDir = "";
let callLogPath = "";
let originalPath: string | undefined;
let ghInstalled = false;

async function installGhStub(script: string): Promise<void> {
  binDir = await mkdtemp(join(tmpdir(), "diffing-gh-fallback-"));
  callLogPath = join(binDir, "calls.jsonl");
  originalPath = process.env.PATH;
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.GH_CALL_LOG = callLogPath;
  ghInstalled = true;
}

async function readCallLog(): Promise<string[][]> {
  const raw = await readFile(callLogPath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

afterEach(async () => {
  if (ghInstalled) {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    delete process.env.GH_CALL_LOG;
    ghInstalled = false;
  }
  if (binDir) await rm(binDir, { recursive: true, force: true });
  binDir = "";
  originalPath = undefined;
});

describe("isPrDiffTooLargeError", () => {
  it("returns true when stderr carries the full HTTP 406 too-large message", () => {
    expect(
      isPrDiffTooLargeError({
        stderr:
          "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (https://github.foodics.com/api/v3/repos/pay/pay/pulls/7811)\nPullRequest.diff too large",
      }),
    ).toBe(true);
  });

  it("returns true when stderr mentions PullRequest.diff too large", () => {
    expect(
      isPrDiffTooLargeError({ stderr: "PullRequest.diff too large" }),
    ).toBe(true);
  });

  it("returns true when only the message field mentions PullRequest.diff too large", () => {
    expect(
      isPrDiffTooLargeError({ message: "PullRequest.diff too large" }),
    ).toBe(true);
  });

  it("returns true when stderr matches without the PullRequest token", () => {
    expect(
      isPrDiffTooLargeError({
        stderr: "exceeded the maximum number of files (300)",
      }),
    ).toBe(true);
  });

  it("returns false for a plain HTTP 404 error", () => {
    expect(
      isPrDiffTooLargeError({
        stderr: "HTTP 404: Not Found",
        message: "HTTP 404: Not Found",
      }),
    ).toBe(false);
  });

  it("returns false for a DNS failure", () => {
    expect(
      isPrDiffTooLargeError({ message: "getaddrinfo ENOTFOUND github.com" }),
    ).toBe(false);
  });

  it("returns false for an empty error object", () => {
    expect(isPrDiffTooLargeError({})).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPrDiffTooLargeError(undefined)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isPrDiffTooLargeError(null)).toBe(false);
  });
});

describe("fetchPrDiffViaFilesApi", () => {
  beforeEach(async () => {
    const stub = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2)",
      "require('node:fs').appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n')",
      "if (args.join(' ').includes('pulls/42/files')) {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify(FILES_PAYLOAD))})`,
      "  process.exit(0)",
      "}",
      "process.exit(1)",
    ].join("\n");
    await installGhStub(stub);
  });

  it("assembles the unified diff from the files API payload", async () => {
    const result = await fetchPrDiffViaFilesApi(resolved);
    expect(result.diff).toBe(EXPECTED_DIFF);
    expect(result.listedFiles).toBe(5);
    expect(result.omittedPatches).toBe(1);
  });

  it("requests pagination from the files API", async () => {
    await fetchPrDiffViaFilesApi(resolved);
    const calls = await readCallLog();
    expect(calls.some((argv) => argv.includes("--paginate"))).toBe(true);
  });

  it("requests 100 files per page from the files API", async () => {
    await fetchPrDiffViaFilesApi(resolved);
    const calls = await readCallLog();
    expect(
      calls.some((argv) =>
        argv.join(" ").match(/pulls\/42\/files\?per_page=100/),
      ),
    ).toBe(true);
  });
});

describe("fetchPrMetadataViaGh fallback (integration)", () => {
  beforeEach(async () => {
    const stub = [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2)",
      "require('node:fs').appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n')",
      "const joined = args.join(' ')",
      "if (joined.includes('pr view')) {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify(META_PAYLOAD))})`,
      "  process.exit(0)",
      "}",
      "if (joined.includes('pr diff')) {",
      `  process.stderr.write(${JSON.stringify("could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.\nPullRequest.diff too large")})`,
      "  process.exit(1)",
      "}",
      "if (joined.includes('pulls/42/reviews')) {",
      "  process.stdout.write(JSON.stringify([]))",
      "  process.exit(0)",
      "}",
      "if (joined.includes('pulls/42/comments?per_page=100')) {",
      "  process.stdout.write(JSON.stringify([]))",
      "  process.exit(0)",
      "}",
      "if (joined.includes('pulls/42/files?per_page=100')) {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify(FILES_PAYLOAD))})`,
      "  process.exit(0)",
      "}",
      "process.stderr.write('unexpected gh call: ' + joined)",
      "process.exit(1)",
    ].join("\n");
    await installGhStub(stub);
  });

  it("resolves instead of throwing when the diff is too large", async () => {
    await expect(fetchPrMetadataViaGh(resolved)).resolves.toBeDefined();
  });

  it("returns the files-API-assembled diff when pr diff is too large", async () => {
    const meta = await fetchPrMetadataViaGh(resolved);
    expect(meta.diff).toBe(EXPECTED_DIFF);
  });

  it("preserves the pr view metadata through the fallback", async () => {
    const meta = await fetchPrMetadataViaGh(resolved);
    expect(meta).toMatchObject({
      number: 42,
      additions: 5,
      deletions: 3,
      changedFiles: 5,
    });
  });

  it("still loads existing reviews and comments in fallback mode", async () => {
    const meta = await fetchPrMetadataViaGh(resolved);
    expect(meta.existingReviews).toEqual([]);
    expect(meta.existingComments).toEqual([]);
  });

  it("attempts the fast path before falling back to the files API", async () => {
    await fetchPrMetadataViaGh(resolved);
    const calls = await readCallLog();
    expect(calls.some((argv) => argv.join(" ").includes("pr diff"))).toBe(true);
    expect(
      calls.some((argv) => argv.join(" ").includes("pulls/42/files")),
    ).toBe(true);
  });
});
