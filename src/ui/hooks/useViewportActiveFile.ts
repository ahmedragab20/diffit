import { useEffect, useRef } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { isTypingInFocus } from "../utils";

export interface ViewportActiveFileOptions {
  explicitSuppressMs?: number;
  /** Retained for compatibility; tracking no longer polls while idle. */
  pollMs?: number;
}

/** Passive highlighting: observes visible cards, never focuses or scrolls them. */
export function useViewportActiveFileTracking(
  files: FileDiffMetadata[],
  activeFile: string | null,
  onActiveFileChange: (path: string) => void,
  explicitSelectionRef: React.MutableRefObject<number>,
  options: ViewportActiveFileOptions = {},
) {
  const active = useRef(activeFile);
  active.current = activeFile;
  const onChange = useRef(onActiveFileChange);
  onChange.current = onActiveFileChange;
  const lastMouse = useRef(0);
  const suppressMs = options.explicitSuppressMs ?? 250;

  useEffect(() => {
    const paths = new Set(files.map((file) => file.name));
    const cards = new Map<string, HTMLElement>();
    for (const path of paths) {
      const card = document.getElementById(`file-${path}`);
      if (card) cards.set(path, card);
    }
    const visible = new Set<string>();
    let raf = 0;
    let observer: IntersectionObserver | undefined;
    const apply = (path: string) => {
      if (path === active.current) return;
      active.current = path;
      onChange.current(path);
    };
    const detect = () => {
      raf = 0;
      if (isTypingInFocus()) return;
      if (
        Date.now() - explicitSelectionRef.current < suppressMs ||
        Date.now() - lastMouse.current < suppressMs
      )
        return;
      const height =
        window.innerHeight || document.documentElement.clientHeight;
      let best: string | undefined;
      let bestHeight = 0;
      for (const path of observer ? visible : cards.keys()) {
        const rect = cards.get(path)?.getBoundingClientRect();
        if (!rect) continue;
        const shown = Math.max(
          0,
          Math.min(rect.bottom, height) - Math.max(rect.top, 0),
        );
        if (shown > bestHeight) {
          best = path;
          bestHeight = shown;
        }
      }
      if (best) apply(best);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(detect);
    };
    const hover = (event: MouseEvent) => {
      if (isTypingInFocus()) return;
      const target =
        event.target instanceof Element
          ? event.target.closest('[id^="file-"]')
          : null;
      const path = target?.id.slice(5);
      if (path && paths.has(path)) {
        lastMouse.current = Date.now();
        apply(path);
      }
    };
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const path = entry.target.id.slice(5);
          if (entry.isIntersecting) visible.add(path);
          else visible.delete(path);
        }
        schedule();
      });
      for (const card of cards.values()) observer.observe(card);
    }
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("mouseover", hover, { passive: true });
    schedule();
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("mouseover", hover);
    };
  }, [files, explicitSelectionRef, suppressMs]);
}
