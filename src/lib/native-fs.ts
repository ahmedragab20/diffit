import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  findFileAccessTuiBinary,
  nativeFileEnvironment,
} from "./find-tui-binary.js";
import { toSafeLiteralRelativePath } from "./path.js";

export const MAX_NATIVE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FRAME_BYTES = 70 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 4;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_NATIVE_FILE_BYTES / 3);

const errorDetails = {
  "invalid-path": { status: 400, message: "Invalid repository file path." },
  "invalid-request": { status: 400, message: "Invalid filesystem request." },
  denied: {
    status: 403,
    message:
      "File access denied: symlink and administrative paths are not allowed.",
  },
  "not-found": { status: 404, message: "File not found." },
  "not-file": {
    status: 400,
    message: "The requested path is not a regular file.",
  },
  "too-large": {
    status: 413,
    message: "File exceeds the native access size limit.",
  },
  conflict: {
    status: 409,
    message: "File content changed. Reload before saving.",
  },
  io: { status: 500, message: "Filesystem operation failed." },
  unavailable: {
    status: 503,
    message:
      "Native file access is unavailable. Build or reinstall the native component, then restart diffing.",
  },
  protocol: {
    status: 502,
    message:
      "Native file access returned an invalid response. Restart diffing.",
  },
  timeout: {
    status: 504,
    message: "Native file access timed out. Restart diffing.",
  },
  busy: {
    status: 503,
    message:
      "Native file access is busy. Retry after the current operation completes.",
  },
} as const;

export type NativeFsErrorCode = keyof typeof errorDetails;

export class NativeFsError extends Error {
  constructor(
    readonly code: NativeFsErrorCode,
    readonly outcomeUnknown = false,
  ) {
    super(
      errorDetails[code].message +
        (outcomeUnknown
          ? " The write outcome is unknown; inspect the file before retrying."
          : ""),
    );
    this.name = "NativeFsError";
  }

  get status() {
    return errorDetails[this.code].status;
  }
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const readySchema = z
  .object({
    protocol: z.literal(1),
    type: z.literal("ready"),
    maxFileBytes: z.literal(MAX_NATIVE_FILE_BYTES),
    maxFrameBytes: z.literal(MAX_FRAME_BYTES),
  })
  .strict();
const replySchema = z.discriminatedUnion("ok", [
  z
    .object({
      protocol: z.literal(1),
      id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      protocol: z.literal(1),
      id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum([
            "invalid-path",
            "invalid-request",
            "denied",
            "not-found",
            "not-file",
            "too-large",
            "conflict",
            "io",
          ]),
          message: z.string().max(1024),
        })
        .strict(),
    })
    .strict(),
]);
const fileInfoSchema = z.object({
  sha256: sha256Schema,
  size: z.number().int().nonnegative().max(MAX_NATIVE_FILE_BYTES),
});
const fileReadSchema = fileInfoSchema
  .extend({ contentBase64: z.string().max(MAX_BASE64_LENGTH) })
  .strict();

type Operation =
  | { kind: "read"; path: string }
  | {
      kind: "write";
      path: string;
      contentBase64: string;
      createParents: boolean;
      expectedSha256?: string;
    };

type Pending = {
  kind: Operation["kind"];
  bytes: number;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: NativeFsError) => void;
};

export interface NativeWriteOptions {
  createParents?: boolean;
  expectedSha256?: string;
}

interface ClientOptions {
  /** Trusted injection for tests/embedding; never accepted from HTTP input. */
  binary?: string | null;
  callerUrl?: string;
  timeoutMs?: number;
}

/** A helper holds one root capability until this client is explicitly closed. */
export class NativeRepositoryFs {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private failure?: NativeFsErrorCode;
  private ready = false;
  private resolveReady?: () => void;
  private rejectReady?: (error: NativeFsError) => void;
  private startTimer?: NodeJS.Timeout;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private pendingBytes = 0;
  private frameParts: Buffer[] = [];
  private frameBytes = 0;

  constructor(
    private readonly root: string,
    private readonly options: ClientOptions = {},
  ) {}

  async available(): Promise<boolean> {
    try {
      await this.start();
      return !this.failure;
    } catch {
      return false;
    }
  }

  async read(path: string): Promise<{ bytes: Buffer; sha256: string }> {
    const relative = this.relative(path);
    const result = await this.request({ kind: "read", path: relative });
    const parsed = fileReadSchema.safeParse(result);
    if (!parsed.success) return this.invalidResponse(false);
    const bytes = Buffer.from(parsed.data.contentBase64, "base64");
    if (
      bytes.length !== parsed.data.size ||
      bytes.toString("base64") !== parsed.data.contentBase64 ||
      hash(bytes) !== parsed.data.sha256
    ) {
      return this.invalidResponse(false);
    }
    return { bytes, sha256: parsed.data.sha256 };
  }

  async write(
    path: string,
    bytes: Buffer,
    options: NativeWriteOptions = {},
  ): Promise<{ sha256: string; size: number }> {
    const relative = this.relative(path);
    if (!Buffer.isBuffer(bytes)) throw new NativeFsError("invalid-request");
    if (bytes.length > MAX_NATIVE_FILE_BYTES)
      throw new NativeFsError("too-large");
    if (
      (options.expectedSha256 !== undefined &&
        !sha256Schema.safeParse(options.expectedSha256).success) ||
      (options.createParents !== undefined &&
        typeof options.createParents !== "boolean")
    ) {
      throw new NativeFsError("invalid-request");
    }
    const content = Buffer.from(bytes);
    const expectedSha256 = options.expectedSha256;
    const createParents = options.createParents ?? false;
    await this.start();
    const result = await this.request({
      kind: "write",
      path: relative,
      contentBase64: content.toString("base64"),
      createParents,
      ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
    });
    const parsed = fileInfoSchema.strict().safeParse(result);
    if (
      !parsed.success ||
      parsed.data.size !== content.length ||
      parsed.data.sha256 !== hash(content)
    ) {
      return this.invalidResponse(true);
    }
    return parsed.data;
  }

