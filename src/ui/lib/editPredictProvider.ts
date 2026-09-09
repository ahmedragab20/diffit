import type {
  EditPredictProvider,
  EditPredictResponse,
  TextEdit,
} from "@pierre/diffs/edit";

/**
 * Subtle edit prediction: Alt reveals a ghost edit from the configured AI
 * model. Restricted to the file this card is already showing.
 */
export function createEditPredictProvider(): EditPredictProvider {
  return {
    async predict(request, { signal }): Promise<EditPredictResponse> {
      const empty = { edits: [] as TextEdit[], newCursor: { line: 0, character: 0 } };
      const res = await fetch("/api/edit-predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: request.path,
          excerptText: request.excerptText,
          cursorOffsetInExcerpt: request.cursorOffsetInExcerpt,
          excerptStartLine: request.excerptStartLine,
        }),
        signal,
      });
      if (!res.ok) return empty;
      const value = (await res.json()) as {
        available?: boolean;
        edits?: TextEdit[];
        newCursor?: { line: number; character: number };
      };
      if (!value.available || !value.edits?.length || !value.newCursor)
        return empty;
      return { edits: value.edits, newCursor: value.newCursor };
    },
  };
}