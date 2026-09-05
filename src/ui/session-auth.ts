import {
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_QUERY,
} from "../lib/session-token.js";

const SESSION_STORAGE_KEY = "diffing-session-token";

declare global {
  interface Window {
    __DIFFING_SESSION_TOKEN__?: string;
  }
}

let sessionToken: string | null = null;
let installed = false;

function readTokenFromSessionStorage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function resolveSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.__DIFFING_SESSION_TOKEN__ ?? readTokenFromSessionStorage();
}

function persistSessionToken(token: string): void {
  sessionToken = token;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Strip legacy `?token=` from the address bar; persist token for fetch headers. */
function migrateTokenFromAddressBar(): void {
  if (typeof window === "undefined") return;
  let parsed: URL;
  try {
    parsed = new URL(window.location.href);
  } catch {
    return;
  }
  const fromUrl = parsed.searchParams.get(SESSION_TOKEN_QUERY);
  if (!fromUrl) return;
  persistSessionToken(fromUrl);
  parsed.searchParams.delete(SESSION_TOKEN_QUERY);
  const search = parsed.searchParams.toString();
  const clean = `${parsed.pathname}${search ? `?${search}` : ""}${parsed.hash}`;
  window.history.replaceState(null, "", clean);
}

function stripTokenFromPath(path: string): string {
  try {
    const parsed = new URL(path, window.location.origin);
    parsed.searchParams.delete(SESSION_TOKEN_QUERY);
    const search = parsed.searchParams.toString();
    return `${parsed.pathname}${search ? `?${search}` : ""}${parsed.hash}`;
  } catch {
    return path;
  }
}

/** Legacy helper — browseable URLs never include `?token=`. */
export function sessionTokenQuerySuffix(): string {
  return "";
}

/** Normalize a client route path (strip legacy `?token=` if present). */
export function withSessionTokenPath(path: string): string {
  return stripTokenFromPath(path);
}

/** Attach the review session token to fetch (header + same-origin cookie). */
export function installSessionAuth(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  migrateTokenFromAddressBar();
  const resolved = resolveSessionToken();
  if (resolved) persistSessionToken(resolved);
  if (!sessionToken) return;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    let target: URL;
    try {
      target = new URL(url, window.location.href);
    } catch {
      return originalFetch(input, init);
    }
    if (
      target.origin !== window.location.origin ||
      !target.pathname.startsWith("/api/")
    ) {
      return originalFetch(input, init);
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(SESSION_TOKEN_HEADER, sessionToken!);
    return originalFetch(input, { ...init, headers });
  };
}

/**
 * URL for the shared `/api/live` SSE bus.
 *
 * `EventSource` cannot send custom headers, so the session token cannot ride
 * the same header channel as `fetch`. Production pages get an HttpOnly cookie
 * from the backend's HTML response, but dev-mode pages (vite) and any browser
 * that rejects the cookie would land on a 401 and never receive `change`
 * events — which is exactly the "diff is stale until reload" symptom. The
 * server accepts the token as a query param, so attach it here when one is
 * known. The URL is only used for the background SSE request, never for
 * navigation, so it never enters history or the address bar.
 */
export function liveEventSourceUrl(): string {
  const token = resolveSessionToken();
  return token
    ? `/api/live?${SESSION_TOKEN_QUERY}=${encodeURIComponent(token)}`
    : "/api/live";
}
