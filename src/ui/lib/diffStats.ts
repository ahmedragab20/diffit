import type { FileDiffMetadata } from "@pierre/diffs";

/** File-side arrays include context; hunk change counts include only +/- lines. */
export function countDiffChanges(
  files: readonly Pick<FileDiffMetadata, "hunks">[],
): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
  }
  return { additions, deletions };
}
