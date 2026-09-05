import { resolve, relative, sep } from "node:path";

function decodeAndNormalize(p: string): string {
  // Decode URL-encoded characters (e.g. %2e -> ., %2f -> /, %5c -> \)
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    // invalid encoding, use as-is
  }
  // Normalize backslashes to forward slashes
  return decoded.replace(/\\/g, "/");
}

export function toSafeRelativePath(
  filePath: string,
  baseDir: string,
): string | null {
  return toSafeLiteralRelativePath(decodeAndNormalize(filePath), baseDir);
}

/** Lexical normalization only. Decoded API/Git paths must not be URL-decoded again.
 * Filesystem containment still requires the native directory capability. */
export function toSafeLiteralRelativePath(
  filePath: string,
  baseDir: string,
): string | null {
  if (filePath.includes("\0")) {
    return null;
  }
  const resolved = resolve(baseDir, filePath);
  const resolvedBase = resolve(baseDir);
  // Use the platform-specific separator: `resolve()` returns backslashes on
  // Windows, so a hard-coded '/' here would reject every safe path and make
  // the static file server (and every git endpoint) return 403 on Windows.
  const isSafe =
    resolved === resolvedBase || resolved.startsWith(resolvedBase + sep);
  if (!isSafe) {
    return null;
  }
  return relative(resolvedBase, resolved);
}

export function isSafePath(relativePath: string, baseDir: string): boolean {
  return toSafeRelativePath(relativePath, baseDir) !== null;
}
