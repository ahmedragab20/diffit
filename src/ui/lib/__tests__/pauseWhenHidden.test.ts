import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PAGE_HIDDEN_ATTRIBUTE,
  observePageVisibility,
} from "../pauseWhenHidden.js";

let stop: (() => void) | null = null;

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  stop?.();
  stop = null;
  setVisibility("visible");
  document.documentElement.removeAttribute(PAGE_HIDDEN_ATTRIBUTE);
});

describe("observePageVisibility", () => {
  it("marks the root hidden and clears it on return", () => {
    stop = observePageVisibility();
    expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTRIBUTE)).toBe(
      false,
    );
    setVisibility("hidden");
    expect(document.documentElement.getAttribute(PAGE_HIDDEN_ATTRIBUTE)).toBe(
      "true",
    );
    setVisibility("visible");
    expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTRIBUTE)).toBe(
      false,
    );
  });

  it("reflects a page that is already hidden when observation starts", () => {
    setVisibility("hidden");
    stop = observePageVisibility();
    // A first paint in a background tab must already be paused.
    expect(document.documentElement.getAttribute(PAGE_HIDDEN_ATTRIBUTE)).toBe(
      "true",
    );
  });

  it("stops reflecting and cleans up after teardown", () => {
    stop = observePageVisibility();
    stop();
    stop = null;
    setVisibility("hidden");
    expect(document.documentElement.hasAttribute(PAGE_HIDDEN_ATTRIBUTE)).toBe(
      false,
    );
  });

  it("is safe where there is no document", () => {
    expect(() => observePageVisibility(undefined)()).not.toThrow();
  });
});

describe("the stylesheet pauses on that state", () => {
  const gridline = readFileSync(
    resolve(process.cwd(), "src/ui/styles/gridline.css"),
    "utf8",
  );

  it("pauses animation while the page is hidden", () => {
    expect(gridline).toContain("html[data-page-hidden='true']");
    expect(gridline).toContain("animation-play-state: paused");
  });

  it("covers pseudo-elements, so an animation added later is included", () => {
    const block = gridline.slice(gridline.indexOf("html[data-page-hidden"));
    expect(block).toContain("*::before");
    expect(block).toContain("*::after");
  });

  it("is installed before the app renders", () => {
    const main = readFileSync(
      resolve(process.cwd(), "src/ui/main.tsx"),
      "utf8",
    );
    expect(main.indexOf("observePageVisibility()")).toBeLessThan(
      main.indexOf("createRoot("),
    );
  });
});
