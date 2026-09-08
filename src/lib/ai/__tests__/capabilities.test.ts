import { describe, expect, it, vi } from "vitest";
import {
	assertModelOptions,
	assertProviderModelId,
	assertProviderRequest,
	providerCapabilities,
	validateProviderOptions,
} from "../capabilities.js";
import { createDefaultAdapters } from "../adapters.js";
import { AiService } from "../service.js";
import type { SecretStore } from "../secrets.js";
import type {
	AiBackendAdapter,
	AiConnection,
	AiModel,
	AiRunRequest,
} from "../types.js";

const sources = ["codex", "claude", "opencode", "cursor", "xai"] as const;
const protocols = {
	codex: "codex-app-server",
	claude: "claude-stream-json",
	opencode: "opencode-json",
	cursor: "cursor-stream-json",
	xai: "responses-sse",
} as const;

function mockSecrets(): SecretStore {
	return {
		get: vi.fn(async () => null),
		set: vi.fn(async () => "session" as const),
		delete: vi.fn(async () => undefined),
	};
}

function request(
	source: AiRunRequest["modelId"] = "codex/subscription/codex/test",
): AiRunRequest {
	return {
		trigger: "user",
		conversationId: "capability-test",
		modelId: source,
		surface: "diff",
		action: "ask",
		context: { kind: "diff" },
	};
}

function expectCode(action: () => void, code: string): void {
	try {
		action();
	} catch (error) {
		expect(error).toMatchObject({ code });
		return;
	}
	expect.fail(`expected ${code}`);
}

function model(overrides: Partial<AiModel> = {}): AiModel {
	return {
		id: "codex/subscription/codex/test",
		sourceId: "codex",
		credentialRoute: "subscription",
		providerId: "codex",
		modelId: "test",
		displayName: "Test",
		reasoningEfforts: ["low", "high"],
		serviceTiers: ["priority", "standard"],
		supportsImages: false,
		catalogSource: "provider",
		...overrides,
	};
}

function adapter(models: AiModel[] = [model()]): AiBackendAdapter {
	return {
		id: "codex",
		capabilities: providerCapabilities("codex"),
		models: vi.fn(async () => models),
		connection: vi.fn(
			async (): Promise<AiConnection> => ({
				id: "codex",
				label: "Codex",
				status: "connected",
				runtimeAvailable: true,
				credentialRoutes: ["subscription"],
				activeRoutes: ["subscription"],
			}),
		),
		run: vi.fn(async () => "answer"),
	};
}

