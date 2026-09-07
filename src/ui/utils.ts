import { navigateToDiffLine } from "./lib/diffNavigation";

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncate(text: string, maxLen: number): string {
  const firstLine = text.split("\n")[0];
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen) + "…";
}

export function fileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

export const SHIKI_THEME_MAP: Record<
  string,
  { themeName: string; type: "dark" | "light" }
> = {
  nord: { themeName: "nord", type: "dark" },
  "github-dark": { themeName: "github-dark", type: "dark" },
  "github-dark-dimmed": { themeName: "github-dark-dimmed", type: "dark" },
  "github-dark-high-contrast": {
    themeName: "github-dark-high-contrast",
    type: "dark",
  },
  "github-light": { themeName: "github-light", type: "light" },
  "github-light-high-contrast": {
    themeName: "github-light-high-contrast",
    type: "light",
  },
  dracula: { themeName: "dracula", type: "dark" },
  "one-dark": { themeName: "one-dark-pro", type: "dark" },
  "synthwave-84": { themeName: "synthwave-84", type: "dark" },
  "tokyo-night": { themeName: "tokyo-night", type: "dark" },
  "catppuccin-mocha": { themeName: "catppuccin-mocha", type: "dark" },
  "catppuccin-frappe": { themeName: "catppuccin-frappe", type: "dark" },
  "catppuccin-macchiato": { themeName: "catppuccin-macchiato", type: "dark" },
  "catppuccin-latte": { themeName: "catppuccin-latte", type: "light" },
  "solarized-dark": { themeName: "solarized-dark", type: "dark" },
  "solarized-light": { themeName: "solarized-light", type: "light" },
  monokai: { themeName: "monokai", type: "dark" },
  "ayu-dark": { themeName: "ayu-dark", type: "dark" },
  "ayu-light": { themeName: "ayu-light", type: "light" },
  andromeeda: { themeName: "andromeeda", type: "dark" },
  "aurora-x": { themeName: "aurora-x", type: "dark" },
  "dark-plus": { themeName: "dark-plus", type: "dark" },
  "light-plus": { themeName: "light-plus", type: "light" },
  houston: { themeName: "houston", type: "dark" },
  laserwave: { themeName: "laserwave", type: "dark" },
  "material-theme": { themeName: "material-theme", type: "dark" },
  "material-theme-darker": { themeName: "material-theme-darker", type: "dark" },
  "material-theme-lighter": {
    themeName: "material-theme-lighter",
    type: "light",
  },
  "material-theme-ocean": { themeName: "material-theme-ocean", type: "dark" },
  "material-theme-palenight": {
    themeName: "material-theme-palenight",
    type: "dark",
  },
  "min-dark": { themeName: "min-dark", type: "dark" },
  "min-light": { themeName: "min-light", type: "light" },
  "night-owl": { themeName: "night-owl", type: "dark" },
  "one-light": { themeName: "one-light", type: "light" },
  plastic: { themeName: "plastic", type: "dark" },
  poimandres: { themeName: "poimandres", type: "dark" },
  "rose-pine": { themeName: "rose-pine", type: "dark" },
  "rose-pine-moon": { themeName: "rose-pine-moon", type: "dark" },
  "rose-pine-dawn": { themeName: "rose-pine-dawn", type: "light" },
  "slack-dark": { themeName: "slack-dark", type: "dark" },
  "slack-ochre": { themeName: "slack-ochre", type: "dark" },
  vesper: { themeName: "vesper", type: "dark" },
  "vitesse-black": { themeName: "vitesse-black", type: "dark" },
  "vitesse-dark": { themeName: "vitesse-dark", type: "dark" },
  "vitesse-light": { themeName: "vitesse-light", type: "light" },
  nightfox: { themeName: "nightfox", type: "dark" },
  nordfox: { themeName: "nordfox", type: "dark" },
  duskfox: { themeName: "duskfox", type: "dark" },
  terafox: { themeName: "terafox", type: "dark" },
  carbonfox: { themeName: "carbonfox", type: "dark" },
  dayfox: { themeName: "dayfox", type: "light" },
  dawnfox: { themeName: "dawnfox", type: "light" },
};

export function findElementInElOrShadow(
  root: Element | ShadowRoot,
  selector: string,
): HTMLElement[] {
  const elements: HTMLElement[] = [];

  // Query all in the current root
  const found = root.querySelectorAll(selector);
  found.forEach((el) => elements.push(el as HTMLElement));

  // Search recursively in shadow roots of all descendants
  const allDescendants = root.querySelectorAll("*");
  allDescendants.forEach((desc) => {
    if (desc.shadowRoot) {
      elements.push(...findElementInElOrShadow(desc.shadowRoot, selector));
    }
  });

  return elements;
}

/**
 * True when the currently focused element is a text-entry target: an
 * <input>, <textarea>, or contenteditable region — including when focus
 * lives inside a shadow root (e.g. the @pierre/diffs in-place edit surface).
 * `document.activeElement` retargets such focus to the shadow host, so a
 * naive tagName/contenteditable check on it misses the real editable node;
 * this descends into `shadowRoot.activeElement` at each level of the chain.
 */
