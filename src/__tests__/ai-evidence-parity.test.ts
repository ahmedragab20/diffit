// @vitest-environment node
// Contract parity for the AI evidence surface: every MCP tool must call a real
// HTTP route with a matching method, and every route must be reachable from
// MCP. Drift in either direction is a contract break, not a documentation nit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const mcpSource = readFileSync(join(root, "src", "mcp.ts"), "utf-8");
const serverSource = readFileSync(join(root, "src", "server.ts"), "utf-8");

interface Call {
  tool: string;
  method: string;
  route: string;
}

/** Normalizes a template-literal request path to its registered route shape. */
function normalize(path: string): string {
  return path
    .replace(/\$\{encodeURIComponent\([^)]*\)\}/g, ":id")
    .replace(/\?\$\{[^}]*\}/g, "")
    .replace(/\$\{[^}]*\}/g, "")
    .replace(/\?.*$/, "");
}

function mcpEvidenceCalls(): Call[] {
  const blocks = mcpSource.split("server.registerTool(").slice(1);
  const calls: Call[] = [];
  for (const block of blocks) {
    const tool = /^\s*"(ai_evidence_[a-z_]+)"/.exec(block)?.[1];
    if (!tool) continue;
    // The split already bounds each block at the next registration.
    const body = block;
    const path = /[`"](\/api\/ai\/evidence[^`"]*)[`"]/.exec(body)?.[1];
    expect(path, `${tool} must call an /api/ai/evidence route`).toBeTruthy();
    calls.push({
      tool,
      method: /method:\s*"POST"/.test(body) ? "POST" : "GET",
      route: normalize(path!),
    });
  }
  return calls;
}

function serverEvidenceRoutes(): Call[] {
  return [
    ...serverSource.matchAll(
      /app\.(get|post)\s*\(\s*"(\/api\/ai\/evidence[^"]*)"/g,
    ),
  ].map((match) => ({
    tool: "",
    method: match[1].toUpperCase(),
    route: match[2],
  }));
}

describe("AI evidence HTTP/MCP contract parity", () => {
  const calls = mcpEvidenceCalls();
  const routes = serverEvidenceRoutes();

  it("registers a route for every evidence surface", () => {
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });

  it.each(calls.map((call) => [call.tool, call] as const))(
    "%s calls a registered route with a matching method",
    (_tool, call) => {
      const match = routes.find(
        (route) => route.route === call.route && route.method === call.method,
      );
      expect(
        match,
        `no ${call.method} ${call.route} is registered in server.ts`,
      ).toBeDefined();
    },
  );

  it("leaves no evidence route unreachable from MCP", () => {
    const reachable = new Set(calls.map((call) => `${call.method} ${call.route}`));
    const unreachable = routes
      .map((route) => `${route.method} ${route.route}`)
      .filter((key) => !reachable.has(key));
    expect(unreachable).toEqual([]);
  });

  it("keeps every evidence tool and route read-only in shape", () => {
    // No evidence route may be registered with a mutating verb.
    const mutating = [
      ...serverSource.matchAll(
        /app\.(put|patch|delete)\s*\(\s*"(\/api\/ai\/evidence[^"]*)"/g,
      ),
    ];
    expect(mutating.map((match) => match[2])).toEqual([]);
  });
});
