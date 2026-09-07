import type { PrExistingComment } from "./pr-session.js";

/**
 * GitHub threads whose file is no longer in the current patch.
 * These cannot render on a FileDiffCard, so they belong in the conversation inbox.
 */
export function commentsMissingFromPatch(
 comments: PrExistingComment[],
 patchFileNames: Iterable<string>,
): PrExistingComment[] {
 const files = new Set(patchFileNames);
 return comments.filter((comment) => !files.has(comment.path));
}
