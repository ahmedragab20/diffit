import type { AiRunEvent } from "./types.js";

export interface AiRunPolicy {
	preparationMs: number;
	firstEventMs: number;
	idleMs: number;
	totalMs: number;
	maxOutputBytes: number;
	maxEventBytes: number;
	maxEvents: number;
	maxPendingEvents: number;
	maxConcurrent: number;
	maxPerSource: number;
}

export const DEFAULT_AI_RUN_POLICY: Readonly<AiRunPolicy> = Object.freeze({
	preparationMs: 15_000,
	firstEventMs: 45_000,
	idleMs: 30_000,
	totalMs: 300_000,
	maxOutputBytes: 4 * 1024 * 1024,
	maxEventBytes: 256 * 1024,
	maxEvents: 50_000,
	maxPendingEvents: 16,
	maxConcurrent: 8,
	maxPerSource: 2,
});

const failureMessages = {
	cancelled: "AI request canceled; termination has been requested.",
	preparation_timeout: "AI request preparation timed out.",
	first_event_timeout:
		"AI provider did not respond before the first-event deadline.",
	idle_timeout: "AI provider exceeded the idle deadline.",
	total_timeout: "AI request exceeded the total deadline.",
	resource_limit: "AI request exceeded a resource limit.",
	capacity: "AI execution capacity is full; wait for active work to terminate.",
	preparation_failed: "AI request preparation failed.",
	delivery_failed: "AI event delivery failed.",
	provider_failed: "AI provider execution failed.",
	authentication_failed: "AI provider authentication failed.",
	rate_limited: "AI provider rate limit reached.",
	request_rejected: "AI provider rejected the request.",
	unsupported_capability:
		"The selected provider or model does not support the requested setting, image input or investigation mode.",
	capability_unavailable:
		"AI model capabilities could not be verified; no inference was submitted.",
	protocol_error: "AI provider returned an invalid event.",
	empty_output: "AI provider returned no text.",
} as const;

export class AiRunError extends Error {
	readonly automaticRetryAllowed = false;
	constructor(readonly code: keyof typeof failureMessages) {
		super(failureMessages[code]);
		this.name = code === "cancelled" ? "AbortError" : "AiRunError";
	}
}

export function runPolicy(overrides: Partial<AiRunPolicy>): AiRunPolicy {
	const policy = { ...DEFAULT_AI_RUN_POLICY, ...overrides };
	for (const value of Object.values(policy)) {
		if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
			throw new Error("AI run policy values must be positive bounded integers.");
	}
	return policy;
}

/** Bounds delivery and waiting; a deadline does not claim underlying work stopped. */
export class AiRunLifecycle {
	private readonly owned = new Set<Promise<unknown>>();
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;
	private events = 0;
	private outputBytes = 0;
	private accepting = true;
	private finished = false;
	private released = false;
	private stageTimer?: ReturnType<typeof setTimeout>;
	private readonly totalTimer: ReturnType<typeof setTimeout>;
	private readonly startedAt = Date.now();
	private stageAt = this.startedAt;
	private stage: "preparation" | "first_event" | "idle" = "preparation";

	constructor(
		readonly controller: AbortController,
		readonly policy: AiRunPolicy,
		private readonly sink: (event: AiRunEvent) => void | Promise<void>,
		private readonly release: () => void,
	) {
		this.totalTimer = setTimeout(
			() => this.fail(new AiRunError("total_timeout")),
			policy.totalMs,
		);
		this.arm("preparation");
	}

	fail(error: AiRunError): AiRunError {
		if (!this.controller.signal.aborted) this.controller.abort(error);
		return this.controller.signal.reason as AiRunError;
	}

	private arm(stage: "preparation" | "first_event" | "idle"): void {
		clearTimeout(this.stageTimer);
		this.stage = stage;
		this.stageAt = Date.now();
		this.stageTimer = setTimeout(
			() => this.fail(new AiRunError(`${stage}_timeout`)),
			this.stageLimit(),
		);
	}

	private stageLimit(): number {
		return this.stage === "preparation"
			? this.policy.preparationMs
			: this.stage === "first_event"
				? this.policy.firstEventMs
				: this.policy.idleMs;
	}

	check(): void {
		if (Date.now() - this.startedAt >= this.policy.totalMs)
			this.fail(new AiRunError("total_timeout"));
		if (Date.now() - this.stageAt >= this.stageLimit())
			this.fail(new AiRunError(`${this.stage}_timeout`));
		this.controller.signal.throwIfAborted();
	}

	startProvider(): void {
		this.check();
		this.arm("first_event");
	}

	track<T>(promise: Promise<T>): Promise<T> {
		this.owned.add(promise);
		const settled = () => {
			this.owned.delete(promise);
			this.maybeRelease();
		};
		void promise.then(settled, settled);
		return promise;
	}

	async wait<T>(promise: Promise<T>): Promise<T> {
		this.check();
		const signal = this.controller.signal;
		let abort!: () => void;
		const stopped = new Promise<never>((_, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			const result = await Promise.race([promise, stopped]);
			this.check();
			return result;
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	/** Provider code cannot forge start, completion, or error terminal events. */
	providerEvent = (event: AiRunEvent): Promise<void> => {
		try {
			this.check();
			if (
				!this.accepting ||
				!event ||
				(event.type !== "text-delta" && event.type !== "warning")
			)
				throw new AiRunError("protocol_error");
			if (event.type === "text-delta") {
				if (typeof event.text !== "string") throw new AiRunError("protocol_error");
				this.outputBytes += Buffer.byteLength(event.text, "utf8");
				if (this.outputBytes > this.policy.maxOutputBytes)
					throw new AiRunError("resource_limit");
			} else if (typeof event.message !== "string")
				throw new AiRunError("protocol_error");
			this.arm("idle");
			return this.deliver(event);
		} catch (error) {
			const rejected = Promise.reject(
				this.fail(
					error instanceof AiRunError ? error : new AiRunError("protocol_error"),
				),
			);
			// Even a non-cooperative adapter ignoring the returned promise cannot cause an unhandled rejection.
			void rejected.catch(() => {});
			return rejected;
		}
	};

	deliver(event: AiRunEvent): Promise<void> {
		this.check();
		if (
			++this.events > this.policy.maxEvents ||
			this.pending >= this.policy.maxPendingEvents ||
			(event.type !== "complete" &&
				Buffer.byteLength(JSON.stringify(event), "utf8") >
					this.policy.maxEventBytes)
		)
			throw this.fail(new AiRunError("resource_limit"));
		this.pending++;
		const delivery = this.tail.then(async () => {
			this.check();
			try {
				await this.sink(event);
			} catch {
				throw this.fail(new AiRunError("delivery_failed"));
			}
			this.check();
		});
		this.tail = delivery;
		this.track(delivery);
		void delivery.then(
			() => {
				this.pending--;
			},
			() => {
				this.pending--;
			},
		);
		return delivery;
	}

	async drain(): Promise<void> {
		this.accepting = false;
		await this.wait(this.tail);
	}

	validateOutput(text: string): void {
		if (typeof text !== "string") throw new AiRunError("protocol_error");
		if (Buffer.byteLength(text, "utf8") > this.policy.maxOutputBytes)
			throw new AiRunError("resource_limit");
		if (!text.trim()) throw new AiRunError("empty_output");
	}

	finish(): void {
		this.accepting = false;
		this.finished = true;
		clearTimeout(this.stageTimer);
		clearTimeout(this.totalTimer);
		this.maybeRelease();
	}

	private maybeRelease(): void {
		if (this.finished && !this.owned.size && !this.released) {
			this.released = true;
			this.release();
		}
	}
}