  close(): void {
    this.fail("unavailable");
  }

  private relative(path: string): string {
    if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
      throw new NativeFsError("invalid-path");
    }
    const relative = toSafeLiteralRelativePath(path, this.root);
    if (!relative) throw new NativeFsError("invalid-path");
    return relative;
  }

  private start(): Promise<void> {
    if (this.failure) return Promise.reject(new NativeFsError(this.failure));
    this.starting ??= this.launch().catch(() => {
      this.fail(this.failure ?? "unavailable");
      throw new NativeFsError(this.failure ?? "unavailable");
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    const binary =
      this.options.binary === undefined
        ? await findFileAccessTuiBinary(
            this.options.callerUrl ?? import.meta.url,
          )
        : this.options.binary;
    if (!binary || this.failure) throw new NativeFsError("unavailable");
    await new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.startTimer = setTimeout(
        () => this.fail("timeout"),
        this.timeout(3_000),
      );
      const child = spawn(binary, ["--repo", this.root, "--fs-rpc"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: nativeFileEnvironment(),
      });
      this.child = child;
      child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
      child.stdout.on("error", () => this.fail("unavailable"));
      child.stdin.on("error", () => this.fail("unavailable"));
      child.stderr.resume(); // Never relay helper diagnostics or ambient paths.
      child.on("error", () => this.fail("unavailable"));
      // close, unlike exit, happens after stdout's final response is drained.
      child.on("close", () => this.fail("unavailable"));
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        if ("unref" in stream && typeof stream.unref === "function")
          stream.unref();
      }
    });
  }

  private async request(op: Operation): Promise<unknown> {
    await this.start();
    if (this.failure) throw new NativeFsError(this.failure);
    if (this.pending.size >= MAX_PENDING_REQUESTS)
      throw new NativeFsError("busy");
    const id = this.nextId++;
    if (!Number.isSafeInteger(id)) return this.invalidResponse(false);
    const wire = JSON.stringify({ id, op }) + "\n";
    const size = Buffer.byteLength(wire);
    if (size > MAX_FRAME_BYTES) throw new NativeFsError("too-large");
    if (this.pendingBytes + size > MAX_FRAME_BYTES)
      throw new NativeFsError("busy");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail("timeout"),
        this.timeout(30_000),
      );
      this.pending.set(id, {
        kind: op.kind,
        bytes: size,
        timer,
        resolve,
        reject,
      });
      this.pendingBytes += size;
      try {
        this.child!.stdin.write(wire);
      } catch {
        this.fail("unavailable");
      }
    });
  }

  private timeout(fallback: number): number {
    const value = this.options.timeoutMs;
    return value !== undefined && Number.isFinite(value)
      ? Math.max(1, Math.min(value, fallback))
      : fallback;
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      this.frameBytes += part.length;
      if (this.frameBytes > MAX_FRAME_BYTES) {
        this.fail("protocol");
        return;
      }
      this.frameParts.push(part);
      if (newline < 0) return;
      const frame = Buffer.concat(this.frameParts, this.frameBytes);
      this.frameParts = [];
      this.frameBytes = 0;
      this.receive(frame);
      if (this.failure) return;
      start = newline + 1;
    }
  }

  private receive(frame: Buffer): void {
    let value: unknown;
    try {
      value = JSON.parse(frame.toString("utf8"));
    } catch {
      this.fail("protocol");
      return;
    }
    if (!this.ready) {
      if (!readySchema.safeParse(value).success) {
        this.fail("protocol");
        return;
      }
      this.ready = true;
      if (this.startTimer) clearTimeout(this.startTimer);
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }
    const parsed = replySchema.safeParse(value);
    if (!parsed.success) {
      this.fail("protocol");
      return;
    }
    const pending = this.pending.get(parsed.data.id);
    if (!pending) {
      this.fail("protocol");
      return;
    }
    this.pending.delete(parsed.data.id);
    this.pendingBytes -= pending.bytes;
    clearTimeout(pending.timer);
    if (parsed.data.ok) pending.resolve(parsed.data.result);
    else pending.reject(new NativeFsError(parsed.data.error.code));
  }

  private invalidResponse(outcomeUnknown: boolean): never {
    this.fail("protocol");
    throw new NativeFsError("protocol", outcomeUnknown);
  }

  private fail(code: NativeFsErrorCode): void {
    if (this.failure) return;
    this.failure = code;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.rejectReady?.(new NativeFsError(code));
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new NativeFsError(code, pending.kind === "write"));
    }
    this.pending.clear();
    this.pendingBytes = 0;
    this.frameParts = [];
    this.frameBytes = 0;
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.child?.kill("SIGTERM");
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const clients = new Map<string, NativeRepositoryFs>();

export function getNativeRepositoryFs(root: string): NativeRepositoryFs {
  let client = clients.get(root);
  if (!client) {
    client = new NativeRepositoryFs(root);
    clients.set(root, client);
  }
  return client;
}

/** Explicit lifecycle reset; a failed transport never silently retries a write. */
export function closeNativeRepositoryFs(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}
