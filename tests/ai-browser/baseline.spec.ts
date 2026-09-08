import { expect, test, type Page } from "@playwright/test";

interface Measurements {
	samples: number[];
	longtasks: number[];
	supported: boolean;
}
declare global {
	interface Window {
		__aiBaseline: Measurements;
	}
}

const origin = "http://127.0.0.1:4179";
const surfaces = ["diff", "pr-diff", "plan"] as const;

function makeConversation(surface: string) {
	return {
		id: "fixture-conversation",
		title: "Synthetic history",
		surface,
		scopeKey:
			surface === "plan" ? "plan:synthetic-plan" : `${surface}:synthetic:baseline`,
		createdAt: 1,
		updatedAt: 1,
		modelId: "codex/fixture",
		draft: "",
		turns: Array.from({ length: 80 }, (_, index) => ({
			id: `fixture-turn-${index}`,
			role: index % 2 ? "assistant" : "user",
			text:
				`Synthetic ${index % 2 ? "answer" : "question"} ${index}\n\n` +
				Array.from(
					{ length: 8 },
					(_, line) => `- Offline evidence line ${line}.`,
				).join("\n"),
			createdAt: 1,
			modelId: "codex/fixture",
		})),
	};
}

async function instrument(page: Page) {
	await page.evaluate(() => {
		const metrics: Measurements = {
			samples: [],
			longtasks: [],
			supported:
				"PerformanceObserver" in window &&
				PerformanceObserver.supportedEntryTypes.includes("longtask"),
		};
		window.__aiBaseline = metrics;
		if (metrics.supported) {
			new PerformanceObserver((list) => {
				metrics.longtasks.push(...list.getEntries().map((entry) => entry.duration));
			}).observe({ type: "longtask", buffered: false });
		}
		window.addEventListener("keydown", (event) => {
			if (!(event.target instanceof HTMLTextAreaElement) || event.key !== "x")
				return;
			const start = performance.now();
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					metrics.samples.push(performance.now() - start);
				}),
			);
		});
	});
}

