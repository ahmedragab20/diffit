/**
 * In-place edit sessions for the diff review surface (P1).
 *
 * Each session is keyed by repo-relative file path and owns:
 * - `seedContent`  — the last saved document, not the live draft. Updated
 *   after a successful save; never fed back on each keystroke.
 * - `draft`        — the latest live document text, kept in a ref mirror so
 *   save/markers callbacks never capture stale state.
 * - `baseHash`     — sha256 of the file as it was when the session started;
 *   sent to `/api/edit-save` for the disk conflict check.
 * - `annotations`  — the remapped annotation collection emitted by the editor
 *   (identity-stable: ordinary typing reuses the same array, structural edits
 *   emit a new one). The renderer owns their placement during editing.
 *
 * Flow: enterEdit loads the lazy `@pierre/diffs/edit` module and the current
 * file text (+hash), then the card renders the full-context surface with
 * `edit` enabled. Save writes the whole file atomically on the server,
 * persists remapped comment anchors, and the SSE `change` event refreshes the
 * diff. Discard remounts the surface from the last saved seed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DiffLineAnnotation,
  FileContents,
  LineAnnotation,
} from "@pierre/diffs";
import type { Editor, EditorFactory, TextEdit } from "@pierre/diffs/edit";
import { ensureEditModuleLoaded, getEditorClass } from "../lib/editModule";
import { computeEditMarkers, type EditMarker } from "../lib/editMarkers";
import { mergeMarkers } from "../lib/mergeMarkers";
import { subscribeLive } from "../live";
import type { PublishedMarkers } from "../../lib/code-intel.js";
import type { ReviewComment } from "../../lib/types";
import type { PrExistingComment } from "../../lib/pr-session";

export type EditSessionMetadata =
  | ReviewComment
  | { _pending: true }
  | { _existingPr: true; comment: PrExistingComment };

export type EditAnnotation = DiffLineAnnotation<EditSessionMetadata>;

export interface EditSessionView {
  /** Document the editor attached to (the seed; not updated per keystroke). */
  seedContent: string;
  /** Latest live document text. */
  draft: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** Remapped annotation collection, or null while unchanged from the store. */
  annotations: EditAnnotation[] | null;
  /** Bumped when the emitted annotations array changes (render key helper). */
  annotationsVersion: number;
  /** Bumped to force a fresh surface mount (discard / re-seed). */
  sessionKey: number;
  /** sha256 of the on-disk file when the session started. */
  baseHash: string;
}

export interface EditSaveAnchor {
  id: string;
  side: "deletions" | "additions";
  lineNumber: number;
  startLineNumber?: number;
}

const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");

function isDiffAnnotationCollection(
  annotations:
    | LineAnnotation<unknown>[]
    | DiffLineAnnotation<unknown>[]
    | undefined,
): annotations is DiffLineAnnotation<unknown>[] {
  if (!annotations || annotations.length === 0) return true;
  return "side" in annotations[0];
}

export interface UseEditSessionsOptions {
  /** Opt-in diagnostic markers (Settings → Diff → "Edit diagnostics"). */
  diagnosticsEnabled: boolean;
  /**
   * Opt-in language-server diagnostics on top of the built-in checks. Requires
   * `diagnosticsEnabled` too: this only decides whether a server is asked.
   */
  codeIntelEnabled?: boolean;
}

