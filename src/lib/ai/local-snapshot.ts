import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffOptions } from "../diff-options.js";
import {
	AiSnapshotError,
	sourceHash,
	type SnapshotIdentity,
} from "./snapshots.js";

const exec = promisify(execFile);
export interface LocalPatchResult {
	patch: string;
	complete: boolean;
	omittedPaths?: string[];
}

/** Read-only probes; no shell, lazy fetch, filters or optional index writes. */
async function git(root: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await exec(
			"git",
			["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args],
			{
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				timeout: 10_000,
				env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
			},
		);
		return stdout;
	} catch {
		throw new AiSnapshotError("missing");
	}
}
async function commit(root: string, ref: string): Promise<string> {
	const sha = (
		await git(root, [
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${ref}^{commit}`,
		])
	).trim();
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
		throw new AiSnapshotError("missing");
	return sha;
}
function admit(opts: DiffOptions) {
	if (
		opts.showMode ||
		opts.merge ||
		opts.base ||
		opts.ours ||
		opts.theirs ||
		opts.revisions.length > 2 ||
		opts.extDiff ||
		opts.textconv ||
		opts.outputFile ||
		opts.wordDiff ||
		opts.suppressPatch ||
		opts.outputFormat ||
		opts.srcPrefix ||
		opts.dstPrefix ||
		opts.noPrefix ||
		opts.linePrefix ||
		opts.relative !== undefined ||
		(opts.staged && opts.revisions.length > 1)
	)
		throw new AiSnapshotError("unsupported");
}
async function state(root: string, opts: DiffOptions) {
	const repository = (await git(root, ["rev-parse", "--show-toplevel"])).replace(
		/\r?\n$/,
		"",
	);
	let repositoryHeadSha: string | null = null;
	try {
		repositoryHeadSha = await commit(root, "HEAD");
	} catch {
		/* Unavailable HEAD is not treated as verified or necessarily unborn. */
	}
	const indexHash = sourceHash(await git(root, ["ls-files", "--stage", "-z"]));
	let baseSha: string | null = null;
	let headSha: string | null = null;
	let mode: "working" | "staged" | "revision" | "mixed" = opts.staged
		? opts.pathspecs.length
			? "staged"
			: "mixed"
		: "working";
	if (opts.revisions.length === 2) {
		if (opts.revisions.some((ref) => ref.includes("..")))
			throw new AiSnapshotError("unsupported");
		baseSha = await commit(root, opts.revisions[0]);
		headSha = await commit(root, opts.revisions[1]);
		mode = "revision";
	} else if (opts.revisions.length === 1) {
		const range = /^(.*?)\.{2,3}(.*?)$/.exec(opts.revisions[0]);
		if (range) {
			if (opts.staged) throw new AiSnapshotError("unsupported");
			baseSha = await commit(root, range[1] || "HEAD");
			headSha = await commit(root, range[2] || "HEAD");
			if (opts.revisions[0].includes("...")) {
				const bases = (await git(root, ["merge-base", "--all", baseSha, headSha]))
					.trim()
					.split("\n");
				if (bases.length !== 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(bases[0]))
					throw new AiSnapshotError("unsupported");
				baseSha = bases[0];
			}
			mode = "revision";
		} else {
			baseSha = await commit(root, opts.revisions[0]);
			mode = opts.staged ? "staged" : "working";
		}
	} else if (opts.staged) baseSha = repositoryHeadSha;
	return {
		repositoryId: sourceHash(repository),
		repositoryHeadSha,
		mode,
		baseSha,
		headSha,
		indexHash,
		scopeHash: sourceHash(JSON.stringify(opts)),
	};
}
function checkedPatch(result: LocalPatchResult) {
	if (
		Buffer.byteLength(result.patch, "utf8") > 4 * 1024 * 1024 ||
		(result.omittedPaths?.length ?? 0) > 200
	)
		throw new AiSnapshotError("limit");
	return {
		patchHash: sourceHash(result.patch),
		completenessHash: sourceHash(
			JSON.stringify([result.complete, result.omittedPaths ?? []]),
		),
	};
}

/** Optimistic capture: recheck refs, index and exact patch before inference; never call it an atomic filesystem transaction. */
export async function captureLocalReview(
	root: string,
	options: DiffOptions,
	readPatch: (options: DiffOptions) => Promise<LocalPatchResult>,
) {
	const opts = structuredClone(options);
	admit(opts);
	const before = await state(root, opts);
	const result = await readPatch(structuredClone(opts));
	const hashes = checkedPatch(result);
	if (JSON.stringify(before) !== JSON.stringify(await state(root, opts)))
		throw new AiSnapshotError("stale");
	const identity: Extract<SnapshotIdentity, { kind: "local" }> = {
		kind: "local",
		...before,
		patchHash: hashes.patchHash,
	};
	Object.freeze(identity);
	const omissions = [
		...(before.repositoryHeadSha
			? []
			: [
					"Repository HEAD could not be established; no repository HEAD identity is claimed.",
				]),
		"Local capture is optimistic, not an atomic filesystem snapshot. Original files have not been captured.",
		...(before.mode === "mixed"
			? [
					"Staged and unstaged patch occurrences are distinct; no single old/new revision pair is asserted.",
				]
			: []),
		...(result.complete
			? []
			: ["The local diff reports incomplete source capture."]),
		...(result.omittedPaths ?? []).map((path) => `Omitted local patch: ${path}`),
	];
	return {
		identity,
		patch: result.patch,
		omissions,
		async assertFresh() {
			if (JSON.stringify(before) !== JSON.stringify(await state(root, opts)))
				throw new AiSnapshotError("stale");
			if (
				JSON.stringify(hashes) !==
				JSON.stringify(checkedPatch(await readPatch(structuredClone(opts))))
			)
				throw new AiSnapshotError("stale");
			if (JSON.stringify(before) !== JSON.stringify(await state(root, opts)))
				throw new AiSnapshotError("stale");
		},
	};
}
