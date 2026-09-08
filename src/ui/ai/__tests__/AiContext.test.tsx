import {
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	act,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AiProvider, useAi } from "../AiContext";

afterEach(() => vi.restoreAllMocks());

const selectedModel = "codex/subscription/codex/sol";

function runBody(
	frames: string[],
	separators = "\n\n",
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(frames.join(separators) + separators));
			controller.close();
		},
	});
}

function mockAiFetch(body?: ReadableStream<Uint8Array>) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (url.endsWith("/api/ai/connections"))
			return new Response(JSON.stringify({ connections: [] }), { status: 200 });
		if (url.endsWith("/api/ai/models"))
			return new Response(
				JSON.stringify({
					models: [
						{
							id: selectedModel,
							displayName: "Sol",
							sourceId: "codex",
							credentialRoute: "subscription",
							providerId: "codex",
							modelId: "sol",
						},
					],
				}),
				{ status: 200 },
			);
		if (url.endsWith("/api/settings"))
			return new Response(JSON.stringify({ aiModel: selectedModel }), {
				status: 200,
			});
		if (url.endsWith("/api/ai/run"))
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		throw new Error(`Unexpected request: ${url}`);
	});
}

function frame(event: unknown): string {
	return `data: ${JSON.stringify(event)}`;
}

