import { z } from "zod";

// JSON escaping has its own transport bound; native writes also enforce a
// 50 MiB decoded-byte limit before starting the helper.
export const MAX_FILE_REQUEST_BYTES = 70 * 1024 * 1024;

const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const anchorUpdate = z
  .object({
    id: z.string().min(1).max(200),
    side: z.enum(["deletions", "additions"]).optional(),
    lineNumber: z.number().int().nonnegative(),
    startLineNumber: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      value.startLineNumber === undefined ||
      (value.lineNumber > 0 && value.startLineNumber <= value.lineNumber),
  );

export const saveFileSchema = z.object({
  filePath,
  content: z.string(),
  gitAdd: z.boolean().optional(),
});

// Positions come from the diff gutter: one-based lines, zero-based characters,
// matching LspSession and the editor's own TextDocument.
export const codeIntelSchema = z.object({
  op: z.enum([
    "hover",
    "definition",
    "references",
    "rename",
    "format",
    "code-actions",
    "signature",
    "highlights",
  ]),
  path: filePath,
  side: z.enum(["deletions", "additions"]),
  line: z.number().int().positive(),
  character: z.number().int().nonnegative(),
  includeDeclaration: z.boolean().optional(),
  /** An identifier, for `rename`. Bounded so a stray paste cannot be one. */
  newName: z.string().min(1).max(200).optional(),
  /** The end of the selection, for `code-actions`. */
  endLine: z.number().int().positive().optional(),
  endCharacter: z.number().int().nonnegative().optional(),
  /** Formatting preferences, for `format`. */
  tabSize: z.number().int().min(1).max(16).optional(),
  insertSpaces: z.boolean().optional(),
  /** The scope the client is displaying; defaults to the server's own. */
  staged: z.boolean().optional(),
});

// A draft the reviewer is editing, pushed so diagnostics describe what they
// are actually looking at rather than what is still on disk.
export const codeIntelDocumentSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.enum(["open", "change"]),
    path: filePath,
    text: z.string(),
    version: z.number().int().positive(),
  }),
  z.object({ op: z.literal("close"), path: filePath }),
]);

export const editPredictSchema = z.object({
  path: filePath,
  excerptText: z.string().max(32 * 1024),
  cursorOffsetInExcerpt: z.number().int().nonnegative(),
  excerptStartLine: z.number().int().nonnegative(),
});

export const editSaveSchema = z.object({
  filePath,
  content: z.string(),
  baseHash: sha256.optional(),
  anchorUpdates: z.array(anchorUpdate).max(1024).optional(),
});
