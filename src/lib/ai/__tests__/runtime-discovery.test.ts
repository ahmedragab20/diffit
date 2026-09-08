// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { DirectProviderAdapter, RuntimeAdapter } from "../adapters.js";
import type { SecretStore } from "../secrets.js";
import { AiService } from "../service.js";

const script = (stdout: string, exit = 0) =>
	`process.stdout.write(${JSON.stringify(stdout)});process.exitCode=${exit}`;
function adapter(version: string, status: string, model?: string) {
	return new RuntimeAdapter({
		id: "claude",
		label: "fixture",
		bin: process.execPath,
		versionArgs: ["-e", version],
		statusArgs: ["-e", status],
		modelArgs: model ? ["-e", model] : undefined,
		fallbackModels: [{ id: "test", label: "Test" }],
		routes: ["subscription"],
		setup: { subscription: "fixture login" },
		args: () => [],
	});
}

describe("RuntimeAdapter offline discovery", () => {
	it("captures a bounded version token without live verification", async () => {
		const current = adapter(script("fixture 1.2.3-test\n"), script("ok\n"));
		const connection = await new AiService([current]).connections();
		expect(connection[0]).toMatchObject({
			status: "connected",
			capabilities: { runtimeVersion: "1.2.3-test", liveVerified: false },
		});
	});

	it("does not expose private version diagnostics", async () => {
		const current = adapter(
			script("synthetic private diagnostics"),
			script("ok"),
		);
		const service = new AiService([current]);
		const connection = await service.connections();
		expect(JSON.stringify(connection)).not.toContain(
			"synthetic private diagnostics",
		);
		expect(
			(await service.models()).map((model) => model.capabilities?.runtimeVersion),
		).toEqual([null]);
	});

	it("treats a failed version command as missing runtime", async () => {
		const current = adapter(script("1.2.3", 1), script("ok"));
		expect(await current.connection()).toMatchObject({
			status: "missing-runtime",
			runtimeAvailable: false,
		});
		expect(current.capabilities.runtimeVersion).toBeNull();
	});

	it("retains version when status needs configuration", async () => {
		const current = adapter(script("fixture 1.2.3\n"), script("status error", 1));
		const connection = await new AiService([current]).connections();
		expect(connection[0]).toMatchObject({
			status: "needs-configuration",
			capabilities: { runtimeVersion: "1.2.3" },
		});
	});

	it("uses fallback models when model discovery fails", async () => {
		const current = adapter(
			script("fixture 1.2.3"),
			script("ok"),
			script("catalog failed", 1),
		);
		const models = await current.models();
		expect(models[0]).toMatchObject({
			modelId: "test",
			catalogSource: "fallback",
			supportsImages: false,
		});
	});
});

const directSecrets = (
	value: string | null = "synthetic-key",
): SecretStore => ({
	get: vi.fn(async () => value),
	set: vi.fn(async () => "session" as const),
	delete: vi.fn(async () => {}),
});

describe("bounded authentication evidence", () => {
	it("reports runtime status without claiming authentication", async () => {
		expect(
			await adapter(script("1.2.3"), script("ok")).connection(),
		).toMatchObject({
			activeRoutes: [],
			authentication: {
				evidence: "runtime-status",
				verified: false,
				configuredRoutes: [],
			},
		});
	});
	it("reports no authentication evidence after failed status", async () => {
		expect(
			await adapter(script("1.2.3"), script("failed", 1)).connection(),
		).toMatchObject({
			authentication: { evidence: "none", verified: false, configuredRoutes: [] },
		});
	});
	it("reports configured direct key without probing connection", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const current = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_RUNTIME_KEY",
			},
			directSecrets(),
			fetchImpl,
		);
		expect(await current.connection()).toMatchObject({
			activeRoutes: [],
			authentication: {
				evidence: "key-configured",
				verified: false,
				configuredRoutes: ["direct-key"],
			},
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("classifies direct catalog failures safely and uses redirect error", async () => {
		let canceled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("private body"));
			},
			cancel() {
				canceled = true;
			},
		});
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect(init?.redirect).toBe("error");
				return new Response(body, { status: 500 });
			},
		) as unknown as typeof fetch;
		const current = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_RUNTIME_KEY_2",
			},
			directSecrets(),
			fetchImpl,
		);
		const error = await current.models().catch((error: unknown) => error);
		expect(error).toMatchObject({ code: "capability_unavailable" });
		expect(String(error)).not.toContain("private body");
		expect(canceled).toBe(true);
	});
	it("rejects invalid catalogs and does not verify valid ones", async () => {
		const invalid = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "bad id" }] }), { status: 200 }),
		) as unknown as typeof fetch;
		const current = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_RUNTIME_KEY_3",
			},
			directSecrets(),
			invalid,
		);
		await expect(current.models()).rejects.toMatchObject({
			code: "protocol_error",
		});
		const valid = new DirectProviderAdapter(
			{
				id: "openai",
				label: "OpenAI",
				baseUrl: "https://api.test",
				envKey: "DIFFING_TEST_RUNTIME_KEY_4",
			},
			directSecrets(),
			vi.fn(
				async () =>
					new Response(JSON.stringify({ data: [{ id: "gpt-test" }] }), {
						status: 200,
					}),
			) as unknown as typeof fetch,
		);
		expect(await valid.models()).toHaveLength(1);
		expect(await valid.connection()).toMatchObject({
			authentication: { evidence: "key-configured", verified: false },
		});
	});
});
