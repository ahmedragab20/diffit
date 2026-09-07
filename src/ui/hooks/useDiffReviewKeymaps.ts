import { useEffect } from "react";
import type { Scope } from "../lib/searchTypes";
import { fireFeedback, playSound } from "./useHaptics";
import { isTypingInFocus, isEditableKeyEvent } from "../utils";

interface DiffReviewKeymapActions {
  onNavigateFile: (direction: "next" | "prev") => void;
  onNavigateCommit?: (direction: "next" | "prev") => void;
  onToggleViewed: () => void;
  onToggleDiffStyle: () => void;
  onCycleTabSize: () => void;
  onToggleSidebar: () => void;
  onToggleLineWrap: () => void;
  onToggleLineNumbers?: () => void;
  onCycleDiffIndicators: () => void;
  onCycleLineDiffType: () => void;
  onOpenPalette: (scope: Scope) => void;
  onTogglePalette?: () => void;
  /** Open the file-scoped find-in-file bar on the active file (⌘F / F). */
  onOpenFileSearch?: () => void;
  /**
   * Close the file-scoped find-in-file bar. Wired while a search is open so
   * Escape closes ONLY the search (never also exits zen) even when the bar's
   * input is not the focus target (the user clicked the diff and then pressed
   * Esc — the bar's own handler cannot see that stroke).
   */
  onCloseFileSearch?: () => void;
  onNextSearchHit?: () => void;
  onPrevSearchHit?: () => void;
  onOpenTheme: () => void;
  onOpenShortcuts: () => void;
  /** Toggle in-place edit mode on the active file (working-tree reviews only). */
  onToggleEdit?: () => void;
  /** Save all dirty edit sessions (Cmd/Ctrl+S). */
  onSaveAll?: () => void;
  /** Toggle immersive diffs-only zen mode (z). */
  onToggleZen?: () => void;
  /** Exit zen mode (Escape). Present only while zen is active and no overlay is open. */
  onExitZen?: () => void;
  /** Open the centered Submit-review dialog (Cmd/Ctrl+Enter). */
  onOpenSendReview?: () => void;
}

