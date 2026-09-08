import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const child = spawn(
	process.execPath,
	[
		require.resolve("@playwright/test/cli"),
		"test",
		"--config",
		"playwright.ai.config.ts",
		...process.argv.slice(2),
	],
	{
		stdio: "inherit",
		env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
	},
);
child.once("error", () => {
	process.exitCode = 1;
});
child.once("exit", (code) => {
	process.exitCode = code ?? 1;
});