for (const surface of surfaces) {
	test(`captures offline ${surface} baseline`, async ({
		page,
		context,
		browser,
	}, info) => {
		let conversation = makeConversation(surface);
		const unexpected: string[] = [];
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await context.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const path = url.pathname;
			const method = request.method();
			if (url.origin !== origin) {
				unexpected.push(`${method} ${url.origin}${path}`);
				return route.abort();
			}
			if (!path.startsWith("/api/")) return route.continue();
			if (method === "GET") {
				if (path === "/api/ai/connections")
					return route.fulfill({
						json: {
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
						},
					});
				if (path === "/api/ai/models")
					return route.fulfill({
						json: {
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
						},
					});
				if (path === "/api/settings")
					return route.fulfill({
						json: {
							aiModel: "codex/fixture",
							aiRailWidth: 360,
						},
					});
				if (
					path === "/api/ai/conversations" &&
					url.searchParams.get("scopeKey") === conversation.scopeKey &&
					url.searchParams.get("surface") === surface
				) {
					return route.fulfill({ json: { conversations: [conversation] } });
				}
				if (path === "/api/ai/conversations/fixture-conversation") {
					return route.fulfill({ json: { conversation } });
				}
				if (path === "/api/ai/evidence") {
					return route.fulfill({ json: { snapshots: [] } });
				}
				if (
					path.startsWith("/api/ai/evidence/") &&
					path.endsWith("/notebook")
				) {
					return route.fulfill({ json: { entries: [] } });
				}
			}
			if (
				path === "/api/ai/conversations/fixture-conversation" &&
				method === "PUT"
			) {
				const patch = request.postDataJSON() as Record<string, unknown>;
				if (
					Object.keys(patch).every((key) => key === "draft") &&
					typeof patch.draft === "string"
				) {
					conversation = { ...conversation, draft: patch.draft };
					return route.fulfill({ json: { conversation } });
				}
			}
			unexpected.push(`${method} ${path}`);
			return route.abort();
		});
		await page.goto(`/tests/ai-browser/fixture.html?surface=${surface}`);
		const textarea = page.locator(".ai-rail-composer textarea");
		const transcript = page.locator(".ai-conversation");
		await expect(textarea).toBeEnabled();
		await expect(page.locator(".ai-conversation .ai-message-user")).toHaveCount(
			40,
		);
		await transcript.evaluate((element) => {
			element.scrollTop = 0;
		});
		await page.evaluate(
			() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
		);
		const before = await transcript.evaluate((element) => ({
			scrollTop: element.scrollTop,
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight,
		}));
		expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 100);
		await instrument(page);
		for (let index = 0; index < 20; index++) {
			await textarea.press("x");
			await expect
				.poll(() => page.evaluate(() => window.__aiBaseline.samples.length))
				.toBe(index + 1);
		}
		const draft = await textarea.inputValue();
		expect(draft).toBe("x".repeat(20));
		await expect.poll(() => conversation.draft).toBe(draft);
		const after = await transcript.evaluate((element) => element.scrollTop);
		await page.getByRole("button", { name: "Close AI assistant" }).click();
		await page.getByRole("button", { name: "Reopen assistant" }).click();
		await expect(textarea).toBeEnabled();
		await expect(page.locator(".ai-conversation .ai-message-user")).toHaveCount(
			40,
		);
		const restored = {
			draft: await textarea.inputValue(),
			scrollTop: await transcript.evaluate((element) => element.scrollTop),
		};
		const metrics = await page.evaluate(() => {
			const measurements = window.__aiBaseline;
			const samples = [...measurements.samples].sort((a, b) => a - b);
			const style = (selector: string) => {
				const element = document.querySelector(selector);
				if (!element) throw new Error(`Missing baseline element: ${selector}`);
				const computed = getComputedStyle(element);
				return {
					transition: computed.transitionDuration,
					animation: computed.animationDuration,
				};
			};
			const heap = (
				performance as Performance & {
					memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
				}
			).memory;
			const memory =
				heap && typeof heap.usedJSHeapSize === "number"
					? {
							usedJSHeapSize: heap.usedJSHeapSize,
							totalJSHeapSize: heap.totalJSHeapSize,
						}
					: null;
			return {
				...measurements,
				p50: samples[Math.ceil(samples.length * 0.5) - 1],
				p95: samples[Math.ceil(samples.length * 0.95) - 1],
				memory,
				reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
				rail: style(".ai-assistant-rail"),
				textarea: style(".ai-rail-composer textarea"),
			};
		});
		expect(metrics.reducedMotion).toBe(info.project.name === "reduced-motion");
		expect(metrics.samples).toHaveLength(20);
		expect(
			metrics.samples.every((value) => Number.isFinite(value) && value >= 0),
		).toBe(true);
		expect(Number.isFinite(metrics.p50) && metrics.p50 >= 0).toBe(true);
		expect(Number.isFinite(metrics.p95) && metrics.p95 >= 0).toBe(true);
		expect(
			metrics.memory === null ||
				(Number.isFinite(metrics.memory.usedJSHeapSize) &&
					metrics.memory.usedJSHeapSize >= 0),
		).toBe(true);
		await info.attach("ai-browser-baseline", {
			body: JSON.stringify(
				{
					schemaVersion: 1,
					fixtureVersion: "ai-rail-browser-v1",
					project: info.project.name,
					surface,
					browser: browser.version(),
					browserSource: process.env.DIFFING_AI_BROWSER_EXECUTABLE
						? "explicit-installed-executable"
						: "pinned-playwright",
					metricLabel: "keydown-to-second-animation-frame, not confirmed paint",
					longtaskWindow: "loaded component through typing and reopening",
					metrics,
					scroll: { before, after, restored: restored.scrollTop },
					draft: { typed: draft, restored: restored.draft },
					viewport: page.viewportSize(),
					unexpectedRequestCount: unexpected.length,
					acceptance:
						"component baseline only; integrated workflows and human visual review not verified",
				},
				null,
				2,
			),
			contentType: "application/json",
		});
		await info.attach("ai-browser-baseline-rail", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
		expect(unexpected, "unexpected requests").toEqual([]);
		expect(pageErrors, "page errors").toEqual([]);
	});
}
