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

export const editSaveSchema = z.object({
  filePath,
  content: z.string(),
  baseHash: sha256.optional(),
  anchorUpdates: z.array(anchorUpdate).max(1024).optional(),
});
