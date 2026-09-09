import type { CodeIntelEdit, CodeIntelEdits } from "../hooks/useCodeIntel";

export type CodeIntelApplyDecision =
  | { apply: true; edits: CodeIntelEdit[]; notice: string }
  | { apply: false; notice: string };

/**
 * Decide whether a language-server edit list may be handed to the open editor.
 *
 * Edits that spill into other files are reported and not applied — including
 * the ones that would have landed here. A review tool writing anywhere the
 * reviewer is not looking is the wrong default.
 */
export function decideCodeIntelApply(
  result: CodeIntelEdits | { reason: string },
  verb: string,
): CodeIntelApplyDecision {
  if ("reason" in result)
    return { apply: false, notice: `${verb} unavailable: ${result.reason}` };

  if (result.otherFiles > 0) {
    const files = result.otherFiles + (result.edits.length > 0 ? 1 : 0);
    const edits = result.otherEdits + result.edits.length;
    return {
      apply: false,
      notice: `${edits} edit${edits === 1 ? "" : "s"} across ${files} file${
        files === 1 ? "" : "s"
      } — not applied, this file only`,
    };
  }

  if (result.edits.length === 0)
    return { apply: false, notice: `${verb} produced no changes to this file.` };

  return {
    apply: true,
    edits: result.edits,
    notice: `${verb}: applied ${result.edits.length} edit${
      result.edits.length === 1 ? "" : "s"
    } in this file.`,
  };
}
