// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createReviewCommentSchema } from "../lib/comment-schema.js";
import { editSaveSchema } from "../lib/file-schema.js";

const publishedRoot = join(process.cwd(), "skills");
const localRoot = join(process.cwd(), ".agents", "skills");
const expectedSkillNames = [
  "diffing",
  "diffing-finish-review",
  "diffing-mockup-author",
  "diffing-mockup-review",
  "diffing-plan-review",
  "diffing-pr-address",
  "diffing-pr-read",
  "diffing-release",
  "diffing-review",
  "diffing-start-review",
];
const expectedReferences = [
  "diffing/references/sessions-and-transports.md",
  "diffing/references/headless-api.md",
  "diffing/references/recovery-and-safety.md",
].sort();

function skillNames(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readSkill(root: string, name: string): string {
  return readFileSync(join(root, name, "SKILL.md"), "utf-8");
}

function regularFiles(root: string): string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      expect(
        entry.isSymbolicLink(),
        `symlink is not portable: ${relative(root, path)}`,
      ).toBe(false);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files.push(relative(root, path).split(sep).join("/"));
    }
  }
  walk(root);
  return files.sort();
}

/** Pure link extraction used by the filesystem contract and its in-memory fixtures. */
function extractLocalMarkdownLinks(markdown: string): string[] {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, "");
  return [...withoutFences.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)]
    .map((match) => match[1])
    .filter(
      (target) =>
        !/^(?:https?:|mailto:)/i.test(target) && !target.startsWith("#"),
    )
    .map((target) => target.split("#", 1)[0])
    .filter(Boolean);
}

function assertPortableMarkdownLinks(root: string): void {
  for (const path of regularFiles(root).filter((file) =>
    file.endsWith(".md"),
  )) {
    const absolute = join(root, path);
    for (const target of extractLocalMarkdownLinks(
      readFileSync(absolute, "utf-8"),
    )) {
      const resolved = resolve(absolute, "..", target);
      const rootRelative = relative(resolve(root), resolved);
      expect(
        !isAbsolute(rootRelative) &&
          rootRelative !== ".." &&
          !rootRelative.startsWith(`..${sep}`),
        `${path} links outside skills root: ${target}`,
      ).toBe(true);
      expect(
        existsSync(resolved),
        `${path} has a missing link target: ${target}`,
      ).toBe(true);
      expect(
        statSync(resolved).isFile(),
        `${path} link target is not a regular file: ${target}`,
      ).toBe(true);
    }
  }
}