export function useEditSessions({
  diagnosticsEnabled,
  codeIntelEnabled = false,
}: UseEditSessionsOptions) {
  const [sessions, setSessions] = useState<
    ReadonlyMap<string, EditSessionView>
  >(new Map());
  const sessionsRef = useRef<ReadonlyMap<string, EditSessionView>>(new Map());
  const editorsRef = useRef<
    Map<string, Editor<"file-diff", EditSessionMetadata>>
  >(new Map());
  const savingRef = useRef(new Set<string>());
  const markerTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const diagnosticsRef = useRef(diagnosticsEnabled);
  diagnosticsRef.current = diagnosticsEnabled;
  const codeIntelRef = useRef(codeIntelEnabled);
  codeIntelRef.current = codeIntelEnabled;
  /** Markers a language server published, by path, with the version they describe. */
  const serverMarkersRef = useRef<Map<string, PublishedMarkers>>(new Map());
  /** The draft text last pushed to the server, and the version it was sent as. */
  const pushedRef = useRef<Map<string, { text: string; version: number }>>(
    new Map(),
  );
  const versionRef = useRef(0);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const dirtyCount = [...sessions.values()].filter((s) => s.dirty).length;

  /**
   * A batch is kept when it names the version we last sent. Servers are not
   * obliged to report one — typescript-language-server does not — so a
   * version-less batch is accepted only while the draft still matches the text
   * that was pushed, and any batch is discarded outright the moment a new push
   * goes out.
   */
  const currentServerMarkers = useCallback((path: string): EditMarker[] => {
    const published = serverMarkersRef.current.get(path);
    if (!published) return [];
    const pushed = pushedRef.current.get(path);
    if (!pushed) return [];
    const session = sessionsRef.current.get(path);
    if (session && session.draft !== pushed.text) return [];
    if (published.version !== undefined && published.version !== pushed.version)
      return [];
    return published.markers;
  }, []);

  const refreshMarkers = useCallback(
    (path: string) => {
      const editor = editorsRef.current.get(path);
      const session = sessionsRef.current.get(path);
      if (!editor || !session) return;
      if (!diagnosticsRef.current) {
        editor.setMarkers([]);
        return;
      }
      const builtIn = computeEditMarkers(session.draft, path);
      editor.setMarkers(
        codeIntelRef.current
          ? mergeMarkers(builtIn, currentServerMarkers(path))
          : builtIn,
      );
    },
    [currentServerMarkers],
  );

  /**
   * Hand the current draft to the language server, versioned.
   *
   * Markers already held for this file are dropped first. They describe the
   * text as it was before this keystroke, and showing them against the new
   * text is exactly the "squiggles on lines that moved" failure the version
   * carried below exists to prevent — so between a push and its answer the
   * file shows only the built-in checks, which are always true of what is on
   * screen.
   */
  const pushDraft = useCallback((path: string) => {
    // Sync whenever code intel is on so hover, rename and format describe
    // the draft. Markers still require Edit diagnostics as well.
    if (!codeIntelRef.current) return;
    const session = sessionsRef.current.get(path);
    if (!session) return;
    const version = ++versionRef.current;
    serverMarkersRef.current.delete(path);
    pushedRef.current.set(path, { text: session.draft, version });
    void fetch("/api/code-intel/document", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "change",
        path,
        text: session.draft,
        version,
      }),
      // A draft the server never receives just means no server markers.
    }).catch(() => {});
  }, []);

  const dropDraft = useCallback((path: string) => {
    serverMarkersRef.current.delete(path);
    if (!pushedRef.current.delete(path)) return;
    void fetch("/api/code-intel/document", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "close", path }),
    }).catch(() => {});
  }, []);

  useEffect(
    () =>
      subscribeLive("code-intel-diagnostics", (raw) => {
        let published: PublishedMarkers;
        try {
          published = JSON.parse(raw) as PublishedMarkers;
        } catch {
          return;
        }
        if (!published?.path || !Array.isArray(published.markers)) return;
        if (!pushedRef.current.has(published.path)) return;
        serverMarkersRef.current.set(published.path, published);
        refreshMarkers(published.path);
      }),
    [refreshMarkers],
  );

  const scheduleMarkers = useCallback(
    (path: string) => {
      const existing = markerTimersRef.current.get(path);
      if (existing) clearTimeout(existing);
      markerTimersRef.current.set(
        path,
        setTimeout(() => {
          markerTimersRef.current.delete(path);
          pushDraft(path);
          refreshMarkers(path);
        }, 300),
      );
    },
    [refreshMarkers],
  );

  const enterEdit = useCallback(async (path: string) => {
    if (sessionsRef.current.has(path)) return;
    await ensureEditModuleLoaded();
    const res = await fetch(
      `/api/file-text?path=${encodeURIComponent(path)}&version=new`,
    );
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(json?.error ?? `HTTP ${res.status} loading ${path}`);
    }
    const json = (await res.json()) as {
      content?: string;
      missing?: boolean;
      error?: string;
      hash?: string;
    };
    if (json.missing) throw new Error("File not found on disk");
    if (json.error) throw new Error(json.error);
    const seedContent = json.content ?? "";
    const session: EditSessionView = {
      seedContent,
      draft: seedContent,
      dirty: false,
      saving: false,
      error: null,
      annotations: null,
      annotationsVersion: 0,
      sessionKey: 0,
      baseHash: json.hash ?? "",
    };
    setSessions((prev) => new Map(prev).set(path, session));
  }, []);

  const handleEditChange = useCallback(
    (path: string, file: FileContents, lineAnnotations?: EditAnnotation[]) => {
      const current = sessionsRef.current.get(path);
      if (!current) return;
      const draft = file.contents;
      const dirty = normalizeEol(draft) !== normalizeEol(current.seedContent);
      const nextAnnotations = isDiffAnnotationCollection(lineAnnotations)
        ? (lineAnnotations as EditAnnotation[])
        : undefined;

      // Observe the draft for save/diagnostics, but never feed it back into
      // Pierre's active document. The component owns annotation remapping.
      const next = new Map(sessionsRef.current).set(path, {
        ...current,
        draft,
        dirty,
        annotations: nextAnnotations ?? current.annotations,
      });
      sessionsRef.current = next;
      setSessions(next);
      scheduleMarkers(path);
    },
    [scheduleMarkers],
  );

  const handleEditAttach = useCallback(
    (path: string, editor: Editor<"file-diff", EditSessionMetadata>) => {
      editorsRef.current.set(path, editor);
      try {
        editor.focus({ lineNumber: "first-visible", preventScroll: true });
      } catch {
        // Focus is best-effort; the editor remains usable via click.
      }
      // The editor attach fires in the card's layout effect, before this
      // hook's passive sessionsRef sync has run — reading the session now
      // would find the map without this file and skip the markers silently.
      // Defer to the next macrotask so refreshMarkers sees the session (and
      // typing re-triggers markers anyway as a backstop).
      setTimeout(() => {
        // Open the document immediately so diagnostics appear on entering edit
        // mode rather than only after the first keystroke.
        pushDraft(path);
        refreshMarkers(path);
      }, 0);
    },
    [pushDraft, refreshMarkers],
  );

  // The diagnostics toggle must take effect immediately for sessions already
  // open: recompute (or clear) markers on every open editor whenever the
  // setting changes, not just on attach/change.
  useEffect(() => {
    for (const path of editorsRef.current.keys()) {
      refreshMarkers(path);
    }
  }, [diagnosticsEnabled, codeIntelEnabled, refreshMarkers]);

  const saveEdit = useCallback(async (path: string) => {
    const current = sessionsRef.current.get(path);
    if (!current || current.saving || savingRef.current.has(path)) return;
    savingRef.current.add(path);
    setSessions((prev) => {
      const s = prev.get(path);
      if (!s) return prev;
      return new Map(prev).set(path, { ...s, saving: true, error: null });
    });
    try {
      const anchors: EditSaveAnchor[] = (current.annotations ?? [])
        .filter(
          (a) =>
            a.lineNumber > 0 &&
            !("_pending" in a.metadata) &&
            !("_existingPr" in a.metadata),
        )
        .map((a) => ({
          id: (a.metadata as ReviewComment).id,
          side: a.side,
          lineNumber: a.lineNumber,
          startLineNumber: undefined,
        }));
      const res = await fetch("/api/edit-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: path,
          content: current.draft,
          baseHash: current.baseHash,
          anchorUpdates: anchors,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        conflict?: boolean;
        hash?: string;
      };
      if (!res.ok) {
        const error =
          json.conflict === true
            ? "The file changed on disk since this edit session started. Reload or discard."
            : (json.error ?? `HTTP ${res.status}`);
        setSessions((prev) => {
          const s = prev.get(path);
          if (!s) return prev;
          return new Map(prev).set(path, { ...s, saving: false, error });
        });
        return;
      }
      setSessions((prev) => {
        const s = prev.get(path);
        if (!s) return prev;
        // Stay in edit mode with history intact: the editor's document is
        // unchanged, so keep the same surface mounted. The seed becomes the
        // saved text so dirty stays false and discard restores it.
        return new Map(prev).set(path, {
          ...s,
          seedContent: current.draft,
          baseHash: json.hash ?? s.baseHash,
          saving: false,
          dirty: normalizeEol(s.draft) !== normalizeEol(current.draft),
          error: null,
        });
      });
    } catch (err: any) {
      setSessions((prev) => {
        const s = prev.get(path);
        if (!s) return prev;
        return new Map(prev).set(path, {
          ...s,
          saving: false,
          error: err.message,
        });
      });
    } finally {
      savingRef.current.delete(path);
    }
  }, []);

  const saveAllDirty = useCallback(async () => {
    const dirtyPaths = [...sessionsRef.current.entries()]
      .filter(([, s]) => s.dirty)
      .map(([path]) => path);
    await Promise.all(dirtyPaths.map((path) => saveEdit(path)));
  }, [saveEdit]);

  const discardEdit = useCallback((path: string) => {
    if (savingRef.current.has(path)) return;
    setSessions((prev) => {
      const s = prev.get(path);
      if (!s) return prev;
      // Remount the surface from the last saved seed with a fresh editor
      // (fresh history, original-or-saved document restored).
      return new Map(prev).set(path, {
        ...s,
        seedContent: s.seedContent,
        draft: s.seedContent,
        dirty: false,
        saving: false,
        error: null,
        annotations: null,
        annotationsVersion: s.annotationsVersion + 1,
        sessionKey: s.sessionKey + 1,
      });
    });
    editorsRef.current.delete(path);
  }, []);

  const exitEdit = useCallback((path: string) => {
    if (savingRef.current.has(path)) return;
    const s = sessionsRef.current.get(path);
    if (!s) return;
    editorsRef.current.delete(path);
    const timer = markerTimersRef.current.get(path);
    if (timer) clearTimeout(timer);
    markerTimersRef.current.delete(path);
    dropDraft(path);
    setSessions((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, [dropDraft]);

  /**
   * Apply edits a language server produced to the open editor for a file.
   *
   * They go through `Editor.applyEdits`, so a rename or a format is a normal
   * entry on the undo timeline — indistinguishable from having typed it, and
   * undoable the same way. Returns false when the file has no open editor,
   * which is the caller's cue that there was nothing to apply them to.
   */
  const applyServerEdits = useCallback(
    (path: string, edits: TextEdit[]): boolean => {
      const editor = editorsRef.current.get(path);
      if (!editor || edits.length === 0) return false;
      editor.applyEdits(edits);
      return true;
    },
    [],
  );

  const createEditor = useCallback<
    EditorFactory<EditSessionMetadata, undefined>
  >((editorType, options, editStateKey) => {
    const EditorClass = getEditorClass();
    if (!EditorClass) throw new Error("Edit module not loaded yet");
    return new EditorClass(editorType, options, editStateKey);
  }, []);

  useEffect(
    () => () => {
      for (const timer of markerTimersRef.current.values()) clearTimeout(timer);
      markerTimersRef.current.clear();
      editorsRef.current.clear();
    },
    [],
  );

  return {
    sessions,
    dirtyCount,
    enterEdit,
    handleEditChange,
    handleEditAttach,
    saveEdit,
    saveAllDirty,
    discardEdit,
    exitEdit,
    applyServerEdits,
    /** Stable factory for EditProvider; throws only if enterEdit wasn't awaited. */
    createEditor,
  };
}
