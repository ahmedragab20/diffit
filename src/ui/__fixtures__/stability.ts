const nativeFetch = window.fetch.bind(window);
const comments: Array<Record<string, unknown>> = [];
let failNextComment = false;
let revision = 1;
let commentSequence = 0;
let settings: Record<string, unknown> = {
  autoCollapseLineThreshold: 0,
  haptics: false,
  sounds: false,
};
const eventSources = new Set<FixtureEventSource>();
let errorCount = 0;
let rejectionCount = 0;
let lastError = "";

window.addEventListener("error", (event) => {
  errorCount += 1;
  lastError =
    event.error instanceof Error
      ? (event.error.stack ?? event.message).split("\n").slice(0, 4).join("\n")
      : event.message;
});
window.addEventListener("unhandledrejection", () => {
  rejectionCount += 1;
});

class FixtureEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = FixtureEventSource.CONNECTING;

  constructor(url: string) {
    super();
    this.url = url;
    eventSources.add(this);
    queueMicrotask(() => {
      if (this.readyState !== FixtureEventSource.CLOSED) {
        this.readyState = FixtureEventSource.OPEN;
        this.dispatchEvent(new Event("open"));
      }
    });
  }

  close() {
    this.readyState = FixtureEventSource.CLOSED;
    eventSources.delete(this);
  }
}

// SAFETY: the fixture implements the EventSource event API used by live.ts; no connection reaches a server.
window.EventSource = FixtureEventSource as unknown as typeof EventSource;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emit(name: string, data = "") {
  for (const source of eventSources) {
    if (source.readyState === FixtureEventSource.OPEN) {
      source.dispatchEvent(new MessageEvent(name, { data }));
    }
  }
}

function patchForCurrentRevision(): string {
  const files: string[] = [];
  for (let file = 0; file < 80; file += 1) {
    const path = `src/fixture-${String(file).padStart(3, "0")}.ts`;
    const count = file === 0 ? 6000 : 120;
    const index = revision === 1 ? "1111111..2222222" : "2222222..3333333";
    const lines = [
      `diff --git a/${path} b/${path}`,
      `index ${index} 100644`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${count} +1,${count} @@`,
    ];
    for (let line = 1; line <= count; line += 1) {
      lines.push(`-const value${line}=0`);
      lines.push(`+const value${line}=${revision}`);
    }
    files.push(lines.join("\n"));
  }
  return files.join("\n") + "\n";
}

async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(
    input instanceof Request ? input : new URL(input.toString(), location.href),
    init,
  );
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    return Promise.reject(error);
  }
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const parsed =
    method === "GET" || method === "HEAD"
      ? {}
      : ((await request
          .clone()
          .json()
          .catch(() => ({}))) as Record<string, unknown>);

  if (path === "/api/diff" && method === "GET") {
    return jsonResponse({
      patch: patchForCurrentRevision(),
      repoName: "stability-fixture",
      branch: "fixture",
      customMode: false,
      binaryFiles: [],
      tabSizeMap: {},
      untrackedFiles: [],
    });
  }
  if (path === "/api/comments" && method === "GET")
    return jsonResponse(comments);
  if (path === "/api/comments" && method === "POST") {
    if (failNextComment) {
      failNextComment = false;
      return jsonResponse({ error: "fixture comment failure" }, 500);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const comment = {
      id: `fixture-comment-${++commentSequence}`,
      createdAt: Date.now(),
      status: "open",
      replies: [],
      ...parsed,
    };
    comments.push(comment);
    emit("comments");
    return jsonResponse(comment);
  }
  const commentMatch = /^\/api\/comments\/([^/]+)(?:\/replies\/([^/]+))?$/.exec(
    path,
  );
  if (commentMatch && (method === "PUT" || method === "DELETE")) {
    const comment = comments.find((item) => item.id === commentMatch[1]);
    if (!comment) return jsonResponse({ error: "not found" }, 404);
    if (method === "DELETE") comments.splice(comments.indexOf(comment), 1);
    else Object.assign(comment, parsed);
    emit("comments");
    return jsonResponse(method === "DELETE" ? {} : comment);
  }
  if (path === "/api/review/status" && method === "GET")
    return jsonResponse({ round: 0, waiters: 0, lastSentAt: null });
  if (path === "/api/gh/session" && method === "GET")
    return jsonResponse({ prMode: false });
  if (path === "/api/settings" && method === "GET")
    return jsonResponse(settings);
  if (path === "/api/settings" && method === "PUT") {
    settings = { ...settings, ...parsed };
    return jsonResponse(settings);
  }
  if (path === "/api/ui-state" && method === "GET") return jsonResponse({});
  if (path === "/api/ui-state" && method === "PUT") return jsonResponse({});
  if (path === "/api/viewed" && method === "GET") return jsonResponse([]);
  if (path === "/api/viewed" && method === "PUT") return jsonResponse({});
  if (path === "/api/merge-status" && method === "GET")
    return jsonResponse({ inMerge: false, conflicts: [] });
  if (path === "/api/files" && method === "GET")
    return jsonResponse({ items: [] });
  if (path.startsWith("/api/") && method === "GET") return jsonResponse({});
  if (path.startsWith("/api/"))
    return jsonResponse({ error: "fixture unsupported" }, 400);
  return nativeFetch(input, init);
}

window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    location.href,
  );
  return url.pathname.startsWith("/api/")
    ? apiFetch(input, init)
    : nativeFetch(input, init);
}) as typeof window.fetch;

function deepActiveElement(
  root: Document | ShadowRoot = document,
): Element | null {
  const active = root.activeElement;
  if (!active) return null;
  const shadow = (active as HTMLElement).shadowRoot;
  return shadow ? (deepActiveElement(shadow) ?? active) : active;
}

let longestTask = 0;
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longestTask = Math.max(longestTask, entry.duration);
  }).observe({ type: "longtask", buffered: true });
} catch {
  /* optional browser API */
}

// Fixture controls simulate remote events without taking focus from a draft.
document
  .getElementById("fixture-panel")!
  .addEventListener("pointerdown", (event) => event.preventDefault());

function sampleMetrics() {
  let rows = 0;
  const visit = (root: Document | ShadowRoot) => {
    rows += root.querySelectorAll("[data-line]").length;
    for (const element of root.querySelectorAll("*"))
      if ((element as HTMLElement).shadowRoot)
        visit((element as HTMLElement).shadowRoot!);
  };
  visit(document);
  const focused = deepActiveElement();
  const output = document.getElementById("fixture-metrics")!;
  output.textContent = `rows: ${rows}\nscrollY: ${Math.round(window.scrollY)}\nfocus: ${focused?.tagName.toLowerCase() ?? "none"}${focused?.getAttribute("aria-label") ? ` (${focused.getAttribute("aria-label")})` : ""}\ncomments: ${comments.length}\nerrors: ${errorCount}\nunhandledrejections: ${rejectionCount}\nlongest longtask: ${longestTask.toFixed(1)}ms\nlast error: ${lastError}`;
}

document.getElementById("fixture-refresh")!.addEventListener("click", () => {
  revision = revision === 1 ? 2 : 1;
  emit("change");
});
document
  .getElementById("fixture-remote")!
  .addEventListener("click", async () => {
    await fetch("/api/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath: "src/fixture-000.ts",
        side: "additions",
        lineNumber: 10,
        lineContent: "const value10=1",
        body: "Remote fixture comment",
      }),
    });
  });
document.getElementById("fixture-fail")!.addEventListener("click", () => {
  failNextComment = true;
});
document
  .getElementById("fixture-sample")!
  .addEventListener("click", sampleMetrics);

await import("../main");
export {};
