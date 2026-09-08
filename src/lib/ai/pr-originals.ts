/**
 * Old and new file contents behind a pull-request diff.
 *
 * A PR capture holds only the unified patch, so evidence built from it cannot
 * cite a real file line. Unlike a local capture, every read here costs a
 * network round trip, so this is deliberately stricter: a low file bound, an
 * explicit omission for anything past it, and a byte-bounded cache keyed by
 * host/owner/repo/revision/path so a repeated capture of the same PR does not
 * re-fetch what it already read.
 *
 * The old side is the merge base when one is known, since that is what the PR
 * is actually diffed against; without it the base commit is used and the
 * capture already records that old-side expansion is unverified.
 */
import { ByteLruCache } from "./cache.js";
import { captureLocalOriginals, type OriginalsResult } from "./local-originals.js";
import { AiSnapshotError } from "./snapshots.js";

export const PR_ORIGINALS_LIMITS = Object.freeze({
	/** Each file costs up to two network reads, so this is far below local. */
	maxFiles: 20,
	cacheBytes: 4 * 1024 * 1024,
});

export interface PrOriginsIdentity {
	host: string;
	owner: string;
	repo: string;
	baseSha: string;
	headSha: string;
	mergeBaseSha: string | null;
}

/** Fetches one path at one commit, or null when it does not exist there. */
export type PrBlobFetcher = (
	target: { host: string; owner: string; repo: string },
	path: string,
	sha: string,
) => Promise<Buffer | null>;

const decoder = new TextDecoder("utf-8", { fatal: true });

export function createPrOriginalsCache(): ByteLruCache<Uint8Array> {
	return new ByteLruCache(PR_ORIGINALS_LIMITS.cacheBytes);
}

export async function capturePrOriginals(
	identity: PrOriginsIdentity,
	patch: string,
	fetchBlob: PrBlobFetcher,
	cache: ByteLruCache<Uint8Array> = createPrOriginalsCache(),
): Promise<OriginalsResult> {
	const target = {
		host: identity.host,
		owner: identity.owner,
		repo: identity.repo,
	};
	const readBlob = async (revision: string, path: string) => {
		if (!revision) throw new AiSnapshotError("invalid");
		const key = JSON.stringify([
			identity.host,
			identity.owner,
			identity.repo,
			revision,
			path,
		]);
		const cached = cache.get(key);
		if (cached) return decoder.decode(cached);
		let buffer: Buffer | null;
		try {
			buffer = await fetchBlob(target, path, revision);
		} catch {
			// A fetch failure is an absent original, not a capture failure; the
			// caller records it as an explicit omission.
			return null;
		}
		if (!buffer) return null;
		let text: string;
		try {
			text = decoder.decode(buffer);
		} catch {
			// Binary content is not original-file evidence.
			return null;
		}
		cache.set(key, new Uint8Array(buffer));
		return text;
	};

	return captureLocalOriginals(
		{
			patch,
			mode: "revision",
			baseSha: identity.mergeBaseSha ?? identity.baseSha,
			headSha: identity.headSha,
			maxFiles: PR_ORIGINALS_LIMITS.maxFiles,
			onExcess: "omit",
		},
		readBlob,
		async () => null,
	);
}
