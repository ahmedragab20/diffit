// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
	LIVE_PING_PROMPT,
	probeLiveCompatibility,
} from "../live-compat.js";
import type { AiBackendAdapter, AiConnection, AiModel } from "../types.js";

function connection(
	overrides: Partial<AiConnection> = {},
): AiConnection {
	return {
		id: "codex",
		label: "Codex",
		status: "connected",
		runtimeAvailable: true,
		credentialRoutes: ["subscription"],
		activeRoutes: ["subscription"],
		...overrides,
	};
}

function model(): AiModel {
	return {
		id: "codex/subscription/codex/sol",
		sourceId: "codex",
		credentialRoute: "subscription",
		providerId: "codex",
		modelId: "sol",
		displayName: "Sol",
	};
}

function adapter(
	overrides: Partial<AiBackendAdapter> & { id?: AiBackendAdapter["id"] } = {},
): AiBackendAdapter {
	return {
		id: "codex",
		capabilities: {
			protocol: "codex-app-server",
			contractVersion: 1,
			runtimeVersion: "1.2.3",
			liveVerified: false,
			routes: ["subscription"],
			reasoningEffort: "unsupported",
			serviceTier: "unsupported",
			images: "unsupported",
			toolAuthority: "disabled",
			investigation: false,
		},
		connection: vi.fn(async () => connection()),
		models: vi.fn(async () => [model()]),
		run: vi.fn(async () => "pong"),
		...overrides,
	};
}

describe("probeLiveCompatibility", () => {
	it("records discovery without pinging when ping is off", async () => {
		const target = adapter();
		const report = await probeLiveCompatibility([target]);
		expect(report.liveVerified).toBe(false);
		expect(report.probes).toEqual([
			expect.objectContaining({
				sourceId: "codex",
				status: "connected",
				runtimeAvailable: true,
				runtimeVersion: "1.2.3",
				modelCount: 1,
				inference: "skipped",
				liveVerified: false,
			}),
		]);
		expect(target.run).not.toHaveBeenCalled();
	});

	it("does not treat a missing runtime as live-verified", async () => {
		const report = await probeLiveCompatibility(
			[
				adapter({
					id: "claude",
					connection: vi.fn(async () =>
						connection({
							id: "claude",
							status: "missing-runtime",
							runtimeAvailable: false,
						}),
					),
					models: vi.fn(async () => []),
				}),
			],
			{ ping: true },
		);
		expect(report.liveVerified).toBe(false);
		expect(report.probes[0]).toMatchObject({
			status: "missing-runtime",
			inference: "skipped",
			liveVerified: false,
			modelCount: 0,
		});
	});

	it("pings a connected provider once, with the bounded prompt", async () => {
		const target = adapter();
		const report = await probeLiveCompatibility([target], { ping: true });
		expect(report.probes[0]?.inference).toBe("ok");
		expect(report.liveVerified).toBe(false);
		expect(target.run).toHaveBeenCalledTimes(1);
		expect(target.run).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: "user",
				prompt: LIVE_PING_PROMPT,
			}),
			expect.any(AbortSignal),
			expect.any(Function),
		);
	});

	it("records timeout when the ping is aborted", async () => {
		const target = adapter({
			run: vi.fn(async (_request, signal): Promise<string> => {
				signal.throwIfAborted();
				return await new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					);
				});
			}),
		});
		const report = await probeLiveCompatibility([target], {
			ping: true,
			pingMs: 5,
		});
		expect(report.probes[0]?.inference).toBe("timeout");
		expect(report.liveVerified).toBe(false);
	});

	it("records failed when the ping returns empty text", async () => {
		const target = adapter({ run: vi.fn(async () => "   ") });
		const report = await probeLiveCompatibility([target], { ping: true });
		expect(report.probes[0]?.inference).toBe("failed");
		expect(report.liveVerified).toBe(false);
	});
});
