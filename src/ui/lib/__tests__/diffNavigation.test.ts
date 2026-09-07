// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelDiffNavigation,
  navigateToDiffLine,
  registerDiffTarget,
  scheduleDiffNavigation,
} from "../diffNavigation";

let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextId = 1;
const cleanups: Array<() => void> = [];
function register(
  path: string,
  target: Parameters<typeof registerDiffTarget>[1],
) {
  const cleanup = registerDiffTarget(path, target);
  cleanups.push(cleanup);
  return cleanup;
}

beforeEach(() => {
  queue = [];
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue = queue.filter((frame) => frame.id !== id);
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cancelDiffNavigation();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function frame() {
  const next = queue.shift();
  next?.cb(performance.now());
}

describe("diff navigation", () => {
  it("latest scheduled navigation wins", () => {
    const first = vi.fn(() => false);
    const second = vi.fn(() => true);
    scheduleDiffNavigation(first);
    scheduleDiffNavigation(second);
    frame();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it.each(["wheel", "keydown"] as const)("interrupts on %s", (type) => {
    const step = vi.fn(() => false);
    scheduleDiffNavigation(step);
    window.dispatchEvent(new Event(type));
    frame();
    expect(step).not.toHaveBeenCalled();
  });

  it("explicit cancellation stops queued frames", () => {
    const step = vi.fn(() => false);
    const cancel = scheduleDiffNavigation(step);
    cancel();
    frame();
    expect(step).not.toHaveBeenCalled();
  });

  it("navigates to a registered distant line without rows or checkbox clicks", () => {
    const card = document.createElement("div");
    card.id = "file-src/large.ts";
    document.body.append(card);
    const unregister = register("src/large.ts", {
      reveal: vi.fn(),
      position: (line) => (line === 9000 ? 12000 : undefined),
    });
    navigateToDiffLine("src/large.ts", 9000, "additions");
    frame();
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 11744,
      behavior: "auto",
    });
    unregister();
  });

  it("stops when the target card is disconnected", () => {
    const card = document.createElement("div");
    card.id = "file-src/file.ts";
    document.body.append(card);
    register("src/file.ts", { reveal: vi.fn(), position: () => 1000 });
    navigateToDiffLine("src/file.ts", 10, "additions");
    card.remove();
    frame();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it("onArrive retries without re-scrolling", () => {
    const card = document.createElement("div");
    card.id = "file-src/file.ts";
    document.body.append(card);
    const onArrive = vi.fn(() => true).mockReturnValueOnce(false);
    register("src/file.ts", { reveal: vi.fn(), position: () => 1000 });
    navigateToDiffLine("src/file.ts", 10, "additions", onArrive);
    frame();
    frame();
    frame();
    expect(window.scrollTo).toHaveBeenCalledOnce();
    expect(onArrive).toHaveBeenCalledTimes(2);
  });
});