/** Shared keyboard model for local and GitHub diff review surfaces. */
export function useDiffReviewKeymaps(actions: DiffReviewKeymapActions) {
  useEffect(() => {
    let keyBuffer = "";
    let bufferTimeout: ReturnType<typeof setTimeout>;
    let lastNavSound = 0;

    const resetBuffer = () => {
      keyBuffer = "";
      clearTimeout(bufferTimeout);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        document.querySelector('[role="dialog"], [role="alertdialog"]')
      ) {
        resetBuffer();
        return;
      }
      // The command palette remains global, including while an editor is focused.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (actions.onTogglePalette) actions.onTogglePalette();
        else actions.onOpenPalette("all");
        resetBuffer();
        return;
      }

      // Find-in-file stays global too: the user expects ⌘F to work everywhere,
      // including while an edit session has focus (diff content is shadow-DOM,
      // so the browser's native find cannot reach it).
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f" &&
        actions.onOpenFileSearch
      ) {
        event.preventDefault();
        actions.onOpenFileSearch();
        resetBuffer();
        return;
      }

      // Save-all stays global too: the edit surface is contenteditable, and we
      // must swallow the browser's default "save page" for Cmd/Ctrl+S.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "s" &&
        actions.onSaveAll
      ) {
        event.preventDefault();
        actions.onSaveAll();
        resetBuffer();
        return;
      }

      // The focus guard must also see contenteditable surfaces inside shadow
      // roots (the @pierre/diffs edit surface), where document.activeElement
      // retargets to the shadow host.
      if (isEditableKeyEvent(event) || isTypingInFocus()) {
        resetBuffer();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        (event.key === "?" ||
          (event.key === "/" && event.shiftKey) ||
          (event.code === "Slash" && event.shiftKey))
      ) {
        event.preventDefault();
        actions.onOpenShortcuts();
        fireFeedback("medium", "open");
        resetBuffer();
        return;
      }

      // Submit-review dialog: Cmd/Ctrl+Enter. Lives after the input-focus guard
      // so the overall-comment field keeps its local ⌘Enter-to-send binding.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter" &&
        actions.onOpenSendReview
      ) {
        event.preventDefault();
        actions.onOpenSendReview();
        fireFeedback("medium", "open");
        resetBuffer();
        return;
      }

      // Escape closes the file-scoped find bar first — also when its input is
      // not the focus target — then exits zen when active (and no overlay is
      // open — the App only wires onExitZen in that state). Overlays like the
      // palette and dialogs handle their own Escape first.
      if (event.key === "Escape") {
        if (actions.onCloseFileSearch) {
          event.preventDefault();
          actions.onCloseFileSearch();
          resetBuffer();
          return;
        }
        if (actions.onExitZen) {
          event.preventDefault();
          actions.onExitZen();
          resetBuffer();
          return;
        }
      }

      if (event.ctrlKey) {
        if (event.key === "d" || event.key === "u") {
          event.preventDefault();
          window.scrollBy({
            top:
              event.key === "d"
                ? window.innerHeight / 2
                : -window.innerHeight / 2,
            behavior: "auto",
          });
          fireFeedback("selection", "navigate");
          resetBuffer();
        }
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        resetBuffer();
        return;
      }

      const key = event.key;
      if (key.length > 1 && key !== "Escape" && key !== "Enter") return;
      clearTimeout(bufferTimeout);
      keyBuffer += key;
      bufferTimeout = setTimeout(() => {
        keyBuffer = "";
      }, 800);

      const handled = (
        callback: () => void,
        feedback: "navigate" | "toggle" | "open" = "toggle",
      ) => {
        event.preventDefault();
        callback();
        fireFeedback(feedback === "open" ? "medium" : "selection", feedback);
        resetBuffer();
      };

      if (keyBuffer === "j" || keyBuffer === "k") {
        event.preventDefault();
        window.scrollBy({
          top: keyBuffer === "j" ? 100 : -100,
          behavior: "auto",
        });
        const now = Date.now();
        if (now - lastNavSound > 80) {
          playSound("navigate");
          lastNavSound = now;
        }
        resetBuffer();
      } else if (keyBuffer === "gg") {
        handled(
          () => window.scrollTo({ top: 0, behavior: "auto" }),
          "navigate",
        );
      } else if (keyBuffer === "G") {
        handled(
          () =>
            window.scrollTo({
              top: document.documentElement.scrollHeight,
              behavior: "auto",
            }),
          "navigate",
        );
      } else if (keyBuffer === "J") {
        handled(() => actions.onNavigateFile("next"), "navigate");
      } else if (keyBuffer === "K") {
        handled(() => actions.onNavigateFile("prev"), "navigate");
      } else if (keyBuffer === "]" && actions.onNavigateCommit) {
        handled(() => actions.onNavigateCommit?.("next"), "navigate");
      } else if (keyBuffer === "[" && actions.onNavigateCommit) {
        handled(() => actions.onNavigateCommit?.("prev"), "navigate");
      } else if (keyBuffer === "v") {
        handled(actions.onToggleViewed);
      } else if (keyBuffer === "e" && actions.onToggleEdit) {
        handled(actions.onToggleEdit);
      } else if (keyBuffer === "m") {
        handled(actions.onToggleDiffStyle);
      } else if (keyBuffer === "t") {
        handled(actions.onCycleTabSize);
      } else if (keyBuffer === "b") {
        handled(actions.onToggleSidebar);
      } else if (keyBuffer === "w") {
        handled(actions.onToggleLineWrap);
      } else if (keyBuffer === "gn" || keyBuffer === "#") {
        handled(() => actions.onToggleLineNumbers?.());
      } else if (keyBuffer === "n") {
        handled(() => actions.onNextSearchHit?.(), "navigate");
      } else if (keyBuffer === "N") {
        handled(() => actions.onPrevSearchHit?.(), "navigate");
      } else if (keyBuffer === "F") {
        handled(() => actions.onOpenFileSearch?.(), "open");
      } else if (keyBuffer === "i") {
        handled(actions.onCycleDiffIndicators);
      } else if (keyBuffer === "I") {
        handled(actions.onCycleLineDiffType);
      } else if (keyBuffer === "/") {
        handled(() => actions.onOpenPalette("all"), "open");
      } else if (keyBuffer === "f") {
        handled(() => actions.onOpenPalette("files"), "open");
      } else if (keyBuffer === "s" || keyBuffer === "gs") {
        handled(() => actions.onOpenPalette("symbols"), "open");
      } else if (keyBuffer === "gf") {
        handled(() => actions.onOpenPalette("all"), "open");
      } else if (keyBuffer === "gv") {
        handled(() => actions.onOpenPalette("files"), "open");
      } else if (keyBuffer === "gt") {
        handled(actions.onOpenTheme, "open");
      } else if (keyBuffer === "z" && actions.onToggleZen) {
        handled(actions.onToggleZen);
      } else if (keyBuffer === "?") {
        handled(actions.onOpenShortcuts, "open");
      } else if (keyBuffer.length >= 2) {
        resetBuffer();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearTimeout(bufferTimeout);
    };
  }, [actions]);
}
