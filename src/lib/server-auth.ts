import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import {
  SESSION_TOKEN_COOKIE,
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_QUERY,
} from "./session-token.js";

/**
 * Per-session review API token transport:
 * - `SESSION_TOKEN_HEADER` — CLI / MCP.
 * - `SESSION_TOKEN_COOKIE` — browser UI (HttpOnly).
 * - `SESSION_TOKEN_QUERY` — SSE `/api/live` only (`EventSource` cannot send headers).
 */
export { SESSION_TOKEN_HEADER, SESSION_TOKEN_QUERY, SESSION_TOKEN_COOKIE };

export interface ServerAuthConfig {
  bindHost: string;
  authToken: string | null;
  /** When true, `/api/*` routes accept requests without a token (LAN exposure only). */
  insecureNoAuth?: boolean;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  )
    return true;
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const value = Number(part);
      return value >= 0 && value <= 255;
    })
  );
}

export function isWildcardBindHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::";
}

function requestHostHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1
      ? trimmed.toLowerCase()
      : trimmed.slice(1, end).toLowerCase();
  }
  return trimmed.split(":")[0].toLowerCase();
}

/** Reject non-loopback Host headers when the server binds loopback (DNS rebinding guard). */
export function isAllowedRequestHost(
  hostHeader: string | undefined,
  bindHost: string,
): boolean {
  if (!isLoopbackHost(bindHost)) return true;
  const host = requestHostHeader(hostHeader);
  if (!host) return true;
  return isLoopbackHost(host);
}

/**
 * CSRF Origin check. Same-origin is always allowed. A loopback-bound server
 * also accepts another loopback http(s) origin so the Vite client
 * (`localhost:5173`) can proxy `/api` to the backend (`127.0.0.1:3433`).
 * Off-loopback Origins still have to match the request URL exactly.
 */
export function isAllowedRequestOrigin(
  originHeader: string | undefined,
  requestUrl: string,
  bindHost: string,
): boolean {
  if (originHeader === undefined) return true;
  let origin: URL;
  let request: URL;
  try {
    origin = new URL(originHeader);
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  if (origin.origin === request.origin) return true;
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  return isLoopbackHost(origin.hostname) && isLoopbackHost(bindHost);
}

/**
 * Read the session token from the header or HttpOnly cookie.
 *
 * The query param is only honored when `allowQuery` is set, which is reserved
 * for the SSE `/api/live` endpoint (`EventSource` cannot send headers). Tokens
 * in URLs leak into history, referrers, and logs, so every other API route
 * requires the header or cookie.
 */
export function readSessionToken(
  c: Context,
  opts?: { allowQuery?: boolean },
): string | null {
  const header = c.req.header(SESSION_TOKEN_HEADER);
  if (header) return header;
  const cookie = getCookie(c, SESSION_TOKEN_COOKIE);
  if (cookie) return cookie;
  if (opts?.allowQuery) return c.req.query(SESSION_TOKEN_QUERY) || null;
  return null;
}

/** Constant-time comparison of a provided token against the expected session token. */
function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** `Set-Cookie` value for the review session token (loopback http — no Secure). */
export function buildSessionTokenSetCookieValue(token: string): string {
  return `${SESSION_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`;
}

/** Escape a session token for embedding in a double-quoted JS string literal. */
function escapeTokenForJsString(token: string): string {
  return token.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Inject `window.__DIFFING_SESSION_TOKEN__` into served HTML so deep links work without `?token=`. */
export function injectSessionTokenIntoHtml(
  html: string,
  authToken: string | null,
): string {
  if (!authToken) return html;
  const script = `<script>window.__DIFFING_SESSION_TOKEN__="${escapeTokenForJsString(authToken)}";</script>`;
  if (html.includes("</head>"))
    return html.replace("</head>", `${script}</head>`);
  return `${script}${html}`;
}

function setSecurityHeaders(c: Context): void {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
}

export function createServerAuthMiddleware(config: ServerAuthConfig) {
  return async (c: Context, next: Next) => {
    setSecurityHeaders(c);

    // Bootstrap HTML carries API authority too: rebinding/origin checks must
    // happen before serving it, not just before handling API requests.
    if (!isAllowedRequestHost(c.req.header("host"), config.bindHost)) {
      return c.json(
        { error: "request Host header is not allowed for this bind address" },
        403,
      );
    }
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      try {
        new URL(c.req.url);
      } catch {
        return c.json({ error: "invalid request URL" }, 400);
      }
      if (!isAllowedRequestOrigin(origin, c.req.url, config.bindHost)) {
        return c.json({ error: "request Origin is not allowed" }, 403);
      }
    }

    // Only loopback browsers may bootstrap without a credential. An exposed
    // server must authenticate HTML/deep links as well as its API, otherwise
    // anyone can retrieve the credential injected into the page.
    const requiresToken =
      c.req.path.startsWith("/api/") || !isLoopbackHost(config.bindHost);
    if (requiresToken && !config.insecureNoAuth) {
      const allowQuery = c.req.path === "/api/live";
      const provided = readSessionToken(c, { allowQuery });
      if (!config.authToken || !tokenMatches(provided, config.authToken)) {
        return c.json(
          { error: "invalid or missing review session token" },
          401,
        );
      }
    }

    await next();
    // Raw Response objects (HTML, attachments) bypass prepared Hono headers.
    setSecurityHeaders(c);
  };
}
