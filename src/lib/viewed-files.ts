/**
 * Durable viewed-file progress. Local reviews use a `local` bucket; PR
 * sessions key by canonical identity and remember the fingerprint of each
 * file at the moment it was marked viewed so a new head unviews only files
 * whose patch actually changed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectStorageDir } from "./git.js";
import { writeJsonAtomically } from "./json-atomic.js";
import {
  diffSinceLast,
  filesToReviewSinceLast,
  fingerprintDiffFiles,
} from "./diff-fingerprint.js";
import { prSessionIdentity, type PrSession } from "./pr-session.js";

export interface ViewedBucket {
  headSha?: string;
  fingerprints?: Record<string, string>;
  /** path → fingerprint at the time the file was marked viewed */
  files: Record<string, string>;
}

export interface ViewedFileStore {
  list(
    key: string,
    fingerprints?: Record<string, string> | null,
  ): Promise<string[]>;
  toggle(
    key: string,
    filePath: string,
    viewed: boolean,
    fingerprint?: string,
    headSha?: string,
    fingerprints?: Record<string, string> | null,
  ): Promise<string[]>;
  reconcile(
    key: string,
    headSha: string,
    fingerprints: Record<string, string>,
  ): Promise<string[]>;
}

const EMPTY: ViewedBucket = { files: {} };

export function viewedScopeKey(
  session: Pick<PrSession, "owner" | "repo" | "pullNumber" | "host"> | null,
  prMode: boolean,
): string {
  if (prMode && session) return `pr:${prSessionIdentity(session)}`;
  return "local";
}

export function visibleViewedPaths(
  files: Record<string, string>,
  fingerprints?: Record<string, string> | null,
): string[] {
  const paths = Object.keys(files);
  if (!fingerprints) return paths.sort((a, b) => a.localeCompare(b));
  return paths
    .filter((path) => files[path] === fingerprints[path])
    .sort((a, b) => a.localeCompare(b));
}

export function unviewChangedFiles(
  files: Record<string, string>,
  previousFingerprints: Record<string, string> | undefined,
  currentFingerprints: Record<string, string>,
): Record<string, string> {
  const delta = diffSinceLast(previousFingerprints, currentFingerprints);
  const unview = new Set(filesToReviewSinceLast(delta));
  const next: Record<string, string> = {};
  for (const [path, fp] of Object.entries(files)) {
    if (unview.has(path)) continue;
    const current = currentFingerprints[path];
    if (current == null) continue;
    if (fp !== current) continue;
    next[path] = current;
  }
  return next;
}

export function fingerprintsForPatch(patch: string): Record<string, string> {
  return fingerprintDiffFiles(patch);
}

export class FileViewedStore implements ViewedFileStore {
  private filePath: string;
  private cache: Record<string, ViewedBucket> | null = null;

  constructor(storageDir?: string) {
    this.filePath = join(storageDir ?? getProjectStorageDir(), "viewed.json");
  }

  private load(): Record<string, ViewedBucket> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.cache = parsed as Record<string, ViewedBucket>;
        return this.cache;
      }
    } catch {
      // missing or unreadable — start empty
    }
    this.cache = {};
    return this.cache;
  }

  private save(data: Record<string, ViewedBucket>): void {
    this.cache = data;
    writeJsonAtomically(this.filePath, data);
  }

  private bucket(key: string): ViewedBucket {
    const data = this.load();
    const current = data[key];
    if (current && current.files && typeof current.files === "object") {
      return current;
    }
    return { ...EMPTY, files: {} };
  }

  async list(
    key: string,
    fingerprints?: Record<string, string> | null,
  ): Promise<string[]> {
    return visibleViewedPaths(this.bucket(key).files, fingerprints);
  }

  async toggle(
    key: string,
    filePath: string,
    viewed: boolean,
    fingerprint?: string,
    headSha?: string,
    fingerprints?: Record<string, string> | null,
  ): Promise<string[]> {
    const data = this.load();
    const bucket = this.bucket(key);
    const files = { ...bucket.files };
    if (viewed) {
      files[filePath] = fingerprint ?? files[filePath] ?? "*";
    } else {
      delete files[filePath];
    }
    const next: ViewedBucket = {
      ...bucket,
      files,
      ...(headSha ? { headSha } : {}),
    };
    this.save({ ...data, [key]: next });
    return visibleViewedPaths(files, fingerprints ?? bucket.fingerprints);
  }

  async reconcile(
    key: string,
    headSha: string,
    fingerprints: Record<string, string>,
  ): Promise<string[]> {
    const data = this.load();
    const bucket = this.bucket(key);
    const files =
      bucket.headSha && bucket.headSha !== headSha
        ? unviewChangedFiles(bucket.files, bucket.fingerprints, fingerprints)
        : Object.fromEntries(
            Object.entries(bucket.files).filter(([path, fp]) => {
              const current = fingerprints[path];
              return current != null && (fp === "*" || fp === current);
            }),
          );
    const next: ViewedBucket = { headSha, fingerprints, files };
    this.save({ ...data, [key]: next });
    return visibleViewedPaths(files, fingerprints);
  }
}