function isEditableElement(element: Element): boolean {
  return (
    element.matches('input, textarea, select, [role="textbox"]') ||
    (element instanceof HTMLElement && element.isContentEditable) ||
    (element.hasAttribute("contenteditable") &&
      element.getAttribute("contenteditable") !== "false")
  );
}

/** Event origins survive focus changes and synchronous composer removal. */
export function isEditableKeyEvent(event: KeyboardEvent): boolean {
  return event
    .composedPath()
    .some((node) => node instanceof Element && isEditableElement(node));
}

export function isTypingInFocus(): boolean {
  let active: Element | null = document.activeElement;
  while (active) {
    if (isEditableElement(active)) {
      return true;
    }
    const inner = active.shadowRoot?.activeElement ?? null;
    if (inner && inner !== active) {
      active = inner;
      continue;
    }
    active = active.parentElement;
  }
  return false;
}

/**
 * Apply a temporary gold flash to a mounted line element (or, when
 * `highlightText` matches, to the specific child span). Inline styles bypass
 * shadow-DOM encapsulation. Shared by the diff-view jump and the preview pane.
 */
function flashHighlight(found: HTMLElement, highlightText?: string) {
  // Determine what specific element to highlight (symbol span vs whole line)
  let highlightTarget: HTMLElement = found;
  if (highlightText && highlightText.trim()) {
    const textToFind = highlightText.trim();
    const children = found.querySelectorAll("span, code, pre");

    // Try exact match first
    for (const child of children) {
      if (child.textContent?.trim() === textToFind) {
        highlightTarget = child as HTMLElement;
        break;
      }
    }

    // Try substring match as fallback
    if (highlightTarget === found) {
      for (const child of children) {
        if (child.textContent?.trim().includes(textToFind)) {
          highlightTarget = child as HTMLElement;
          break;
        }
      }
    }
  }

  const originalBorderRadius = highlightTarget.style.borderRadius;
  const originalPadding = highlightTarget.style.padding;

  highlightTarget.style.setProperty("transition", "none", "important");
  highlightTarget.style.setProperty(
    "background-color",
    "rgba(235, 186, 0, 0.55)",
    "important",
  );
  highlightTarget.style.setProperty(
    "box-shadow",
    "0 0 0 2.5px rgba(235, 186, 0, 0.85)",
    "important",
  );
  highlightTarget.style.setProperty("border-radius", "4px", "important");
  if (highlightTarget !== found) {
    highlightTarget.style.setProperty("padding", "1px 5px", "important");
  }

  // Force DOM reflow to trigger transition
  void highlightTarget.offsetHeight;

  setTimeout(() => {
    highlightTarget.style.setProperty(
      "transition",
      "background-color 2.5s ease-out, box-shadow 2.5s ease-out",
      "important",
    );
    highlightTarget.style.removeProperty("background-color");
    highlightTarget.style.removeProperty("box-shadow");

    setTimeout(() => {
      highlightTarget.style.removeProperty("transition");
      if (!originalBorderRadius)
        highlightTarget.style.removeProperty("border-radius");
      if (!originalPadding) highlightTarget.style.removeProperty("padding");
    }, 2500);
  }, 2000);
}

/**
 * Scroll to and flash a line *within a specific container* (e.g. the search
 * palette's file-preview pane), polling until the line mounts in the DOM /
 * shadow DOM. Unlike {@link scrollToLine} this doesn't touch file-card "viewed"
 * state — the preview always renders the whole file.
 */
export function highlightLineInElement(
  container: HTMLElement,
  lineNumber: number,
  highlightText?: string,
) {
  const tryScroll = (attemptsRemaining: number) => {
    const allLineEls = findElementInElOrShadow(container, "[data-line]");
    let found: HTMLElement | null = null;
    for (const el of allLineEls) {
      const elLine = el.getAttribute("data-line");
      if (elLine && parseInt(elLine, 10) === lineNumber) {
        found = el;
        break;
      }
    }
    if (found) {
      found.scrollIntoView({ block: "center", behavior: "auto" });
      flashHighlight(found, highlightText);
    } else if (attemptsRemaining > 0) {
      setTimeout(() => tryScroll(attemptsRemaining - 1), 50);
    }
  };
  tryScroll(20);
}

export function scrollToLine(
  filePath: string,
  lineNumber: number,
  side: "additions" | "deletions" | "addition" | "deletion",
  highlightText?: string,
) {
  const normalized =
    side === "addition" || side === "additions" ? "additions" : "deletions";
  return navigateToDiffLine(filePath, lineNumber, normalized, () => {
    const card = document.getElementById(`file-${filePath}`);
    if (!card) return true;
    const expectedType = normalized === "additions" ? "addition" : "deletion";
    const found = findElementInElOrShadow(
      card,
      `[data-line="${lineNumber}"]`,
    ).find((element) => {
      const type = element.getAttribute("data-line-type");
      return type === expectedType || type === "context";
    });
    if (!found) return false;
    flashHighlight(found, highlightText);
    return true;
  });
}
