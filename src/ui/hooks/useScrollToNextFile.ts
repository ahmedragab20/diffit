import { useCallback, useEffect, useRef } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { scheduleDiffNavigation } from "../lib/diffNavigation";
import { prefersReducedMotion } from "../lib/motion.js";

export interface ScrollDecisionViewport {
  top: number;
  bottom: number;
  height: number;
}
export interface ScrollDecision {
  targetId: string | null;
  behavior: "smooth" | "auto";
}
export interface DecideScrollInput {
  files: FileDiffMetadata[];
  currentPath: string;
  viewport?: ScrollDecisionViewport;
  reduce: boolean;
}
export interface ScrollToNextFileOptions {
  viewport?: ScrollDecisionViewport;
  reduce?: boolean;
}

export function decideScroll({
  files,
  currentPath,
  viewport,
  reduce,
}: DecideScrollInput): ScrollDecision {
  const behavior = reduce ? "auto" : "smooth";
  const index = files.findIndex((file) => file.name === currentPath);
  if (
    index < 0 ||
    index >= files.length - 1 ||
    (viewport &&
      (viewport.top >= viewport.height * 0.6 || viewport.bottom <= 0))
  ) {
    return { targetId: null, behavior };
  }
  return { targetId: `file-${files[index + 1].name}`, behavior };
}

/** Explicit viewed-advance, not an effect of scrolling or ordinary collapse. */
export function useScrollToNextFile(_files: FileDiffMetadata[]) {
  const cancelRef = useRef<(() => void) | undefined>(undefined);
  const lastTarget = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);

  return useCallback((path: string, opts?: ScrollToNextFileOptions) => {
    const current = document.getElementById(`file-${path}`);
    if (!current) return;
    let next = current.nextElementSibling;
    while (next && !next.id.startsWith("file-")) next = next.nextElementSibling;
    if (!next) return;
    const id = next.id;
    const now = Date.now();
    if (lastTarget.current?.id === id && now - lastTarget.current.at < 250)
      return;
    lastTarget.current = { id, at: now };
    const reduce =
      opts?.reduce ??
      prefersReducedMotion() ??
      false;
    let frame = 0;
    cancelRef.current = scheduleDiffNavigation(() => {
      if (++frame < 2) return false;
      document.getElementById(id)?.scrollIntoView({
        block: "start",
        behavior: reduce ? "auto" : "smooth",
      });
      return true;
    }, 2);
  }, []);
}
