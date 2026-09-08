import { describe, expect, it } from "vitest";
import {
  RAIL_WIDTH,
  clampRailWidth,
  railWidthBounds,
} from "../railWidth.js";

const WIDE = 1920;

describe("clampRailWidth on a wide window", () => {
  it("keeps a width already inside the range", () => {
    expect(clampRailWidth(480, WIDE)).toBe(480);
  });

  it("clamps to the minimum and maximum", () => {
    expect(clampRailWidth(10, WIDE)).toBe(RAIL_WIDTH.min);
    expect(clampRailWidth(5000, WIDE)).toBe(RAIL_WIDTH.max);
  });
});

describe("clampRailWidth on a narrow window", () => {
  it("never consumes the diff gutter", () => {
    // 900px window: at most 900 - 360 = 540 for the rail.
    expect(clampRailWidth(720, 900)).toBe(540);
  });

  it("lets a narrow window override the usual minimum", () => {
    // 640px window leaves 280, below the 320 minimum but above collapse.
    expect(clampRailWidth(480, 640)).toBe(280);
  });

  it("collapses when the window cannot fit a usable rail", () => {
    expect(clampRailWidth(400, 560)).toBeNull();
    expect(clampRailWidth(400, 200)).toBeNull();
  });

  it("keeps a rail exactly at the collapse threshold", () => {
    const viewport = RAIL_WIDTH.gutter + RAIL_WIDTH.collapseBelow;
    expect(clampRailWidth(400, viewport)).toBe(RAIL_WIDTH.collapseBelow);
  });

  it("shrinks a persisted wide width when the window narrows", () => {
    const persisted = 700;
    expect(clampRailWidth(persisted, WIDE)).toBe(700);
    // The same persisted width must not overflow a smaller window.
    const narrowed = clampRailWidth(persisted, 800);
    expect(narrowed).not.toBeNull();
    expect(narrowed!).toBeLessThanOrEqual(800 - RAIL_WIDTH.gutter);
  });
});

describe("clampRailWidth input safety", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the minimum for %j",
    (value) => {
      expect(clampRailWidth(value, WIDE)).toBe(RAIL_WIDTH.min);
      expect(clampRailWidth(480, value)).toBe(RAIL_WIDTH.min);
    },
  );

  it("always returns a whole pixel", () => {
    expect(Number.isInteger(clampRailWidth(480.6, WIDE))).toBe(true);
    expect(Number.isInteger(clampRailWidth(400, 901)!)).toBe(true);
  });
});

describe("persisted width across window sizes", () => {
  it.each([
    ["a phone-width window", 420],
    ["a split-screen window", 720],
    ["a laptop window", 1280],
    ["a wide display", 2560],
  ])("keeps the rail inside %s", (_label, viewport) => {
    const width = clampRailWidth(RAIL_WIDTH.max, viewport);
    if (width === null) {
      // Collapsing is the correct answer only when no usable rail fits.
      expect(viewport - RAIL_WIDTH.gutter).toBeLessThan(RAIL_WIDTH.collapseBelow);
      return;
    }
    expect(width).toBeLessThanOrEqual(viewport - RAIL_WIDTH.gutter);
    expect(width).toBeGreaterThanOrEqual(RAIL_WIDTH.collapseBelow);
  });

  it("is idempotent, so re-clamping on every resize event is stable", () => {
    const once = clampRailWidth(900, 1000);
    expect(once).not.toBeNull();
    expect(clampRailWidth(once!, 1000)).toBe(once);
  });
});

describe("announced bounds match what a resize can produce", () => {
  it("reports the nominal range on a wide window", () => {
    expect(railWidthBounds(WIDE)).toEqual({
      min: RAIL_WIDTH.min,
      max: RAIL_WIDTH.max,
    });
  });

  it("narrows the announced maximum with the window", () => {
    // 900px leaves 540 for the rail, so announcing 720 would be a lie.
    expect(railWidthBounds(900).max).toBe(540);
  });

  it("lowers the announced minimum when the window forces it", () => {
    const bounds = railWidthBounds(640);
    expect(bounds.max).toBe(280);
    expect(bounds.min).toBeLessThanOrEqual(bounds.max);
  });

  it("never announces a minimum above its maximum", () => {
    for (const viewport of [320, 480, 600, 720, 900, 1280, 2560]) {
      const bounds = railWidthBounds(viewport);
      expect(bounds.min).toBeLessThanOrEqual(bounds.max);
    }
  });

  it("brackets every width the clamp can actually return", () => {
    for (const viewport of [640, 900, 1280, 2560]) {
      const bounds = railWidthBounds(viewport);
      for (const requested of [0, 300, 500, 5000]) {
        const width = clampRailWidth(requested, viewport);
        if (width === null) continue;
        expect(width).toBeGreaterThanOrEqual(bounds.min);
        expect(width).toBeLessThanOrEqual(bounds.max);
      }
    }
  });

  it("falls back to the nominal range for a non-finite viewport", () => {
    expect(railWidthBounds(Number.NaN)).toEqual({
      min: RAIL_WIDTH.min,
      max: RAIL_WIDTH.max,
    });
  });
});
