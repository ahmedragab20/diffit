import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { NotebookEntry } from "../../src/lib/ai/notebook";

const origin = "http://127.0.0.1:4179";
const surfaces = ["diff", "pr-diff", "plan"] as const;

function sse(
	events: Array<Record<string, unknown>>,
): string {
	return events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n") + "\n\n";
}

function finding(): NotebookEntry {
	return {
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
	};
}

function catalogJson() {
	return {
		connections: [
			{
				id: "codex",
				label: "Synthetic Codex",
				status: "connected",
				runtimeAvailable: true,
				credentialRoutes: ["subscription"],
				activeRoutes: ["subscription"],
			},
		],
		models: [
			{
				id: "codex/fixture",
				sourceId: "codex",
				credentialRoute: "subscription",
				providerId: "fixture",
				modelId: "fixture",
				displayName: "Offline fixture",
				isDefault: true,
			},
		],
	};
}

async function installRoutes(
	context: BrowserContext,
	page: Page,
	options: {
		surface: (typeof surfaces)[number];
		run: "ok" | "fail";
		withFindings?: boolean;
		unexpected: string[];
		pageErrors: string[];
	},
) {
	const catalog = catalogJson();
	let conversation: {
		id: string;
		title: string;
		surface: string;
		scopeKey: string;
		createdAt: number;
		updatedAt: number;
		modelId: string;
		draft: string;
		turns: unknown[];
	} | null = options.withFindings
		? {
				id: "fixture-conversation",
				title: "Existing",
				surface: options.surface,
				scopeKey:
					options.surface === "plan"
						? "plan:synthetic-plan"
						: `${options.surface}:synthetic:baseline`,
				createdAt: 1,
				updatedAt: 1,
				modelId: "codex/fixture",
				draft: "",
				turns: [
					{ id: "u1", role: "user", text: "risks?" },
					{ id: "a1", role: "assistant", text: "see findings" },
				],
			}
		: null;
	let runAttempts = 0;
	page.on("pageerror", (error) => options.pageErrors.push(error.message));
	await context.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		const method = request.method();
		if (url.origin !== origin) {
			options.unexpected.push(`${method} ${url.origin}${path}`);
			return route.abort();
		}
		if (!path.startsWith("/api/")) return route.continue();
		if (method === "GET" && path === "/api/ai/connections")
			return route.fulfill({ json: { connections: catalog.connections } });
		if (method === "GET" && path === "/api/ai/models")
			return route.fulfill({ json: { models: catalog.models } });
		if (method === "GET" && path === "/api/settings")
			return route.fulfill({ json: { aiModel: "codex/fixture", aiRailWidth: 360 } });
		if (method === "GET" && path === "/api/ai/conversations") {
			return route.fulfill({
				json: { conversations: conversation ? [conversation] : [] },
			});
		}
		if (
			method === "GET" &&
			conversation &&
			path === `/api/ai/conversations/${conversation.id}`
		) {
			return route.fulfill({ json: { conversation } });
		}
		if (method === "GET" && path === "/api/ai/evidence") {
			return route.fulfill({
				json: {
					snapshots: options.withFindings ? [{ id: "snap-1" }] : [],
				},
			});
		}
		if (
			method === "GET" &&
			path.startsWith("/api/ai/evidence/") &&
			path.endsWith("/notebook")
		) {
			return route.fulfill({
				json: { entries: options.withFindings ? [finding()] : [] },
			});
		}
		if (method === "POST" && path === "/api/ai/conversations") {
			conversation = {
				id: "created-conversation",
				title: "New conversation",
				surface: options.surface,
				scopeKey:
					options.surface === "plan"
						? "plan:synthetic-plan"
						: `${options.surface}:synthetic:baseline`,
				createdAt: 1,
				updatedAt: 1,
				modelId: "codex/fixture",
				draft: "",
				turns: [],
			};
			return route.fulfill({ status: 201, json: { conversation } });
		}
		if (
			conversation &&
			method === "PUT" &&
			path === `/api/ai/conversations/${conversation.id}`
		) {
			const patch = request.postDataJSON() as Record<string, unknown>;
			conversation = { ...conversation, ...patch };
			return route.fulfill({ json: { conversation } });
		}
		if (method === "POST" && path === "/api/ai/run") {
			runAttempts += 1;
			const failFirst = options.run === "fail" && runAttempts === 1;
			const body = failFirst
				? sse([
						{
							type: "start",
							runId: "run-fail",
							modelId: "codex/fixture",
						},
						{
							type: "error",
							message: "provider exploded",
							code: "provider_failed",
						},
					])
				: sse([
						{
							type: "start",
							runId: "run-1",
							modelId: "codex/fixture",
						},
						{ type: "text-delta", text: "Hello" },
						{ type: "complete", text: "Hello from the fixture" },
					]);
			return route.fulfill({
				status: 200,
				contentType: "text/event-stream",
				body,
			});
		}
		options.unexpected.push(`${method} ${path}`);
		return route.abort();
	});
}

for (const surface of surfaces) {
	test(`asks, streams, and settles on ${surface}`, async ({
		page,
		context,
	}) => {
		const unexpected: string[] = [];
		const pageErrors: string[] = [];
		await installRoutes(context, page, {
			surface,
			run: "ok",
			unexpected,
			pageErrors,
		});
		await page.goto(`/tests/ai-browser/fixture.html?surface=${surface}`);
		await expect(
			page.getByText("What do you want to understand?"),
		).toBeVisible();
		await page.getByRole("textbox", { name: "Ask AI" }).fill("Explain this");
		await page.getByRole("button", { name: /Send/i }).click();
		await expect(page.getByText("Hello from the fixture")).toBeVisible();
		await expect(page.getByLabel("Run activity")).toBeVisible();
		await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
		expect(unexpected, "unexpected requests").toEqual([]);
		expect(pageErrors, "page errors").toEqual([]);
	});
}

test("offers retry after a failed run and retries", async ({ page, context }) => {
	const unexpected: string[] = [];
	const pageErrors: string[] = [];
	await installRoutes(context, page, {
		surface: "diff",
		run: "fail",
		unexpected,
		pageErrors,
	});
	await page.goto("/tests/ai-browser/fixture.html?surface=diff");
	await page.getByRole("textbox", { name: "Ask AI" }).fill("Explain this");
	await page.getByRole("button", { name: /Send/i }).click();
	await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
	await expect(
		page.getByText(/starts a new attempt and keeps the one above/),
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByText("Hello from the fixture")).toBeVisible();
	await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
	expect(unexpected, "unexpected requests").toEqual([]);
	expect(pageErrors, "page errors").toEqual([]);
});

test("shows unverified findings as unverified", async ({ page, context }) => {
	const unexpected: string[] = [];
	const pageErrors: string[] = [];
	await installRoutes(context, page, {
		surface: "diff",
		run: "ok",
		withFindings: true,
		unexpected,
		pageErrors,
	});
	await page.goto("/tests/ai-browser/fixture.html?surface=diff");
	await expect(page.getByText("Inverted conversion")).toBeVisible();
	await expect(
		page.getByText(/could not be verified against this capture/),
	).toBeVisible();
	await expect(page.getByText("unverified")).toBeVisible();
	expect(
		await page.locator('[data-unverified="true"]').count(),
	).toBeGreaterThan(0);
	expect(unexpected, "unexpected requests").toEqual([]);
	expect(pageErrors, "page errors").toEqual([]);
});
