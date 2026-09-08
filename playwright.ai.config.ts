import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { defineConfig } from "@playwright/test";

const repoId = createHash("sha256")
	.update(process.cwd())
	.digest("hex")
	.slice(0, 12);

export default defineConfig({
	testDir: "./tests/ai-browser",
	outputDir: `${homedir()}/.diffing/ai-browser/${repoId}/results`,
	workers: 1,
	retries: 0,
	timeout: 30_000,
	reporter: [
		["list"],
		[
			"json",
			{ outputFile: `${homedir()}/.diffing/ai-browser/${repoId}/report.json` },
		],
	],
	use: {
		baseURL: "http://127.0.0.1:4179",
		browserName: "chromium",
		serviceWorkers: "block",
		trace: "off",
		launchOptions: {
			executablePath: process.env.DIFFING_AI_BROWSER_EXECUTABLE || undefined,
		},
	},
	projects: [
		{ name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
		{ name: "narrow", use: { viewport: { width: 390, height: 844 } } },
		{
			name: "reduced-motion",
			use: { viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" },
		},
	],
	webServer: {
		command: "pnpm exec vite --config tests/ai-browser/vite.config.ts",
		url: "http://127.0.0.1:4179/tests/ai-browser/fixture.html",
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
