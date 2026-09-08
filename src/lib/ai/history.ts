/**
 * Commit history for a captured source.
 *
 * History is addressed by snapshot key, never by a caller-supplied path, so a
 * run can only ask about files it was already given. Only commit metadata is
 * returned — never a patch — so history cannot become a way to read content
 * the capture withheld. The git invocation is read-only, takes no shell, and
 * is bounded in commits, bytes and time.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AiSnapshotError, type ReviewSnapshot } from "./snapshots.js";

const exec = promisify(execFile);

export const HISTORY_LIMITS = Object.freeze({
	maxCommits: 50,
	maxBytes: 1024 * 1024,
	timeoutMs: 10_000,
});

export interface HistoryCommit {
	sha: string;
	shortSha: string;
	subject: string;
	authorName: string;
	authorDate: string;
}

export interface SourceHistory {
	key: string;
	path: string;
	commits: HistoryCommit[];
	nextCursor: string | null;
}

/** ASCII unit/record separators; neither can occur in the requested fields. */
const FIELD = "\u001f";
const RECORD = "\u001e";

export type GitRunner = (args: string[]) => Promise<string>;

function defaultRunner(repositoryRoot: string): GitRunner {
	return async (args) => {
		const { stdout } = await exec(
			"git",
			[
				"--no-optional-locks",
				"-c",
				"core.fsmonitor=false",
				"-C",
				repositoryRoot,
				...args,
			],
			{
				encoding: "utf8",
				maxBuffer: HISTORY_LIMITS.maxBytes,
				timeout: HISTORY_LIMITS.timeoutMs,
				env: {
					...process.env,
					GIT_NO_LAZY_FETCH: "1",
					GIT_TERMINAL_PROMPT: "0",
				},
			},
		);
		return stdout;
	};
}

export function parseHistory(stdout: string): HistoryCommit[] {
	const commits: HistoryCommit[] = [];
	for (const record of stdout.split(RECORD)) {
		const line = record.replace(/^\r?\n/, "");
		if (!line.trim()) continue;
		const [sha, shortSha, authorName, authorDate, ...subject] =
			line.split(FIELD);
		if (
			!sha ||
			!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(sha) ||
			shortSha === undefined ||
			authorName === undefined ||
			authorDate === undefined
		)
			throw new AiSnapshotError("invalid");
		commits.push({
			sha,
			shortSha,
			authorName,
			authorDate,
			subject: subject.join(FIELD),
		});
	}
	return commits;
}

/**
 * Lists commits touching a captured source. Paging is by commit offset; the
 * result is metadata only.
 */
export async function sourceHistory(
	snapshot: ReviewSnapshot,
	repositoryRoot: string,
	options: { key: string; limit?: number; cursor?: string },
	runner?: GitRunner,
): Promise<SourceHistory> {
	const limit = options.limit ?? 20;
	if (
		typeof options.key !== "string" ||
		!options.key ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > HISTORY_LIMITS.maxCommits
	)
		throw new AiSnapshotError("invalid");
	const match = /^o:(\d{1,9})$/.exec(options.cursor ?? "o:0");
	const skip = match ? Number(match[1]) : Number.NaN;
	if (!Number.isSafeInteger(skip)) throw new AiSnapshotError("invalid");

	const source = snapshot.manifest.sources.find(
		(item) => item.key === options.key,
	);
	if (!source) throw new AiSnapshotError("missing");
	if (!source.path || source.path.startsWith("-"))
		throw new AiSnapshotError("invalid");

	const run = runner ?? defaultRunner(repositoryRoot);
	let stdout: string;
	try {
		stdout = await run([
			"log",
			`--max-count=${limit + 1}`,
			`--skip=${skip}`,
			`--pretty=format:%H${FIELD}%h${FIELD}%an${FIELD}%aI${FIELD}%s${RECORD}`,
			"--no-patch",
			"--end-of-options",
			"--",
			source.path,
		]);
	} catch {
		throw new AiSnapshotError("missing");
	}

	const parsed = parseHistory(stdout);
	const commits = parsed.slice(0, limit);
	return {
		key: source.key,
		path: source.path,
		commits,
		// One extra commit was requested purely to detect a further page.
		nextCursor: parsed.length > commits.length ? `o:${skip + commits.length}` : null,
	};
}
