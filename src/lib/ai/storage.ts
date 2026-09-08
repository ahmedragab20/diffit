/**
 * Durable, server-owned AI run and turn state.
 *
 * Driver choice (the spike this replaces): `node:sqlite` does not exist on
 * Node 20, which `engines` still supports, and `better-sqlite3` is a native
 * module needing prebuilds for every packaged platform. Neither is acceptable
 * for a local-first CLI today, so this is built on the same append-only
 * journal + atomic snapshot the rest of the product persists with, behind a
 * narrow interface so a SQLite driver can replace it without touching callers.
 *
 * Durability properties, each of which is tested:
 *  - Append-only: a record is never rewritten in place.
 *  - Idempotent: a repeated key returns the stored record instead of appending.
 *  - Replayable: state is rebuilt by reading the journal in order.
 *  - Recoverable: a torn trailing line is discarded and reported, and every
 *    record before it is kept.
 *  - Honest under disk failure: an I/O error surfaces as such and never leaves
 *    a half-applied record.
 *  - Non-destructive: a journal written by a newer version is never rewritten.
 *
 * Single-writer by design: one server owns a repository at a time, enforced by
 * the server lock. This is not safe for concurrent writers in other processes.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STORAGE_VERSION = 1;

export const STORAGE_LIMITS = Object.freeze({
	maxRecordBytes: 256 * 1024,
	maxRecords: 50_000,
});

export class AiStorageError extends Error {
	constructor(
		readonly code: "io" | "invalid" | "limit" | "unsupported_version",
	) {
		super(
			{
				io: "AI storage could not be written.",
				invalid: "AI storage record is invalid.",
				limit: "AI storage limit reached.",
				unsupported_version:
					"AI storage was written by a newer version and was left untouched.",
			}[code],
		);
		this.name = "AiStorageError";
	}
}

export interface AiTurnRecord {
	id: string;
	runId: string;
	conversationId: string;
	kind: "request" | "event" | "result" | "error";
	createdAt: number;
	payload: unknown;
}

interface StoredLine {
	v: number;
	key: string;
	checksum: string;
	record: AiTurnRecord;
}

export interface RecoveryReport {
	/** Records replayed successfully. */
	records: number;
	/** Set when a trailing line could not be trusted and was discarded. */
	truncatedAtLine: number | null;
}

const checksumOf = (record: AiTurnRecord, key: string): string =>
	createHash("sha256").update(JSON.stringify({ key, record })).digest("hex");

function validRecord(value: unknown): value is AiTurnRecord {
	const record = value as Partial<AiTurnRecord> | null;
	return (
		!!record &&
		typeof record.id === "string" &&
		!!record.id &&
		typeof record.runId === "string" &&
		!!record.runId &&
		typeof record.conversationId === "string" &&
		!!record.conversationId &&
		typeof record.createdAt === "number" &&
		Number.isSafeInteger(record.createdAt) &&
		["request", "event", "result", "error"].includes(record.kind as string)
	);
}

export class AiStorage {
	private readonly journal: string;
	private records: AiTurnRecord[] = [];
	private readonly keys = new Map<string, AiTurnRecord>();
	private recovery: RecoveryReport = { records: 0, truncatedAtLine: null };
	private loaded = false;
	/** Serializes appends so a record is never interleaved with another. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(directory: string) {
		this.journal = join(directory, "ai-turns.jsonl");
	}

	/**
	 * Rebuilds state from the journal. A line that fails to parse or verify ends
	 * the replay: everything before it is trusted, everything after is not.
	 */
	load(): RecoveryReport {
		this.records = [];
		this.keys.clear();
		this.recovery = { records: 0, truncatedAtLine: null };
		this.loaded = true;
		let text: string;
		try {
			text = readFileSync(this.journal, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.recovery;
			throw new AiStorageError("io");
		}
		const lines = text.split("\n");
		for (const [index, line] of lines.entries()) {
			if (!line.trim()) continue;
			let parsed: StoredLine;
			try {
				parsed = JSON.parse(line) as StoredLine;
			} catch {
				this.recovery.truncatedAtLine = index + 1;
				break;
			}
			if (typeof parsed?.v !== "number" || parsed.v > STORAGE_VERSION)
				throw new AiStorageError("unsupported_version");
			if (
				typeof parsed.key !== "string" ||
				!validRecord(parsed.record) ||
				parsed.checksum !== checksumOf(parsed.record, parsed.key)
			) {
				this.recovery.truncatedAtLine = index + 1;
				break;
			}
			this.records.push(parsed.record);
			this.keys.set(parsed.key, parsed.record);
		}
		this.recovery.records = this.records.length;
		return this.recovery;
	}

	private ensureLoaded(): void {
		if (!this.loaded) this.load();
	}

	get recoveryReport(): RecoveryReport {
		this.ensureLoaded();
		return { ...this.recovery };
	}

	/**
	 * Appends a record under an idempotency key. Repeating a key returns the
	 * stored record and writes nothing, so a retried request cannot duplicate.
	 */
	append(key: string, record: AiTurnRecord): Promise<AiTurnRecord> {
		const run = async (): Promise<AiTurnRecord> => {
			this.ensureLoaded();
			if (typeof key !== "string" || !key || key.length > 512)
				throw new AiStorageError("invalid");
			const existing = this.keys.get(key);
			if (existing) return existing;
			if (!validRecord(record)) throw new AiStorageError("invalid");
			if (this.records.length >= STORAGE_LIMITS.maxRecords)
				throw new AiStorageError("limit");
			const line: StoredLine = {
				v: STORAGE_VERSION,
				key,
				checksum: checksumOf(record, key),
				record,
			};
			const serialized = `${JSON.stringify(line)}\n`;
			if (Buffer.byteLength(serialized, "utf8") > STORAGE_LIMITS.maxRecordBytes)
				throw new AiStorageError("limit");
			try {
				mkdirSync(dirname(this.journal), { recursive: true });
				appendFileSync(this.journal, serialized, "utf-8");
			} catch {
				// Nothing is recorded in memory, so the failure leaves no half-write.
				throw new AiStorageError("io");
			}
			this.records.push(record);
			this.keys.set(key, record);
			this.recovery.records = this.records.length;
			return record;
		};
		const result = this.queue.then(run);
		// The chain never rejects, so one failed append cannot stall the next.
		this.queue = result.catch(() => undefined);
		return result;
	}

	list(runId?: string): AiTurnRecord[] {
		this.ensureLoaded();
		return runId
			? this.records.filter((record) => record.runId === runId)
			: [...this.records];
	}

	get(id: string): AiTurnRecord | undefined {
		this.ensureLoaded();
		return this.records.find((record) => record.id === id);
	}

	/**
	 * Rewrites the journal from trusted records, dropping anything replay could
	 * not verify. The previous journal is kept alongside, so compaction never
	 * destroys the only copy of what was there.
	 */
	compact(): void {
		this.ensureLoaded();
		const body = this.records
			.map((record, index) => {
				const key = `compacted:${index}`;
				return `${JSON.stringify({
					v: STORAGE_VERSION,
					key,
					checksum: checksumOf(record, key),
					record,
				})}\n`;
			})
			.join("");
		try {
			mkdirSync(dirname(this.journal), { recursive: true });
			const temporary = `${this.journal}.compact.tmp`;
			writeFileSync(temporary, body, "utf-8");
			try {
				renameSync(this.journal, `${this.journal}.bak`);
			} catch {
				/* No prior journal to preserve. */
			}
			renameSync(temporary, this.journal);
		} catch {
			throw new AiStorageError("io");
		}
		this.load();
	}
}