describe("AiProvider trigger contract", () => {
	it("loads shared settings/catalog without starting inference", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = String(input);
				if (url.endsWith("/api/ai/connections"))
					return new Response(JSON.stringify({ connections: [] }), { status: 200 });
				if (url.endsWith("/api/ai/models"))
					return new Response(JSON.stringify({ models: [] }), { status: 200 });
				if (url.endsWith("/api/settings"))
					return new Response(JSON.stringify({ aiModel: null }), { status: 200 });
				throw new Error(`Unexpected request: ${url}`);
			});
		render(
			<AiProvider>
				<div>child</div>
			</AiProvider>,
		);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).includes("/api/ai/run"),
			),
		).toBe(false);
	});

	it("returns authoritative completion text from a valid stream", async () => {
		mockAiFetch(
			runBody([
				frame({ type: "start", runId: "run-1", modelId: selectedModel }),
				frame({ type: "text-delta", text: "partial" }),
				frame({ type: "complete", text: "authoritative" }),
			]),
		);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<AiProvider>{children}</AiProvider>
		);
		const hook = renderHook(() => useAi(), { wrapper });
		await waitFor(() =>
			expect(hook.result.current.selectedModel).toBe(selectedModel),
		);
		let result!: Awaited<ReturnType<typeof hook.result.current.run>>;
		await act(async () => {
			result = await hook.result.current.run({
				surface: "diff",
				action: "ask",
				context: { kind: "diff" },
			});
		});
		expect(result).toMatchObject({ runId: "run-1", text: "authoritative" });
	});

	it("rejects a partial stream at EOF", async () => {
		mockAiFetch(
			runBody([
				frame({ type: "start", runId: "run-2", modelId: selectedModel }),
				frame({ type: "text-delta", text: "partial" }),
			]),
		);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<AiProvider>{children}</AiProvider>
		);
		const hook = renderHook(() => useAi(), { wrapper });
		await waitFor(() =>
			expect(hook.result.current.selectedModel).toBe(selectedModel),
		);
		await expect(
			hook.result.current.run({
				surface: "diff",
				action: "ask",
				context: { kind: "diff" },
			}),
		).rejects.toThrow();
	});

	it.each([
		["malformed delta", { type: "text-delta", text: null }, /invalid run event/],
		[
			"malformed completion",
			{ type: "complete", text: null },
			/invalid run event/,
		],
		["empty completion", { type: "complete", text: "" }, /invalid run event/],
		["unknown event", { type: "unknown" }, /invalid run event/],
		[
			"provider error",
			{ type: "error", message: "provider failed" },
			/provider failed/,
		],
		[
			"duplicate start",
			{ type: "start", runId: "duplicate", modelId: selectedModel },
			/duplicate start/,
		],
	] as const)(
		"rejects %s even if followed by completion",
		async (_name, event, expected) => {
			mockAiFetch(
				runBody([
					frame({ type: "start", runId: "run-error", modelId: selectedModel }),
					frame(event),
					frame({ type: "complete", text: "must not succeed" }),
				]),
			);
			const wrapper = ({ children }: { children: ReactNode }) => (
				<AiProvider>{children}</AiProvider>
			);
			const hook = renderHook(() => useAi(), { wrapper });
			await waitFor(() =>
				expect(hook.result.current.selectedModel).toBe(selectedModel),
			);
			await expect(
				hook.result.current.run({
					surface: "diff",
					action: "ask",
					context: { kind: "diff" },
				}),
			).rejects.toThrow(expected);
		},
	);

	it("rejects completion without a start event", async () => {
		mockAiFetch(runBody([frame({ type: "complete", text: "answer" })]));
		const wrapper = ({ children }: { children: ReactNode }) => (
			<AiProvider>{children}</AiProvider>
		);
		const hook = renderHook(() => useAi(), { wrapper });
		await waitFor(() =>
			expect(hook.result.current.selectedModel).toBe(selectedModel),
		);
		await expect(
			hook.result.current.run({
				surface: "diff",
				action: "ask",
				context: { kind: "diff" },
			}),
		).rejects.toThrow("missing its start event");
	});

	it("handles CRLF frames split across chunks", async () => {
		const encoder = new TextEncoder();
		const bodyText =
			[
				frame({ type: "start", runId: "run-crlf", modelId: selectedModel }),
				frame({ type: "text-delta", text: "ok" }),
				frame({ type: "complete", text: "ok" }),
			].join("\r\n\r\n") + "\r\n\r\n";
		const midpoint = bodyText.indexOf("\r") + 1;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(bodyText.slice(0, midpoint)));
				controller.enqueue(encoder.encode(bodyText.slice(midpoint)));
				controller.close();
			},
		});
		mockAiFetch(body);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<AiProvider>{children}</AiProvider>
		);
		const hook = renderHook(() => useAi(), { wrapper });
		await waitFor(() =>
			expect(hook.result.current.selectedModel).toBe(selectedModel),
		);
		await expect(
			hook.result.current.run({
				surface: "diff",
				action: "ask",
				context: { kind: "diff" },
			}),
		).resolves.toMatchObject({ text: "ok" });
	});

	it("returns canceled after aborting following a delta", async () => {
		const controller = new AbortController();
		mockAiFetch(
			runBody([
				frame({ type: "start", runId: "run-abort", modelId: selectedModel }),
				frame({ type: "text-delta", text: "partial" }),
				frame({ type: "complete", text: "complete" }),
			]),
		);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<AiProvider>{children}</AiProvider>
		);
		const hook = renderHook(() => useAi(), { wrapper });
		await waitFor(() =>
			expect(hook.result.current.selectedModel).toBe(selectedModel),
		);
		const result = await hook.result.current.run({
			surface: "diff",
			action: "ask",
			context: { kind: "diff" },
			signal: controller.signal,
			onDelta: () => controller.abort(),
		});
		expect(result).toMatchObject({ canceled: true });
		expect(result).not.toHaveProperty("text", "complete");
	});

	it("returns an unconfirmed result for a pre-aborted run", async () => {
		const fetchMock = mockAiFetch();
		const controller = new AbortController(); controller.abort();
		const wrapper = ({ children }: { children: ReactNode }) => <AiProvider>{children}</AiProvider>;
		const hook = renderHook(() => useAi(), { wrapper });
		await waitFor(() => expect(hook.result.current.selectedModel).toBe(selectedModel));
		const result = await hook.result.current.run({ surface: "diff", action: "ask", context: { kind: "diff" }, signal: controller.signal });
		expect(result).toMatchObject({ canceled: true, cancellationConfirmed: false });
		expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/ai/run"))).toBe(false);
	});

	it("retains partial text when a cancelled stream reports its code", async () => {
		mockAiFetch(runBody([frame({ type: "start", runId: "cancel-code", modelId: selectedModel }), frame({ type: "text-delta", text: "partial" }), frame({ type: "error", code: "cancelled", message: "stopped" })]));
		const wrapper = ({ children }: { children: ReactNode }) => <AiProvider>{children}</AiProvider>;
		const hook = renderHook(() => useAi(), { wrapper }); await waitFor(() => expect(hook.result.current.selectedModel).toBe(selectedModel));
		await expect(hook.result.current.run({ surface: "diff", action: "ask", context: { kind: "diff" } })).resolves.toMatchObject({ text: "partial", canceled: true, cancellationConfirmed: false });
	});

	it("returns the same unconfirmed local result when fetch aborts while awaiting response", async () => {
		const fetchMock = mockAiFetch(); const original = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementation(async (input, init) => { if (!String(input).endsWith("/api/ai/run")) return original(input, init); return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))); });
		const controller = new AbortController(); const wrapper = ({ children }: { children: ReactNode }) => <AiProvider>{children}</AiProvider>;
		const hook = renderHook(() => useAi(), { wrapper }); await waitFor(() => expect(hook.result.current.selectedModel).toBe(selectedModel));
		const pending = hook.result.current.run({ surface: "diff", action: "ask", context: { kind: "diff" }, signal: controller.signal }); controller.abort();
		await expect(pending).resolves.toMatchObject({ canceled: true, cancellationConfirmed: false });
	});

	it.each([
		["successful acknowledgement", 200, JSON.stringify({ canceled: true, cancellationRequested: true, cancellationConfirmed: false, status: "cancel-requested" })],
		["HTTP failure", 503, "failure"],
		["malformed acknowledgement", 200, JSON.stringify({ canceled: true })],
	] as const)("rejects cancel with %s", async (_label, status, body) => {
		const fetchMock = mockAiFetch(); const original = fetchMock.getMockImplementation()!;
		fetchMock.mockImplementation(async (input, init) => String(input).includes("/cancel") ? new Response(body, { status }) : original(input, init));
		const wrapper = ({ children }: { children: ReactNode }) => <AiProvider>{children}</AiProvider>;
		const hook = renderHook(() => useAi(), { wrapper }); await waitFor(() => expect(hook.result.current.selectedModel).toBe(selectedModel));
		if (status === 200 && body.includes("cancellationRequested")) await expect(hook.result.current.cancel("run-cancel")).resolves.toBeUndefined();
		else await expect(hook.result.current.cancel("run-cancel")).rejects.toThrow();
	});

	it("persists toolbar selection and restores it after reload", async () => {
		const first = "codex/subscription/codex/sol";
		const second = "cursor/runtime-key/cursor/sonnet";
		let persistedModel = first;
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input, init) => {
				const url = String(input);
				if (url.endsWith("/api/ai/connections"))
					return new Response(JSON.stringify({ connections: [] }), { status: 200 });
				if (url.endsWith("/api/ai/models"))
					return new Response(
						JSON.stringify({
							models: [
								{
									id: first,
									displayName: "Sol",
									sourceId: "codex",
									credentialRoute: "subscription",
									providerId: "codex",
									modelId: "sol",
								},
								{
									id: second,
									displayName: "Sonnet",
									sourceId: "cursor",
									credentialRoute: "runtime-key",
									providerId: "cursor",
									modelId: "sonnet",
								},
							],
						}),
						{ status: 200 },
					);
				if (url.endsWith("/api/settings") && init?.method === "PUT") {
					persistedModel = (JSON.parse(String(init.body)) as { aiModel: string })
						.aiModel;
					return new Response(JSON.stringify({ aiModel: persistedModel }), {
						status: 200,
					});
				}
				if (url.endsWith("/api/settings"))
					return new Response(JSON.stringify({ aiModel: persistedModel }), {
						status: 200,
					});
				throw new Error(`Unexpected request: ${url}`);
			});
		function Controls() {
			const ai = useAi();
			return (
				<>
					<span data-testid="session">{ai.selectedModel}</span>
					<span data-testid="default">{ai.defaultModel}</span>
					<button onClick={() => ai.selectModel(second)}>Session</button>
					<button onClick={() => void ai.setDefaultModel(second)}>Default</button>
				</>
			);
		}
		const view = render(
			<AiProvider>
				<Controls />
			</AiProvider>,
		);
		await waitFor(() =>
			expect(screen.getByTestId("session")).toHaveTextContent(first),
		);
		fireEvent.click(screen.getByText("Session"));
		expect(screen.getByTestId("session")).toHaveTextContent(second);
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(
					([, init]) => init?.method === "PUT" && String(init.body).includes(second),
				),
			).toBe(true),
		);
		expect(screen.getByTestId("default")).toHaveTextContent(second);
		view.unmount();
		render(
			<AiProvider>
				<Controls />
			</AiProvider>,
		);
		await waitFor(() =>
			expect(screen.getByTestId("session")).toHaveTextContent(second),
		);
	});
});
