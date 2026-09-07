import type { ReviewComment } from "./types.js";

/** Classify review drafts for both the browser preview and server submission. */
export function classifyPrComments(comments: ReviewComment[]): {
  inline: ReviewComment[];
  fileLevel: ReviewComment[];
  excluded: ReviewComment[];
} {
  const inline: ReviewComment[] = [];
  const fileLevel: ReviewComment[] = [];
  const excluded: ReviewComment[] = [];
  for (const comment of comments) {
    if (comment.status !== "open") {
      excluded.push(comment);
      continue;
    }
    if (comment.lineNumber === 0) fileLevel.push(comment);
    else inline.push(comment);
  }
  return { inline, fileLevel, excluded };
}