describe("provider capability contracts", () => {
	it.each(sources)(
		"declares the %s transport without live certification",
		(source) => {
			const caps = providerCapabilities(source);
			expect(caps).toMatchObject({
				protocol: protocols[source],
				contractVersion: 1,
				runtimeVersion: null,
				liveVerified: false,
				investigation: false,
			});
			expect(caps.routes).toEqual(
				source === "xai" ? ["direct-key"] : ["subscription", "runtime-key"],
			);
			caps.routes.length = 0;
			expect(caps.toolAuthority).toBe(
				source === "xai" ? "disabled" : "runtime-managed-unverified",
			);
			expect(providerCapabilities(source).routes).toEqual(
				source === "xai" ? ["direct-key"] : ["subscription", "runtime-key"],
			);
		},
	);

	it("uses default adapters only to inspect declared IDs and capabilities", () => {
		const adapters = createDefaultAdapters(mockSecrets());
		expect(adapters.map(({ id }) => id)).toEqual([...sources]);
		for (const current of adapters)
			expect(current.capabilities).toEqual(providerCapabilities(current.id));
	});

	it.each(sources)("rejects investigation for %s", (source) => {
		expectCode(
			() =>
				assertProviderRequest(
					{
						...request(
							`${source}/${source === "xai" ? "direct-key" : "subscription"}/${source}/test`,
						),
						mode: "investigate",
					},
					providerCapabilities(source),
				),
			"unsupported_capability",
		);
	});

	it.each(["claude", "opencode", "cursor", "xai"] as const)(
		"rejects unsupported options for %s",
		(source) => {
			const route = source === "xai" ? "direct-key" : "subscription";
			for (const option of ["reasoningEffort", "serviceTier"] as const)
				expectCode(
					() =>
						assertProviderRequest(
							{ ...request(`${source}/${route}/${source}/test`), [option]: "low" },
							providerCapabilities(source),
						),
					"unsupported_capability",
				);
		},
	);

	it("requires exact catalog choices for codex and rejects empty options", () => {
		const caps = providerCapabilities("codex");
		expect(() =>
			assertProviderRequest(
				{ ...request(), reasoningEffort: "low", serviceTier: "priority" },
				caps,
			),
		).not.toThrow();
		expect(() =>
			assertModelOptions(
				{ ...request(), reasoningEffort: "low", serviceTier: "priority" },
				model(),
			),
		).not.toThrow();
		for (const option of ["reasoningEffort", "serviceTier"] as const)
			expectCode(
				() => assertModelOptions({ ...request(), [option]: "invalid" }, model()),
				"unsupported_capability",
			);
		expectCode(
			() => assertModelOptions({ ...request(), reasoningEffort: "" }, model()),
			"unsupported_capability",
		);
		expectCode(
			() => assertModelOptions({ ...request(), serviceTier: "" }, model()),
			"unsupported_capability",
		);
		expect(() =>
			assertModelOptions({ ...request(), resolvedImages: [] }, undefined),
		).not.toThrow();
	});

	it("validates options lazily, aborts safely, and never leaks catalog errors", async () => {
		const current = adapter();
		await validateProviderOptions(
			current,
			request(),
			new AbortController().signal,
		);
		expect(current.models).not.toHaveBeenCalled();
		await validateProviderOptions(
			current,
			{ ...request(), reasoningEffort: "low" },
			new AbortController().signal,
		);
		expect(current.models).toHaveBeenCalledOnce();
		await expect(
			validateProviderOptions(
				current,
				{ ...request(), reasoningEffort: "nope" },
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "unsupported_capability" });
		const failed = adapter();
		vi.mocked(failed.models).mockRejectedValueOnce(new Error("synthetic-secret"));
		await expect(
			validateProviderOptions(
				failed,
				{ ...request(), reasoningEffort: "low" },
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "capability_unavailable" });
	});

	it.each([
		"wrong/subscription/codex/test",
		"codex/subscription/wrong/test",
		"codex/direct-key/codex/test",
		"codex/subscription/codex",
		"codex/subscription/codex/-flag",
		"codex/subscription/codex/white space",
	] as const)("rejects malformed model ID %s", (modelId) => {
		expectCode(
			() => assertProviderModelId(request(modelId), adapter()),
			"request_rejected",
		);
	});

	it("accepts nested provider model IDs", () => {
		const nested = "opencode/runtime-key/opencode/anthropic/claude-test";
		const current: AiBackendAdapter = {
			...adapter(),
			id: "opencode",
			capabilities: providerCapabilities("opencode"),
		};
		expect(() => assertProviderModelId(request(nested), current)).not.toThrow();
	});

	it("requires model image metadata rather than transport support alone", () => {
		const withImage: AiRunRequest = {
			...request(),
			resolvedImages: [
				{
					url: "/api/attachments/fixture.png",
					name: "fixture.png",
					mimeType: "image/png",
					absolutePath: "/synthetic/fixture.png",
					dataUrl: "data:image/png;base64,eA==",
				},
			],
		};
		expectCode(
			() => assertModelOptions(withImage, undefined),
			"unsupported_capability",
		);
		expectCode(
			() => assertModelOptions(withImage, model()),
			"unsupported_capability",
		);
		expect(() =>
			assertModelOptions(withImage, model({ supportsImages: true })),
		).not.toThrow();
	});

	it("rejects options for a model missing from the current catalog", async () => {
		await expect(
			validateProviderOptions(
				adapter([]),
				{ ...request(), reasoningEffort: "low" },
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "unsupported_capability" });
	});

	it("does not start discovery after pre-abort", async () => {
		const current = adapter();
		const controller = new AbortController();
		controller.abort();
		await expect(
			validateProviderOptions(
				current,
				{ ...request(), reasoningEffort: "low" },
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(current.models).not.toHaveBeenCalled();
	});

	it("checks cancellation after an owned catalog lookup settles", async () => {
		const current = adapter();
		let release!: (models: AiModel[]) => void;
		vi.mocked(current.models).mockReturnValue(
			new Promise<AiModel[]>((resolve) => {
				release = resolve;
			}),
		);
		const controller = new AbortController();
		const pending = validateProviderOptions(
			current,
			{ ...request(), reasoningEffort: "low" },
			controller.signal,
		);
		expect(current.models).toHaveBeenCalledOnce();
		controller.abort();
		release([model()]);
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(current.run).not.toHaveBeenCalled();
	});

	it("rejects unsupported service requests before any provider I/O or start event", async () => {
		const current: AiBackendAdapter = {
			...adapter(),
			id: "xai",
			capabilities: providerCapabilities("xai"),
		};
		const service = new AiService([current]);
		const emit = vi.fn();
		for (const options of [
			{ mode: "investigate" as const },
			{ reasoningEffort: "low" },
		]) {
			await expect(
				service.run({ ...request("xai/direct-key/xai/test"), ...options }, emit),
			).rejects.toMatchObject({ code: "unsupported_capability" });
		}
		expect(current.run).not.toHaveBeenCalled();
		expect(current.models).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});

	it("exposes declared capabilities while keeping discovery failures safe", async () => {
		const current = adapter();
		const service = new AiService([current]);
		expect((await service.connections())[0]?.capabilities).toEqual(
			providerCapabilities("codex"),
		);
		expect((await service.models())[0]?.capabilities).toEqual(
			providerCapabilities("codex"),
		);
		vi
			.mocked(current.connection)
			.mockRejectedValue(new Error("synthetic-secret"));
		const failed = new AiService([current]);
		const connections = await failed.connections();
		expect(connections[0]).toMatchObject({
			status: "error",
			detail: "AI connection discovery failed.",
		});
		expect(JSON.stringify(connections)).not.toContain("synthetic-secret");
	});
});
