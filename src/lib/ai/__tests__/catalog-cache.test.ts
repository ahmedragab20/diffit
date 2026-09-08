// @vitest-environment node
// The retained codex catalog: option gating on a run must reuse the generation
// the model list was built from instead of spawning a second app-server. The
// child-process seam is mocked so the default `spawn("codex", ...)` path runs a
// synthetic node child; the real codex binary is never executed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("../child-process.js", () => ({ spawn: mocks.spawn }));

import { spawn as realSpawn } from "node:child_process";
import { codexModelCatalog, resetCodexModelCatalog } from "../catalog.js";

const RESPONDS = `const r=require('node:readline').createInterface({input:process.stdin}); process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),10)); r.on('line',l=>{const q=JSON.parse(l); if(q.method==='initialize') process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n'); else if(q.method==='model/list') process.stdout.write(JSON.stringify({id:2,result:{data:[{id:'gpt'}]}})+'\\n');})`;
const EXITS_NONZERO = "process.exit(2)";

function child(source: string) {
	mocks.spawn.mockImplementation(() =>
		realSpawn(process.execPath, ["-e", source], {
			stdio: ["pipe", "pipe", "pipe"],
		}),
	);
}

beforeEach(() => {
	mocks.spawn.mockReset();
	resetCodexModelCatalog();
});

describe("retained codex model catalog", () => {
	it("serves a second read without spawning another app-server", async () => {
		child(RESPONDS);
		await expect(codexModelCatalog()).resolves.toMatchObject([{ id: "gpt" }]);
		await expect(codexModelCatalog()).resolves.toMatchObject([{ id: "gpt" }]);
		expect(mocks.spawn).toHaveBeenCalledOnce();
	});

	it("re-runs discovery after an explicit reset", async () => {
		child(RESPONDS);
		await codexModelCatalog();
		resetCodexModelCatalog();
		await codexModelCatalog();
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
	});

	it("never retains a failure", async () => {
		child(EXITS_NONZERO);
		await expect(codexModelCatalog()).rejects.toMatchObject({
			code: "protocol_error",
		});
		await expect(codexModelCatalog()).rejects.toBeDefined();
		expect(mocks.spawn).toHaveBeenCalledTimes(2);
	});
});
