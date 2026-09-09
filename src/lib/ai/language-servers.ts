/**
 * Resolves and reuses language servers for AI symbol lookups.
 *
 * Nothing is presumed: with no configured server for a file's extension the
 * lookup reports itself unavailable rather than guessing at a toolchain. A
 * server is started at most once per command and reused across lookups, since
 * a cold start costs far more than a query, and it is shut down once idle so a
 * review session does not leave language servers running.
 */
import { pathToFileURL } from "node:url";
import { LspError, LspSession } from "./lsp.js";
import type { AiLanguageServer } from "../settings.js";

export const LANGUAGE_SERVER_LIMITS = Object.freeze({
	maxServers: 4,
	idleMs: 5 * 60_000,
});

function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export class LanguageServers {
	private readonly sessions = new Map<
		string,
		{ session: Promise<LspSession>; timer?: NodeJS.Timeout }
	>();
	private closed = false;

	constructor(
		private readonly config: Record<string, AiLanguageServer> = {},
		private readonly repositoryRoot: string = process.cwd(),
	) {}

	/** True when some extension has a configured server; used to report honestly. */
	get configured(): boolean {
		return Object.keys(this.config).length > 0;
	}

	/** Extensions with a configured server, so a UI can say what it supports. */
	get extensions(): string[] {
		return Object.keys(this.config);
	}

	supports(path: string): boolean {
		return this.config[extensionOf(path)] !== undefined;
	}

	async sessionFor(path: string): Promise<LspSession> {
		if (this.closed) throw new LspError("unavailable");
		const server = this.config[extensionOf(path)];
		if (!server) throw new LspError("unavailable");
		const slot = `${server.command} ${(server.args ?? []).join(" ")}`;
		const existing = this.sessions.get(slot);
		if (existing) {
			this.touch(slot);
			return existing.session;
		}
		if (this.sessions.size >= LANGUAGE_SERVER_LIMITS.maxServers)
			throw new LspError("resource_limit");
		const started = LspSession.start(
			server.command,
			server.args ?? [],
			pathToFileURL(this.repositoryRoot).href,
		).catch((error: unknown) => {
			// A server that fails to start is not retained, so a later lookup retries.
			this.drop(slot);
			throw error;
		});
		this.sessions.set(slot, { session: started });
		this.touch(slot);
		return started;
	}

	async close(): Promise<void> {
		this.closed = true;
		const slots = [...this.sessions.keys()];
		await Promise.all(slots.map((slot) => this.shutdown(slot)));
	}

	private touch(slot: string): void {
		const entry = this.sessions.get(slot);
		if (!entry) return;
		if (entry.timer) clearTimeout(entry.timer);
		entry.timer = setTimeout(() => {
			void this.shutdown(slot);
		}, LANGUAGE_SERVER_LIMITS.idleMs);
		// An idle timer must never hold the process open on its own.
		entry.timer.unref?.();
	}

	private drop(slot: string): void {
		const entry = this.sessions.get(slot);
		if (entry?.timer) clearTimeout(entry.timer);
		this.sessions.delete(slot);
	}

	private async shutdown(slot: string): Promise<void> {
		const entry = this.sessions.get(slot);
		if (!entry) return;
		this.drop(slot);
		try {
			await (await entry.session).close();
		} catch {
			/* A server that never started needs no shutdown. */
		}
	}
}