describe("published agent skills", () => {
  it("keeps installable and repo-local skill trees byte-identical", () => {
    const published = skillNames(publishedRoot);
    expect(published).toEqual(expectedSkillNames);
    expect(skillNames(localRoot)).toEqual(published);

    const publishedFiles = regularFiles(publishedRoot);
    expect(regularFiles(localRoot)).toEqual(publishedFiles);
    for (const path of publishedFiles) {
      expect(readFileSync(join(localRoot, path))).toEqual(
        readFileSync(join(publishedRoot, path)),
      );
    }
  });

  it("uses portable metadata and natural-language triggers", () => {
    for (const name of skillNames(publishedRoot)) {
      const body = readSkill(publishedRoot, name);
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(body)?.[1];

      expect(frontmatter, `${name} frontmatter`).toBeDefined();
      expect(frontmatter).toContain(`name: ${name}`);
      const description = /^description: (.+)$/m.exec(frontmatter!)?.[1];
      expect(description, `${name} description`).toBeDefined();
      expect(description!.length).toBeGreaterThan(80);
      expect(description).not.toMatch(/invokes? \/diffing/);
      expect(body).not.toContain("run_in_background");
      expect(body).not.toContain("Bash tool");
      expect(body).not.toContain("See AGENTS.md");
    }
  });

  it("has the cookbook sections and exact portable references", () => {
    for (const root of [publishedRoot, localRoot]) {
      for (const name of expectedSkillNames) {
        const body = readSkill(root, name);
        for (const section of [
          "Use this when",
          "Before you start",
          "Recipe",
          "Recovery",
          "Done",
        ]) {
          expect(body, `${root}/${name} missing section`).toContain(
            `## ${section}`,
          );
        }
      }
      expect(
        regularFiles(root).filter((path) =>
          path.startsWith("diffing/references/"),
        ),
      ).toEqual(expectedReferences);
    }
  });

  it("keeps markdown links local and regular", () => {
    expect(
      extractLocalMarkdownLinks(
        [
          "[external](https://example.test/a)",
          "[mail](mailto:a@example.test)",
          "[same](#part)",
          "[relative](../sibling.md#part)",
          "```md\n[ignored](../outside.md)\n```",
        ].join("\n"),
      ),
    ).toEqual(["../sibling.md"]);
    expect(extractLocalMarkdownLinks("[sibling](../sibling.md)")).toEqual([
      "../sibling.md",
    ]);
    assertPortableMarkdownLinks(publishedRoot);
    assertPortableMarkdownLinks(localRoot);
  });

  it("documents registered MCP names and cookbook safety contracts", () => {
    const source = readFileSync(join(process.cwd(), "src", "mcp.ts"), "utf-8");
    const registered = [
      ...source.matchAll(
        /server\.(?:tool|registerTool)\s*\(\s*["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]);
    const cookbook = regularFiles(publishedRoot)
      .filter((path) => path.endsWith(".md"))
      .map((path) => readFileSync(join(publishedRoot, path), "utf-8"))
      .join("\n");
    expect(registered.length).toBeGreaterThan(50);
    for (const name of registered) {
      expect(cookbook, `missing MCP tool: ${name}`).toContain("`" + name + "`");
    }
    const review = readSkill(publishedRoot, "diffing-review");
    expect(review).not.toMatch(/call `diff_summary` until `complete` is true/);
    expect(review).toContain("omittedPaths");
    expect(review).toContain("complete");
    const recovery = readFileSync(
      join(publishedRoot, "diffing", "references", "recovery-and-safety.md"),
      "utf-8",
    );
    expect(recovery).toContain("fileSaved");
    expect(recovery).toContain("outcomeUnknown");
  });

  it("keeps the HTTP method/route catalog aligned with server registrations", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "server.ts"),
      "utf-8",
    );
    const registered = [
      ...source.matchAll(
        /app\.(get|post|put|patch|delete)\s*\(\s*["'](\/api\/[^"']+)["']/g,
      ),
    ].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
    const reference = readFileSync(
      join(publishedRoot, "diffing/references/headless-api.md"),
      "utf-8",
    );
    const documented = [
      ...reference.matchAll(
        /^\| (GET|POST|PUT|PATCH|DELETE) \| `(\/api\/[^`]+)` \|/gm,
      ),
    ].map((match) => `${match[1]} ${match[2]}`);
    expect(registered.length).toBeGreaterThan(100);
    expect(documented.sort()).toEqual(registered.sort());
  });

  it("runs the documented HTTP helper without leaking credentials or retrying", async () => {
    const reference = readFileSync(
      join(publishedRoot, "diffing/references/headless-api.md"),
      "utf-8",
    );
    const helper = /```js\n([\s\S]*?)\n```/.exec(reference)?.[1];
    expect(helper).toContain("function createDiffingApi");
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ conflict: true }),
      });
    const createApi = runInNewContext(`${helper}\ncreateDiffingApi`, {
      URL,
      AbortSignal,
      fetch,
    });
    for (const base of [
      "https://example.test",
      "http://example.test",
      "http://user:pass@127.0.0.1:1234",
      "http://127.0.0.1:1234?token=test",
    ]) {
      expect(() => createApi(base, "test-only-credential")).toThrow();
    }
    const api = createApi(
      "http://127.0.0.1:1234/gh/pr",
      "test-only-credential",
    );
    for (const path of [
      "https://example.test/api/comments",
      "//example.test/api/comments",
      "/not-api",
      "/api/comments?token=test",
    ]) {
      await expect(api(path)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      api("/api/comments", { method: "POST", body: { body: "Test" } }),
    ).resolves.toEqual({ ok: false, status: 409, data: { conflict: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url.href).toBe("http://127.0.0.1:1234/api/comments");
    expect(options.redirect).toBe("error");
    expect(options.headers["x-diffing-token"]).toBe("test-only-credential");
    expect(options.body).toBe(JSON.stringify({ body: "Test" }));
    fetch.mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      api("/api/comments", { method: "POST", body: {} }),
    ).rejects.toThrow("connection lost");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses real comment and edit-save payloads in the HTTP examples", async () => {
    const reference = readFileSync(
      join(publishedRoot, "diffing/references/headless-api.md"),
      "utf-8",
    );
    const blocks = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)].map(
      (match) => match[1],
    );
    const comment = blocks.find((block) => block.startsWith("const created ="));
    const edit = blocks.find((block) =>
      block.startsWith("const query = new URLSearchParams"),
    );
    expect(comment).toBeDefined();
    expect(edit).toBeDefined();
    const hash = "a".repeat(64);
    const api = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        data: { content: "old", missing: false, hash },
      });
    await runInNewContext(`(async () => {\n${comment}\n})()`, { api });
    const [commentPath, commentRequest] = api.mock.calls[0];
    expect(commentPath).toBe("/api/comments");
    expect(commentRequest.method).toBe("POST");
    expect(
      createReviewCommentSchema.safeParse(commentRequest.body).success,
    ).toBe(true);
    api.mockClear();
    await runInNewContext(`(async () => {\n${edit}\n})()`, {
      api,
      URLSearchParams,
      nextText: "new",
    });
    const query = new URL(api.mock.calls[0][0], "http://127.0.0.1");
    expect(query.pathname).toBe("/api/file-text");
    expect(query.searchParams.get("path")).toBe("src/app.ts");
    expect(query.searchParams.get("version")).toBe("new");
    const [savePath, saveRequest] = api.mock.calls[1];
    expect(savePath).toBe("/api/edit-save");
    expect(saveRequest.method).toBe("POST");
    expect(editSaveSchema.safeParse(saveRequest.body).success).toBe(true);
    expect(saveRequest.body.baseHash).toBe(hash);
  });
});
