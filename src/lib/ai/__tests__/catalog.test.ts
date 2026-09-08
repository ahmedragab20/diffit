// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CATALOG_LIMITS,
  CodexCatalogDecoder,
  parseDirectCatalog,
  parseModelLines,
  readCatalogResponse,
  runCodexCatalog,
} from "../catalog.js";

const errCode = async (work: Promise<unknown>, code: string) => {
  await expect(work).rejects.toMatchObject({ code });
};

describe("offline catalog parsers", () => {
  it.each([
    [{ data: [{ id: "gpt-4", input_modalities: ["text", "image"] }] }],
    [{ models: [{ id: "gpt-4" }] }],
  ])("accepts direct wrapper %j", (value) =>
    expect(parseDirectCatalog(value)).toHaveLength(1),
  );
  it.each([
    null,
    [],
    {},
    { data: null },
    { data: [null] },
    { data: [{ id: "" }] },
    { data: [{ id: "bad id" }] },
    { data: [{ id: "x", input_modalities: "text" }] },
  ])("rejects malformed direct catalog %j", (value) =>
    expect(() => parseDirectCatalog(value)).toThrow(),
  );
  it("rejects duplicate and oversized direct catalogs", () => {
    expect(() =>
      parseDirectCatalog({ data: [{ id: "x" }, { id: "x" }] }),
    ).toThrow();
    expect(() =>
      parseDirectCatalog({
        data: Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}` })),
      }),
    ).toThrow();
  });

  it("parses nested model lines, deduplicating IDs", () =>
    expect(
      parseModelLines(
        "Models:\n* provider/gpt-4 - preferred\nprovider/gpt-4\nprovider/sonnet\n",
      ),
    ).toEqual(["provider/gpt-4", "provider/sonnet"]));
  it.each([
    "provider/" + "x".repeat(513),
    "garbage line\nsecond garbage",
    "provider/gpt\nnot valid!",
  ])("rejects model-line protocol errors", (output) =>
    errCode(
      Promise.resolve().then(() => parseModelLines(output)),
      "protocol_error",
    ),
  );
  it("bounds model lines", () => {
    expect(() =>
      parseModelLines(
        Array.from({ length: 1001 }, (_, i) => `m${i}`).join("\n"),
      ),
    ).toThrow();
    expect(() =>
      parseModelLines("x".repeat(CATALOG_LIMITS.bytes + 1)),
    ).toThrow();
    expect(() => parseModelLines("m\n".repeat(2))).not.toThrow();
  });
});

describe("CodexCatalogDecoder", () => {
  const init = () => {
    const d = new CodexCatalogDecoder();
    expect(d.start()).toMatchObject({ id: 1, method: "initialize" });
    expect(d.accept({ id: 1, result: {} })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "initialized" }),
        expect.objectContaining({ id: 2, method: "model/list" }),
      ]),
    );
    return d;
  };
  it("decodes metadata, images, and pagination", () => {
    const d = init();
    expect(
      d.accept({
        id: 2,
        result: {
          data: [
            {
              model: "gpt",
              displayName: "GPT",
              supportedReasoningEfforts: ["low", { reasoningEffort: "high" }],
              serviceTiers: ["fast", { id: "standard" }],
              inputModalities: ["text", "image"],
            },
          ],
          nextCursor: "next",
        },
      }),
    ).toMatchObject([{ id: 3 }]);
    expect(d.accept({ id: 3, result: { data: [{ id: "sonnet" }] } })).toEqual(
      [],
    );
    expect(d.finish()).toMatchObject([
      {
        id: "gpt",
        supportsImages: true,
        reasoningEfforts: ["low", "high"],
        serviceTiers: ["fast", "standard"],
      },
      { id: "sonnet", supportsImages: false },
    ]);
  });
  it.each([
    () => {
      const d = init();
      d.finish();
    },
    () => {
      const d = init();
      d.accept({ id: 3, result: { data: [] } });
    },
    () => {
      const d = init();
      d.accept({ id: 2, result: { data: [{ id: "x" }], nextCursor: "c" } });
      d.accept({ id: 2, result: { data: [] } });
    },
    () => {
      const d = init();
      d.accept({ id: 9, method: "tool/run" });
    },
    () => {
      const d = init();
      d.accept({ id: 2, error: { message: "private" } });
    },
    () => {
      const d = init();
      d.accept({ id: 2, result: { data: [null] } });
    },
    () => {
      const d = init();
      d.accept({
        id: 2,
        result: { data: [{ id: "x", supportedReasoningEfforts: [null] }] },
      });
    },
    () => {
      const d = init();
      d.accept({ id: 2, result: { data: [{ id: "x" }], nextCursor: "c" } });
      d.accept({ id: 3, result: { data: [], nextCursor: "c" } });
    },
    () => {
      const d = init();
      d.accept({ id: 2, result: { data: [{ id: "x" }, { id: "x" }] } });
    },
    () => {
      const d = init();
      d.accept({
        id: 2,
        result: {
          data: Array.from({ length: 101 }, (_, i) => ({ id: `m${i}` })),
        },
      });
    },
  ])("rejects malformed decoder exchange", (caseFn) =>
    expect(caseFn).toThrow(),
  );
  it("rejects more than 1000 models and 20 pages", () => {
    const d = init();
    for (let page = 0; page < 10; page++) {
      d.accept({
        id: page + 2,
        result: {
          data: Array.from({ length: 100 }, (_, i) => ({
            id: `m${page * 100 + i}`,
          })),
          nextCursor: `page${page}`,
        },
      });
    }
    expect(() =>
      d.accept({ id: 12, result: { data: [{ id: "overflow" }] } }),
    ).toThrow(expect.objectContaining({ code: "resource_limit" }));
    const p = init();
    for (let i = 0; i < 19; i++)
      p.accept({
        id: i + 2,
        result: { data: [{ id: `x${i}` }], nextCursor: `c${i}` },
      });
    expect(() =>
      p.accept({
        id: 21,
        result: { data: [{ id: "last" }], nextCursor: "too-many" },
      }),
    ).toThrow(expect.objectContaining({ code: "resource_limit" }));
  });
});

describe("catalog response and codex process", () => {
  it("reads JSON including split UTF-8 and ignores Content-Length", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: "café" }));
    const split = bytes.indexOf(0xc3) + 1;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, split));
        c.enqueue(bytes.slice(split));
        c.close();
      },
    });
    await expect(
      readCatalogResponse(
        new Response(body, { headers: { "content-length": "1" } }),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ name: "café" });
  });
  it.each(["{", new Uint8Array([0xff, 0xfe])])(
    "rejects invalid response safely",
    async (value) => {
      await errCode(
        readCatalogResponse(new Response(value), new AbortController().signal),
        "protocol_error",
      );
    },
  );
  it("cancels and unlocks oversized and aborted response streams", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(CATALOG_LIMITS.bytes + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    const response = new Response(stream);
    await errCode(
      readCatalogResponse(response, new AbortController().signal),
      "resource_limit",
    );
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
    const abort = new AbortController();
    let cancel2 = false;
    const pending = new ReadableStream<Uint8Array>({
      cancel() {
        cancel2 = true;
      },
    });
    const promise = readCatalogResponse(new Response(pending), abort.signal);
    abort.abort();
    await errCode(promise, "preparation_timeout");
    expect(cancel2).toBe(true);
    expect(pending.locked).toBe(false);
  });

  const script = (mode: string) =>
    `const r=require('node:readline').createInterface({input:process.stdin}); let n=0; process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),10)); r.on('line',l=>{const q=JSON.parse(l); if(q.method==='initialize') process.stdout.write(JSON.stringify({id:1,result:{}})+'\\n'); else if(q.method==='model/list'){n++; ${mode === "normal" ? "process.stdout.write(JSON.stringify({id:2,result:{data:[{id:'gpt'}]}})+'\\n')" : mode === "bad" ? "process.stdout.write('{\\\"bad\\\"\\n')" : mode === "eof" ? "process.exit(0)" : mode === "stderr" ? "process.stderr.write('x'.repeat(70000))" : mode === "frame" ? "process.stdout.write('x'.repeat(1024*1024+1)+'\\n')" : "setInterval(()=>{},1000)"} }})`;
  it("runs a synthetic codex child successfully", async () =>
    await expect(
      runCodexCatalog(process.execPath, ["-e", script("normal")], 500),
    ).resolves.toMatchObject([{ id: "gpt" }]));
  it("does not resolve until its child has closed", async () => {
    const source = script("normal").replace(
      "id:'gpt'",
      "id:String(process.pid)",
    );
    const models = await runCodexCatalog(
      process.execPath,
      ["-e", source],
      1000,
    );
    const pid = Number(models[0].id);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    // Signal 0 only checks existence; it sends no signal to the fixture process.
    expect(() => process.kill(pid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" }),
    );
  });
  it.each([
    ["bad", "protocol_error"],
    ["eof", "protocol_error"],
    ["stderr", "resource_limit"],
    ["frame", "resource_limit"],
    ["hold", "preparation_timeout"],
  ])("rejects synthetic codex child: %s", async (mode, code) => {
    await expect(
      runCodexCatalog(
        process.execPath,
        ["-e", script(mode)],
        mode === "hold" ? 50 : 500,
      ),
    ).rejects.toMatchObject({ code });
  });
  it("rejects an unexpected nonzero child exit", async () => {
    await expect(
      runCodexCatalog(process.execPath, ["-e", "process.exit(2)"], 500),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/capability_unavailable|protocol_error/),
    });
  });
});
