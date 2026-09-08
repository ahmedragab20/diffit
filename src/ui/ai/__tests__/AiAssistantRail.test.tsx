import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { AiAssistantRail } from "../AiAssistantRail";

const mocks = vi.hoisted(() => ({
	setRailWidth: vi.fn(async (_width: number) => {}),
	run: vi.fn(),
	cancel: vi.fn(async () => {}),
}));

vi.mock("../AiContext", () => ({
	useOptionalAi: () => ({
		models: [
			{
				id: "codex/subscription/codex/gpt-test",
				displayName: "GPT Test",
				sourceId: "codex",
				credentialRoute: "subscription",
				providerId: "codex",
				modelId: "gpt-test",
				supportsImages: true,
			},
		],
		selectedModel: "codex/subscription/codex/gpt-test",
		railWidth: 360,
		setRailWidth: mocks.setRailWidth,
		run: mocks.run,
		cancel: mocks.cancel,
	}),
}));

describe("AiAssistantRail", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.run.mockResolvedValue({
			text: "# Answer\n\n```ts\nconst value = 1\n```",
			runId: "r1",
			warnings: [],
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	const renderRail = (node: ReactNode) =>
		render(
			<QueryClientProvider
				client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
			>
				{node}
			</QueryClientProvider>,
		);

	it("does not dump a JSON parse error when conversation history returns HTML", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				if (String(input).includes("/api/ai/conversations"))
					return new Response("<!DOCTYPE html>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					});
				return new Response("{}", { status: 200 });
			}),
		);
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="mockup"
				context={{
					kind: "mockup",
					mockupId: "m1",
					title: "Landing",
					version: 2,
				}}
			/>,
		);
		expect(
			await screen.findByText(/Conversation history unavailable/),
		).toBeInTheDocument();
		expect(screen.queryByText(/Unexpected token/)).not.toBeInTheDocument();
		expect(mocks.run).not.toHaveBeenCalled();
	});

	it("renders a deliberate user-triggered empty state", () => {
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff", patch: "+x" }}
			/>,
		);
		expect(
			screen.getByText("What do you want to understand?"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Nothing runs until you tell it to/),
		).toBeInTheDocument();
		expect(mocks.run).not.toHaveBeenCalled();
	});

	it("shows mockup actions closed until click and attaches preview only on demand", async () => {
		const fetchMock = vi.fn(async (input, init) => {
			const url = String(input);
			if (url.includes("/api/ai/conversations?") && !init?.method)
				return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
			if (url.includes("/api/mockups/m1/inspect")) {
				return new Response(
					JSON.stringify({
						available: true,
						screenshotBase64: btoa("png"),
						mime: "image/png",
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/api/attachments") && init?.method === "POST") {
				return new Response(
					JSON.stringify({
						url: "/api/attachments/preview.png",
						name: "main-preview.png",
						mimeType: "image/png",
						size: 3,
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify({}), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="mockup"
				context={{
					kind: "mockup",
					mockupId: "m1",
					title: "Landing",
					version: 2,
					screenId: "main",
					screenLabel: "Main",
					viewport: "desktop",
					html: "<h1>Hi</h1>",
				}}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /Critique mockup/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Find gaps/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Attach preview" }),
		).toBeInTheDocument();
		expect(mocks.run).not.toHaveBeenCalled();
		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).includes("/api/mockups/m1/inspect"),
			),
		).toBe(false);
		await userEvent.click(screen.getByRole("button", { name: "Attach preview" }));
		await screen.findByRole("button", { name: "Remove image main-preview.png" });
		expect(mocks.run).not.toHaveBeenCalled();
		expect(
			fetchMock.mock.calls.some(([input]) => String(input).includes("/inspect?")),
		).toBe(true);
	});

	it("makes whole-review scope distinct from the current viewport focus", () => {
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff", focusedFilePath: "src/focused.ts", patch: "+x" }}
			/>,
		);
		expect(screen.getByText("whole diff")).toBeInTheDocument();
		expect(screen.getByText("focus: src/focused.ts")).toBeInTheDocument();
		fireEvent.click(screen.getByText("Context being shared"));
		expect(
			screen.getByText(
				/complete changed-file map plus diff content within the context limit/i,
			),
		).toBeInTheDocument();
	});

	it("renders removable exact diff-range context without starting inference", async () => {
		const onRemoveSelection = vi.fn();
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				onRemoveSelection={onRemoveSelection}
				surface="diff"
				context={{
					kind: "diff",
					selections: [
						{
							filePath: "src/device.ts",
							side: "additions",
							startLine: 14,
							endLine: 16,
							selectedText: "one\ntwo\nthree",
						},
					],
				}}
			/>,
		);
		const chip = screen.getByRole("button", {
			name: "Remove src/device.ts lines 14 to 16",
		});
		expect(chip).toHaveTextContent("device.ts · L14–L16");
		expect(mocks.run).not.toHaveBeenCalled();
		await userEvent.click(chip);
		expect(onRemoveSelection).toHaveBeenCalledWith(0);
	});

	it("uploads and sends an image-only message as multimodal context", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				const url = String(input);
				if (url.includes("/api/ai/conversations?") && !init?.method)
					return new Response(JSON.stringify({ conversations: [] }), {
						status: 200,
					});
				if (url.endsWith("/api/ai/conversations") && init?.method === "POST")
					return new Response(
						JSON.stringify({
							conversation: {
								id: "c-image",
								title: "New conversation",
								surface: "diff",
								scopeKey: "review",
								createdAt: 1,
								updatedAt: 1,
								turns: [],
							},
						}),
						{ status: 201 },
					);
				if (url.endsWith("/api/attachments") && init?.method === "POST")
					return new Response(
						JSON.stringify({
							url: "/api/attachments/pasted_image_a.png",
							name: "screen.png",
							mimeType: "image/png",
							size: 3,
						}),
						{ status: 200 },
					);
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff" }}
			/>,
		);
		const input = screen.getByLabelText("Attach images", { selector: "input" });
		fireEvent.change(input, {
			target: { files: [new File(["png"], "screen.png", { type: "image/png" })] },
		});
		await screen.findByRole("button", { name: "Remove image screen.png" });
		await userEvent.click(screen.getByRole("button", { name: /Send/i }));
		await waitFor(() =>
			expect(mocks.run).toHaveBeenCalledWith(
				expect.objectContaining({
					context: expect.objectContaining({
						imageAttachments: [
							expect.objectContaining({ url: "/api/attachments/pasted_image_a.png" }),
						],
					}),
				}),
			),
		);
	});

	it("resizes from the left edge and persists on release", () => {
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff" }}
			/>,
		);
		const separator = screen.getByRole("separator", {
			name: "Resize AI assistant",
		});
		fireEvent.mouseDown(separator, { clientX: 500 });
		fireEvent.mouseMove(document, { clientX: 420 });
		fireEvent.mouseUp(document);
		expect(mocks.setRailWidth).toHaveBeenCalledWith(440);
	});

	it.each([
		["a drag", (separator: HTMLElement) => {
			fireEvent.mouseDown(separator, { clientX: 900 });
			fireEvent.mouseMove(document, { clientX: 100 });
			fireEvent.mouseUp(document);
		}],
		["a keypress", (separator: HTMLElement) => {
			fireEvent.keyDown(separator, { key: "ArrowLeft" });
		}],
	])("keeps the rail inside a narrow window on %s", (_label, resize) => {
		const original = window.innerWidth;
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 900,
		});
		try {
			renderRail(
				<AiAssistantRail
					open
					onClose={vi.fn()}
					surface="diff"
					context={{ kind: "diff" }}
				/>,
			);
			resize(
				screen.getByRole("separator", { name: "Resize AI assistant" }),
			);
			// 900px leaves 540 for the rail once the diff gutter is reserved.
			for (const call of mocks.setRailWidth.mock.calls)
				expect(call[0]).toBeLessThanOrEqual(540);
		} finally {
			Object.defineProperty(window, "innerWidth", {
				configurable: true,
				value: original,
			});
		}
	});

	it("announces the range a narrow window can actually produce", () => {
		const original = window.innerWidth;
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 900,
		});
		try {
			renderRail(
				<AiAssistantRail
					open
					onClose={vi.fn()}
					surface="diff"
					context={{ kind: "diff" }}
				/>,
			);
			const separator = screen.getByRole("separator", {
				name: "Resize AI assistant",
			});
			expect(separator.getAttribute("aria-valuemax")).toBe("540");
		} finally {
			Object.defineProperty(window, "innerWidth", {
				configurable: true,
				value: original,
			});
		}
	});

	it("supports keyboard resizing", () => {
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="plan"
				context={{ kind: "plan", planId: "p1", title: "Plan", version: 1 }}
			/>,
		);
		fireEvent.keyDown(
			screen.getByRole("separator", { name: "Resize AI assistant" }),
			{ key: "ArrowLeft" },
		);
		expect(mocks.setRailWidth).toHaveBeenCalledWith(376);
	});

	it("uses FFF mentions as explicit file attachments and renders streamed Markdown", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							scope: "files",
							items: [
								{
									path: "docs/cli.md",
									fileName: "cli.md",
									gitStatus: "",
									matchType: "fuzzy",
									exact: false,
								},
							],
							total: 1,
							indexing: false,
						}),
						{ status: 200 },
					),
			),
		);
		const user = userEvent.setup();
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff" }}
			/>,
		);
		const composer = screen.getByRole("textbox", { name: "Ask AI" });
		await user.type(composer, "Review @cli");
		await user.click(await screen.findByRole("option", { name: /cli\.md/i }));
		expect(
			screen.getByRole("button", { name: /Remove docs\/cli\.md/i }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /Send/i }));
		await screen.findByRole("heading", { level: 1, name: /Answer/i });
		expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
		expect(mocks.run).toHaveBeenCalledWith(
			expect.objectContaining({
				context: expect.objectContaining({ attachmentPaths: ["docs/cli.md"] }),
			}),
		);
	});

	it("clears the composer immediately and shows the labeled thinking state", async () => {
		let release!: () => void;
		mocks.run.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ text: "Done", runId: "r2", warnings: [] });
				}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				const url = String(input);
				if (url.includes("/api/ai/conversations?") && !init?.method)
					return new Response(JSON.stringify({ conversations: [] }), {
						status: 200,
					});
				if (url.endsWith("/api/ai/conversations") && init?.method === "POST")
					return new Response(
						JSON.stringify({
							conversation: {
								id: "c1",
								title: "New conversation",
								surface: "diff",
								scopeKey: "review",
								createdAt: 1,
								updatedAt: 1,
								turns: [],
							},
						}),
						{ status: 201 },
					);
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		const user = userEvent.setup();
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff" }}
			/>,
		);
		const composer = screen.getByRole("textbox", { name: "Ask AI" });
		await user.type(composer, "Explain this change");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Send/i })).not.toBeDisabled(),
		);
		await user.click(screen.getByRole("button", { name: /Send/i }));
		await waitFor(() =>
			expect(
				screen.getByText("Thinking about your request"),
			).toBeInTheDocument(),
		);
		expect(composer).toHaveValue("");
		release();
		await waitFor(() => expect(screen.getByText("Done")).toBeInTheDocument());
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("keeps completed turns in place while a later response streams", async () => {
		const conversation = {
			id: "c1",
			title: "Existing",
			surface: "diff",
			scopeKey: "diff:review:working-tree",
			createdAt: 1,
			updatedAt: 1,
			turns: [
				{ id: "u1", role: "user", text: "why this?" },
				{ id: "a1", role: "assistant", text: "settled answer" },
			],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				const url = String(input);
				if (url.includes("/api/ai/conversations?") && !init?.method)
					return new Response(
						JSON.stringify({
							conversations: [
								{
									id: "c1",
									title: "Existing",
									surface: "diff",
									scopeKey: "diff:review:working-tree",
									createdAt: 1,
									updatedAt: 1,
									turnCount: 2,
								},
							],
						}),
						{ status: 200 },
					);
				if (url.includes("/api/ai/conversations/c1") && !init?.method)
					return new Response(JSON.stringify({ conversation }), { status: 200 });
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		mocks.run.mockImplementation(async ({ onDelta }) => {
			onDelta?.("par");
			onDelta?.("partial stream");
			return new Promise(() => {});
		});
		const user = userEvent.setup();
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff" }}
			/>,
		);
		expect(await screen.findByText("settled answer")).toBeInTheDocument();
		await user.type(screen.getByRole("textbox", { name: "Ask AI" }), "next");
		await user.click(screen.getByRole("button", { name: /Send/i }));
		await waitFor(() =>
			expect(document.querySelector('[data-streaming="true"]')?.textContent).toContain(
				"partial stream",
			),
		);
		expect(document.querySelector('[data-turn-id="a1"]')?.textContent).toContain(
			"settled answer",
		);
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("offers retry only after a terminal failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				const url = String(input);
				if (url.includes("/api/ai/conversations?") && !init?.method)
					return new Response(JSON.stringify({ conversations: [] }), {
						status: 200,
					});
				if (url.endsWith("/api/ai/conversations") && init?.method === "POST")
					return new Response(
						JSON.stringify({
							conversation: {
								id: "c-fail",
								title: "New conversation",
								surface: "diff",
								scopeKey: "review",
								createdAt: 1,
								updatedAt: 1,
								turns: [],
							},
						}),
						{ status: 201 },
					);
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		mocks.run.mockRejectedValue(new Error("provider exploded"));
		const user = userEvent.setup();
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff" }}
			/>,
		);
		await user.type(screen.getByRole("textbox", { name: "Ask AI" }), "Explain");
		await user.click(screen.getByRole("button", { name: /Send/i }));
		expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(
			screen.getByText(/starts a new attempt and keeps the one above/),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(2));
	});

	it.each([
		[
			"failed",
			() => {
				mocks.run.mockRejectedValue(new Error("provider exploded"));
			},
		],
		[
			"canceled",
			() => {
				mocks.run.mockResolvedValue({
					text: "",
					runId: "r-cancel",
					warnings: [],
					canceled: true,
				});
			},
		],
	])("creates a new conversation after a %s run", async (_label, armRun) => {
		let created = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				const url = String(input);
				if (url.includes("/api/ai/conversations?") && !init?.method)
					return new Response(JSON.stringify({ conversations: [] }), {
						status: 200,
					});
				if (url.endsWith("/api/ai/conversations") && init?.method === "POST") {
					created += 1;
					return new Response(
						JSON.stringify({
							conversation: {
								id: `c-${created}`,
								title:
									created === 1 ? "New conversation" : "Fresh conversation",
								surface: "diff",
								scopeKey: "diff:review:working-tree",
								createdAt: created,
								updatedAt: created,
								turns: [],
							},
						}),
						{ status: 201 },
					);
				}
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		armRun();
		const user = userEvent.setup();
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff" }}
			/>,
		);
		await user.type(screen.getByRole("textbox", { name: "Ask AI" }), "Explain");
		await user.click(screen.getByRole("button", { name: /Send/i }));
		expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(created).toBe(1);
		await user.click(screen.getByRole("button", { name: "New conversation" }));
		await waitFor(() => expect(created).toBe(2));
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(
			screen.getByRole("option", { name: "Fresh conversation" }),
		).toBeInTheDocument();
	});

	it("labels unverified findings as unverified, never as authoritative", async () => {
		const conversation = {
			id: "c1",
			title: "Existing",
			surface: "diff",
			scopeKey: "diff:review:working-tree",
			createdAt: 1,
			updatedAt: 1,
			turns: [
				{ id: "u1", role: "user", text: "risks?" },
				{ id: "a1", role: "assistant", text: "see findings" },
			],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input, init) => {
				const url = String(input);
				if (url.includes("/api/ai/conversations?") && !init?.method)
					return new Response(
						JSON.stringify({
							conversations: [
								{
									id: "c1",
									title: "Existing",
									surface: "diff",
									scopeKey: "diff:review:working-tree",
									createdAt: 1,
									updatedAt: 1,
									turnCount: 2,
								},
							],
						}),
						{ status: 200 },
					);
				if (url.includes("/api/ai/conversations/c1") && !init?.method)
					return new Response(JSON.stringify({ conversation }), { status: 200 });
				if (url.includes("/api/ai/evidence/") && url.includes("/notebook"))
					return new Response(
						JSON.stringify({
							entries: [
								{
									id: "f1",
									kind: "finding",
									title: "Inverted conversion",
									body: "Divides where it should multiply.",
									uncertainty: "medium",
									citations: [
										{
											key: "a.ts",
											startLine: 1,
											endLine: 1,
											quote: "total / 100",
											evidenceId: "ev-1",
										},
									],
									links: [],
									snapshotRevision: "rev",
									decision: null,
									decidedBy: null,
									decidedAt: null,
								},
							],
						}),
						{ status: 200 },
					);
				if (url.includes("/api/ai/evidence"))
					return new Response(
						JSON.stringify({ snapshots: [{ id: "snap-1" }] }),
						{ status: 200 },
					);
				return new Response(JSON.stringify({}), { status: 200 });
			}),
		);
		renderRail(
			<AiAssistantRail
				open
				onClose={vi.fn()}
				surface="diff"
				context={{ kind: "diff" }}
			/>,
		);
		expect(await screen.findByText("Inverted conversion")).toBeInTheDocument();
		expect(
			screen.getByText(/could not be verified against this capture/),
		).toBeInTheDocument();
		expect(screen.getByText("unverified")).toBeInTheDocument();
		expect(document.querySelector('[data-unverified="true"]')).not.toBeNull();
		expect(document.querySelector('[data-unverified="false"]')).toBeNull();
	});
});
