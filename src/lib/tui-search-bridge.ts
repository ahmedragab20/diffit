import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { getFileContent } from "./git.js";
import { NativeFsError } from "./native-fs.js";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

class BridgeRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}

export interface TuiSearchBridge {
  endpoint: string;
  capability: string;
  close(): Promise<void>;
}

type SearchBody = {
  scope?: "all" | "files" | "text" | "symbols";
  query?: string;
  limit?: number;
  regex?: boolean;
  changedPaths?: string[];
};

type PreviewBody = {
  path?: string;
};

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  response.end(body);
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES)
      throw new BridgeRequestError(413, "request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeRequestError(400, "request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeRequestError(400, "request body must be an object");
  }
  return value as Record<string, unknown>;
}

async function runSearch(body: SearchBody): Promise<unknown> {
  // Importing the native fff binding opens its repository databases. Keep
  // that work off the viewer's startup path and pay for it only when the
  // first repository search is actually requested.
  const { searchAll, searchContent, searchFiles, searchSymbols } = await import(
    "./search.js"
  );
  const scope = body.scope ?? "all";
  const query = typeof body.query === "string" ? body.query : "";
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const paths = Array.isArray(body.changedPaths)
    ? body.changedPaths.filter(
        (path): path is string => typeof path === "string",
      )
    : undefined;

  if (scope === "text")
    return searchContent(query, { limit, regex: !!body.regex, paths });
  if (scope === "symbols") return searchSymbols(query, { limit, paths });
  if (scope === "files") return searchFiles(query, { limit, paths });
  return searchAll(query, { limit, regex: !!body.regex, paths });
}

export async function loadTuiPreview(body: PreviewBody): Promise<unknown> {
  if (typeof body.path !== "string" || !body.path) {
    throw new BridgeRequestError(400, "preview path is required");
  }
  const buffer = await getFileContent(body.path, "new");
  if (!buffer)
    return {
      path: body.path,
      content: "",
      missing: true,
      binary: false,
      truncated: false,
    };

  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) {
    return {
      path: body.path,
      content: "",
      missing: false,
      binary: true,
      truncated: false,
    };
  }
  const truncated = buffer.length > MAX_PREVIEW_BYTES;
  return {
    path: body.path,
    content: buffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf8"),
    missing: false,
    binary: false,
    truncated,
  };
}

/**
 * Exposes the web UI's long-lived fff search engine to the native TUI without
 * duplicating its native binding or its frecency database. The bridge is
 * loopback-only and protected by a per-process capability.
 */
export async function startTuiSearchBridge(): Promise<TuiSearchBridge> {
  const capability = randomUUID();
  const server = createServer(async (request, response) => {
    if (request.headers["x-diffing-capability"] !== capability) {
      sendJson(response, 401, { error: "invalid TUI search capability" });
      return;
    }

    try {
      if (request.method === "POST" && request.url === "/search") {
        const body = (await readJson(request)) as SearchBody;
        sendJson(response, 200, await runSearch(body));
        return;
      }
      if (request.method === "POST" && request.url === "/preview") {
        const body = (await readJson(request)) as PreviewBody;
        sendJson(response, 200, await loadTuiPreview(body));
        return;
      }
      if (request.method === "POST" && request.url === "/track") {
        const body = await readJson(request);
        if (typeof body.path === "string") {
          const { trackSelection } = await import("./search.js");
          await trackSelection(
            typeof body.query === "string" ? body.query : "",
            body.path,
          );
        }
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error: any) {
      if (
        error instanceof NativeFsError ||
        error instanceof BridgeRequestError
      ) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      sendJson(response, 500, {
        error: error?.message ?? "TUI search failed",
      });
    }
  });

  await new Promise<void>((resolveP, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveP();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not resolve TUI search bridge address");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    capability,
    close: () =>
      new Promise<void>((resolveP) => server.close(() => resolveP())),
  };
}
