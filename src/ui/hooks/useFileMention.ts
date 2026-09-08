import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { FileHit, FilesResponse } from "../lib/searchTypes";

interface MentionState {
  atStart: number;
  query: string;
}

function findMentionTrigger(
  text: string,
  cursorPos: number,
): MentionState | null {
  const before = text.slice(0, cursorPos);
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = before[i];
    if (ch === "@") {
      if (i === 0 || /\s/.test(before[i - 1])) {
        const query = before.slice(i + 1);
        if (!/\s/.test(query)) {
          return { atStart: i, query };
        }
      }
      return null;
    }
    if (ch === "\n") return null;
  }
  return null;
}

export interface UseFileMentionResult {
  isOpen: boolean;
  results: FileHit[];
  focusedIndex: number;
  query: string;
  isFetching: boolean;
  cursorTop: number;
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  onSelect: (path: string) => void;
  setFocusedIndex: (i: number) => void;
  setTextareaRef: (el: HTMLTextAreaElement | null) => void;
}

export function useFileMention(
  text: string,
  setText: (text: string) => void,
): UseFileMentionResult {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [textareaEl, setTextareaEl] = useState<HTMLTextAreaElement | null>(
    null,
  );
  const [mention, setMention] = useState<MentionState | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [cursorTop, setCursorTop] = useState(0);
  const lastCursorRef = useRef(0);
  // Mirror the latest text so caret/scroll listeners can recompute position
  // against the current value without re-binding on every keystroke.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const setTextareaRef = useCallback((el: HTMLTextAreaElement | null) => {
    textareaRef.current = el;
    setTextareaEl(el);
  }, []);

  /**
   * Resolve the active @-mention (if any) and the dropdown's `top` relative to
   * the textarea's offset parent. The caret Y is mapped into the *visible*
   * textarea viewport by subtracting `scrollTop`, so multi-line bodies that
   * scroll keep the dropdown glued to the caret rather than drifting with the
   * unscrolled content origin. `lineHeight` falls back to a font-size-based
   * estimate when the computed value is non-numeric (e.g. "normal", which
   * happens for hosts that inherit `font: inherit` with no explicit line-height).
   */
  const recompute = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart;
    lastCursorRef.current = cursor;
    const current = textRef.current;
    const m = findMentionTrigger(current, cursor);
    setMention(m);
    if (!m) return;
    setFocusedIndex(0);
    const cs = getComputedStyle(ta);
    let lineHeight = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineHeight)) {
      const fontSize = parseFloat(cs.fontSize) || 14;
      lineHeight = fontSize * 1.5;
    }
    const textBefore = current.slice(0, cursor);
    const lineNumber = (textBefore.match(/\n/g) || []).length;
    const paddingTop = parseFloat(cs.paddingTop) || 0;
    const caretBottom =
      paddingTop + (lineNumber + 1) * lineHeight - ta.scrollTop;
    setCursorTop(caretBottom + 4);
  }, []);

  // Typing changes the body → re-evaluate the mention and reposition the dropdown.
  useEffect(() => {
    recompute();
  }, [text, recompute]);

  // Reposition when the caret moves or the textarea scrolls without a body
  // change (mouse clicks, selection, scroll within a long draft). findMentionTrigger
  // closes the mention if the caret leaves the @query; until then the dropdown
  // keeps tracking the caret.
  useEffect(() => {
    if (!textareaEl) return;
    const handler = () => recompute();
    textareaEl.addEventListener("scroll", handler);
    textareaEl.addEventListener("select", handler);
    textareaEl.addEventListener("click", handler);
    return () => {
      textareaEl.removeEventListener("scroll", handler);
      textareaEl.removeEventListener("select", handler);
      textareaEl.removeEventListener("click", handler);
    };
  }, [textareaEl, recompute]);

  const query = mention?.query ?? "";

  const result = useQuery<FilesResponse>({
    queryKey: ["file-mention", query],
    enabled: mention !== null,
    placeholderData: keepPreviousData,
    staleTime: 5_000,
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({ scope: "files", query }),
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      return (await res.json()) as FilesResponse;
    },
  });

  const items = result.data?.items ?? [];
  const isOpen = mention !== null && (items.length > 0 || result.isFetching);

  const commitSelection = useCallback(
    (path: string) => {
      if (!mention) return;
      const ta = textareaRef.current;
      if (!ta) return;
      const before = text.slice(0, mention.atStart);
      const after = text.slice(lastCursorRef.current);
      const inserted = `@${path} `;
      const next = before + inserted + after;
      setText(next);
      setMention(null);
      requestAnimationFrame(() => {
        const pos = (before + inserted).length;
        ta.selectionStart = ta.selectionEnd = pos;
        ta.focus({ preventScroll: true });
      });
    },
    [mention, text, setText],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!isOpen) return false;
      // While an input method is composing, these keys belong to it: arrows
      // move through candidates and Enter commits one. Intercepting them
      // replaces the user's candidate with a file mention. `keyCode === 229`
      // is the legacy signal browsers use when `isComposing` is unavailable.
      const native = e.nativeEvent as Partial<KeyboardEvent> | undefined;
      if (native?.isComposing || native?.keyCode === 229) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const len = items.length;
        if (len > 0) setFocusedIndex((i) => (i + 1) % len);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const len = items.length;
        if (len > 0) setFocusedIndex((i) => (i === 0 ? len - 1 : i - 1));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (items[focusedIndex]) {
          e.preventDefault();
          commitSelection(items[focusedIndex].path);
          return true;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return true;
      }
      return false;
    },
    [isOpen, items, focusedIndex, commitSelection],
  );

  const onSelect = useCallback(
    (path: string) => commitSelection(path),
    [commitSelection],
  );

  return {
    isOpen,
    results: items,
    focusedIndex,
    query,
    isFetching: result.isFetching,
    cursorTop,
    handleKeyDown,
    onSelect,
    setFocusedIndex,
    setTextareaRef,
  };
}
