import { describe, expect, it } from "vitest";
import { sanitizeLanguageServers } from "../settings.js";

describe("sanitizeLanguageServers", () => {
  it("keeps a well-formed entry and normalizes the extension", () => {
    expect(
      sanitizeLanguageServers({ TS: { command: "tsserver", args: ["--stdio"] } }),
    ).toEqual({ ts: { command: "tsserver", args: ["--stdio"] } });
  });

  it("defaults absent args to an empty list", () => {
    expect(sanitizeLanguageServers({ rs: { command: "rust-analyzer" } })).toEqual(
      { rs: { command: "rust-analyzer", args: [] } },
    );
  });

  it.each([
    ["a non-object", 42],
    ["an array", [{ command: "x" }]],
    ["null", null],
  ])("treats %s as no configuration", (_label, value) => {
    expect(sanitizeLanguageServers(value)).toEqual({});
  });

  it.each([
    ["a missing command", { ts: {} }],
    ["a blank command", { ts: { command: "   " } }],
    ["a non-string command", { ts: { command: 7 } }],
    ["a non-array args", { ts: { command: "x", args: "--stdio" } }],
    ["a non-string arg", { ts: { command: "x", args: [1] } }],
    ["an oversized command", { ts: { command: "x".repeat(1025) } }],
    ["an oversized arg", { ts: { command: "x", args: ["y".repeat(1025)] } }],
    ["too many args", { ts: { command: "x", args: Array(33).fill("a") } }],
    ["an extension with a separator", { "../ts": { command: "x" } }],
    ["an extension with a space", { "t s": { command: "x" } }],
    ["an empty extension", { "": { command: "x" } }],
  ])("drops %s rather than repairing it", (_label, value) => {
    expect(sanitizeLanguageServers(value)).toEqual({});
  });

  it("drops only the malformed entry and keeps the rest", () => {
    expect(
      sanitizeLanguageServers({
        ts: { command: "tsserver" },
        rs: { command: "" },
      }),
    ).toEqual({ ts: { command: "tsserver", args: [] } });
  });
});
