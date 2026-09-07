/**
 * GitHub PR author/reviewer mutations and conversation fetchers that sit
 * beside the core review-submit transport in github.ts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  execWithInput,
  ghHostnameArgs,
  githubApiBase,
  parseGhPaginatedJson,
  type GhReviewComment,
  type ResolvedPr,
} from "./github.js";
import { applySuggestionToContent } from "./apply-suggestion.js";
import {
  issueCommentFromGh,
  timelineEventFromGh,
} from "./pr-timeline.js";
import type {
  PrIssueComment,
  PrTimelineEvent,
} from "./pr-session.js";

const execFileAsync = promisify(execFile);
const GH_REQUEST_TIMEOUT_MS = 45_000;

export interface GhActionResult {
  ok: boolean;
  error?: string;
  htmlUrl?: string;
  sha?: string;
}

async function ghApiJson(
  resolved: ResolvedPr,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<{ ok: true; json: any; stdout: string } | { ok: false; error: string }> {
  try {
    if (body !== undefined) {
      const { stdout } = await execWithInput(
        "gh",
        [
          "api",
          ...ghHostnameArgs(resolved),
          "--method",
          method,
          endpoint,
          "-H",
          "Accept: application/vnd.github+json",
          "--input",
          "-",
        ],
        JSON.stringify(body),
      );
      return { ok: true, json: stdout.trim() ? JSON.parse(stdout) : {}, stdout };
    }
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api",
        ...ghHostnameArgs(resolved),
        "--method",
        method,
        endpoint,
        "-H",
        "Accept: application/vnd.github+json",
      ],
      { encoding: "utf-8", timeout: GH_REQUEST_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 },
    );
    return { ok: true, json: stdout.trim() ? JSON.parse(stdout) : {}, stdout };
  } catch (error: any) {
    return { ok: false, error: githubActionError(error) };
  }
}

function githubActionError(error: any): string {
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  try {
    const parsed = JSON.parse(stdout) as {
      message?: string;
      errors?: Array<{ message?: string }>;
    };
    if (parsed.message) return parsed.message;
    const messages = parsed.errors?.map((item) => item.message).filter(Boolean);
    if (messages?.length) return messages.join("; ");
  } catch {
    // fall through
  }
  return String(error?.stderr || error?.message || "GitHub request failed")
    .trim()
    .slice(0, 500);
}

export async function fetchIssueCommentsViaGh(
  resolved: ResolvedPr,
): Promise<PrIssueComment[]> {
  const endpoint = `repos/${resolved.owner}/${resolved.repo}/issues/${resolved.pullNumber}/comments?per_page=100`;
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      ...ghHostnameArgs(resolved),
      endpoint,
      "--paginate",
      "--slurp",
      "-H",
      "Accept: application/vnd.github+json",
    ],
    { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024, timeout: GH_REQUEST_TIMEOUT_MS },
  );
  return parseGhPaginatedJson(stdout)
    .map(issueCommentFromGh)
    .filter((item): item is PrIssueComment => item != null);
}

export async function fetchPrTimelineEventsViaGh(
  resolved: ResolvedPr,
): Promise<PrTimelineEvent[]> {
  const endpoint = `repos/${resolved.owner}/${resolved.repo}/issues/${resolved.pullNumber}/timeline?per_page=100`;
  const { stdout } = await execFileAsync(
    "gh",
    [
      "api",
      ...ghHostnameArgs(resolved),
      endpoint,
      "--paginate",
      "--slurp",
      "-H",
      "Accept: application/vnd.github+json",
    ],
    { encoding: "utf-8", maxBuffer: 20 * 1024 * 1024, timeout: GH_REQUEST_TIMEOUT_MS },
  );
  const events: PrTimelineEvent[] = [];
  for (const raw of parseGhPaginatedJson(stdout)) {
    const item = timelineEventFromGh(raw);
    if (item) events.push(item);
    if (events.length >= 200) break;
  }
  return events;
}

export async function fetchPrConversationViaGh(resolved: ResolvedPr): Promise<{
  issueComments: PrIssueComment[];
  timelineEvents: PrTimelineEvent[];
}> {
  const empty = { issueComments: [] as PrIssueComment[], timelineEvents: [] as PrTimelineEvent[] };
  try {
    const [issueComments, timelineEvents] = await Promise.all([
      fetchIssueCommentsViaGh(resolved),
      fetchPrTimelineEventsViaGh(resolved),
    ]);
    return { issueComments, timelineEvents };
  } catch {
    return empty;
  }
}

export function pendingReviewCommentPayload(comment: GhReviewComment): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    body: comment.body,
    path: comment.path,
    line: comment.line,
    side: comment.side,
  };
  if (comment.start_line != null) payload.start_line = comment.start_line;
  if (comment.start_side) payload.start_side = comment.start_side;
  return payload;
}

export async function addCommentsToPendingReviewViaGh(
  resolved: ResolvedPr,
  reviewId: number,
  comments: GhReviewComment[],
): Promise<{ ok: boolean; attached: number; failed: number; error?: string }> {
  let attached = 0;
  let failed = 0;
  let lastError: string | undefined;
  for (const comment of comments) {
    const result = await ghApiJson(
      resolved,
      "POST",
      `repos/${resolved.owner}/${resolved.repo}/pulls/${resolved.pullNumber}/reviews/${reviewId}/comments`,
      pendingReviewCommentPayload(comment),
    );
    if (result.ok) attached += 1;
    else {
      failed += 1;
      lastError = result.error;
    }
  }
  if (comments.length > 0 && attached === 0) {
    return { ok: false, attached, failed, error: lastError ?? "Failed to attach comments" };
  }
  return { ok: true, attached, failed, error: lastError };
}

export async function updatePrMetadataViaGh(
  resolved: ResolvedPr,
  fields: { title?: string; body?: string },
): Promise<GhActionResult> {
  const payload: Record<string, string> = {};
  if (typeof fields.title === "string") payload.title = fields.title;
  if (typeof fields.body === "string") payload.body = fields.body;
  if (Object.keys(payload).length === 0) {
    return { ok: false, error: "title or body is required" };
  }
  const result = await ghApiJson(
    resolved,
    "PATCH",
    `repos/${resolved.owner}/${resolved.repo}/pulls/${resolved.pullNumber}`,
    payload,
  );
  if (!result.ok) return result;
  return { ok: true, htmlUrl: result.json.html_url };
}

export async function setPrOpenStateViaGh(
  resolved: ResolvedPr,
  state: "open" | "closed",
): Promise<GhActionResult> {
  const result = await ghApiJson(
    resolved,
    "PATCH",
    `repos/${resolved.owner}/${resolved.repo}/pulls/${resolved.pullNumber}`,
    { state },
  );
  if (!result.ok) return result;
  return { ok: true, htmlUrl: result.json.html_url };
}

export async function mergePullRequestViaGh(
  resolved: ResolvedPr,
  input: {
    method: "merge" | "squash" | "rebase";
    expectedHeadSha: string;
    commitTitle?: string;
    commitMessage?: string;
  },
): Promise<GhActionResult> {
  const result = await ghApiJson(
    resolved,
    "PUT",
    `repos/${resolved.owner}/${resolved.repo}/pulls/${resolved.pullNumber}/merge`,
    {
      merge_method: input.method,
      sha: input.expectedHeadSha,
      ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
      ...(input.commitMessage ? { commit_message: input.commitMessage } : {}),
    },
  );
  if (!result.ok) return result;
  return {
    ok: true,
    sha: typeof result.json.sha === "string" ? result.json.sha : undefined,
  };
}

export async function fetchRefShaViaGh(
  resolved: Pick<ResolvedPr, "owner" | "repo" | "host">,
  refName: string,
): Promise<string | null> {
  const encoded = refName.replace(/^refs\/heads\//, "");
  const result = await ghApiJson(
    resolved as ResolvedPr,
    "GET",
    `repos/${resolved.owner}/${resolved.repo}/git/ref/heads/${encodeURIComponent(encoded)}`,
  );
  if (!result.ok) return null;
  const sha = result.json?.object?.sha;
  return typeof sha === "string" ? sha : null;
}

export async function applyPrSuggestionViaGh(input: {
  resolved: ResolvedPr;
  path: string;
  body: string;
  line: number;
  startLine?: number | null;
  side: "LEFT" | "RIGHT" | null;
  expectedHeadSha: string;
  headRefName: string;
  headOwner?: string;
  headRepo?: string;
  commitMessage?: string;
}): Promise<GhActionResult> {
  if (input.side === "LEFT") {
    return {
      ok: false,
      error: "Suggestions can only be applied to added or modified lines",
    };
  }
  const owner = input.headOwner || input.resolved.owner;
  const repo = input.headRepo || input.resolved.repo;
  const headResolved: ResolvedPr = {
    ...input.resolved,
    owner,
    repo,
  };
  const headSha = await fetchRefShaViaGh(headResolved, input.headRefName);
  if (headSha && headSha !== input.expectedHeadSha) {
    return {
      ok: false,
      error: `Head moved (expected ${input.expectedHeadSha.slice(0, 7)}, got ${headSha.slice(0, 7)})`,
    };
  }

  const encodedPath = input.path
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const file = await ghApiJson(
    headResolved,
    "GET",
    `repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(input.expectedHeadSha)}`,
  );
  if (!file.ok) return file;
  const blobSha = file.json?.sha;
  const encoding = file.json?.encoding;
  const rawContent = file.json?.content;
  if (typeof blobSha !== "string" || typeof rawContent !== "string") {
    return { ok: false, error: "GitHub did not return file contents for that path" };
  }
  const content =
    encoding === "base64"
      ? Buffer.from(rawContent.replace(/\n/g, ""), "base64").toString("utf-8")
      : String(rawContent);
  const applied = applySuggestionToContent({
    content,
    lineNumber: input.line,
    startLineNumber: input.startLine ?? undefined,
    body: input.body,
    side: "additions",
  });
  if (!applied.ok) return { ok: false, error: applied.error };

  const put = await ghApiJson(
    headResolved,
    "PUT",
    `repos/${owner}/${repo}/contents/${encodedPath}`,
    {
      message:
        input.commitMessage ??
        `Apply suggestion to ${input.path}`,
      content: Buffer.from(applied.content, "utf-8").toString("base64"),
      sha: blobSha,
      branch: input.headRefName,
    },
  );
  if (!put.ok) return put;
  const sha = put.json?.commit?.sha;
  return { ok: true, sha: typeof sha === "string" ? sha : undefined };
}

/** Token-path fallback used when `gh` is unavailable (same hosts as review submit). */
export async function githubRestJson(
  resolved: ResolvedPr,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; json: any } | { ok: false; error: string }> {
  const url = `${githubApiBase(resolved.host)}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(GH_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "diffing-cli",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      return {
        ok: false,
        error:
          (typeof json.message === "string" && json.message) ||
          `HTTP ${res.status}: ${text.slice(0, 500)}`,
      };
    }
    return { ok: true, json };
  } catch (error: any) {
    return { ok: false, error: error?.message || "Network error" };
  }
}
