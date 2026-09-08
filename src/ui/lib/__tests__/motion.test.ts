import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, scrollBehavior } from "../motion.js";

// jsdom implements no matchMedia, so each case installs the one it needs.
const queries: string[] = [];

function setMatchMedia(value: unknown) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value,
  });
}

function withMatchMedia(matches: boolean) {
  setMatchMedia((query: string) => {
    queries.push(query);
    return { matches, media: query } as MediaQueryList;
  });
}

afterEach(() => {
  setMatchMedia(undefined);
  queries.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prefersReducedMotion", () => {
  it("reports the user's preference", () => {
    withMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    withMatchMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("assumes no preference when matchMedia is unavailable", () => {
    setMatchMedia(undefined);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("assumes no preference when matchMedia throws", () => {
    setMatchMedia(() => {
      throw new Error("unsupported query");
    });
    expect(prefersReducedMotion()).toBe(false);
  });

  it("asks for the reduced-motion query specifically", () => {
    withMatchMedia(false);
    prefersReducedMotion();
    expect(queries).toEqual(["(prefers-reduced-motion: reduce)"]);
  });
});

describe("scrollBehavior", () => {
  it("keeps the preferred behavior when motion is welcome", () => {
    withMatchMedia(false);
    expect(scrollBehavior()).toBe("smooth");
    expect(scrollBehavior("smooth")).toBe("smooth");
  });

  it("downgrades to an instant jump under reduced motion", () => {
    withMatchMedia(true);
    expect(scrollBehavior()).toBe("auto");
    expect(scrollBehavior("smooth")).toBe("auto");
  });

  it("never upgrades an explicitly instant scroll", () => {
    withMatchMedia(false);
    expect(scrollBehavior("auto")).toBe("auto");
  });
});

describe("no hardcoded smooth scrolling remains", () => {
  const root = join(process.cwd(), "src", "ui");

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name === "__tests__") continue;
        out.push(...sources(path));
      } else if (/\.tsx?$/.test(name) && name !== "motion.ts") {
        out.push(path);
      }
    }
    return out;
  }

  it("routes every animated scroll through scrollBehavior", () => {
    // The scrollIntoView/scrollTo option overrides the CSS scroll-behavior
    // reset, so a literal "smooth" ignores the user's stated preference.
    const offenders: string[] = [];
    for (const path of sources(root)) {
      const text = readFileSync(path, "utf-8");
      for (const line of text.split("\n")) {
        if (!/behavior:\s*['"`]smooth['"`]/.test(line)) continue;
        // A type member such as `behavior: "smooth" | "auto"` is a declaration,
        // not a call that animates.
        if (line.includes("|")) continue;
        offenders.push(path.slice(process.cwd().length + 1));
        break;
      }
    }
    expect(offenders).toEqual([]);
  });
});
