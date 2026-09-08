import {
	AiSnapshotError,
	type ReviewSnapshot,
	type AiEvidenceReference,
} from "./snapshots.js";

/** Every issued range appears verbatim below. Never truncate this result after reading. */
export function renderSnapshotEvidence(
	snapshot: ReviewSnapshot,
	budget: number,
) {
	const manifest = snapshot.manifest;
	const references: AiEvidenceReference[] = [];
	const blocks: string[] = [];
	let remaining = Math.max(0, Math.floor(budget));
	let truncated = manifest.omissions.length > 0;
	for (const [index, source] of manifest.sources.entries()) {
		let grant = Math.floor(remaining / (manifest.sources.length - index));
		const header = JSON.stringify({
			source: source.id,
			path: source.path,
			side: source.side,
			revision: source.revision,
			provenance: source.provenance,
			representation: source.representation ?? "document",
			...(source.key === "body-draft"
				? { label: "Unsubmitted plan text (draft, not stored evidence)" }
				: {}),
		});
		const heading = `\n\nSource ${header}\n`;
		// Fixed UUIDs/hashes and bounded integer offsets keep reference JSON below 1024 bytes.
		const reserved = Buffer.byteLength(heading, "utf8") + 1024;
		let nextLine = 1;
		if (!source.hash || source.lines === 0) {
			const block = `${heading}${source.hash ? "[Empty captured source]" : "[Source omitted: original unavailable]"}`;
			const cost = Buffer.byteLength(block, "utf8");
			if (cost <= grant) {
				blocks.push(block);
				remaining -= cost;
			} else truncated = true;
			truncated ||= !source.hash || !source.complete;
			continue;
		}
		while (nextLine <= source.lines && grant > reserved) {
			try {
				const page = snapshot.read(
					source.key,
					nextLine,
					source.lines,
					Math.min(256 * 1024, grant - reserved),
				);
				const block = `${heading}Evidence ${JSON.stringify(page.evidence)}\n${page.text}`;
				const cost = Buffer.byteLength(block, "utf8");
				// Failure here aborts prompt construction instead of silently dropping an issued read.
				if (cost > grant) throw new AiSnapshotError("invalid");
				blocks.push(block);
				references.push(page.evidence);
				grant -= cost;
				remaining -= cost;
				nextLine = page.evidence.endLine + 1;
			} catch (error) {
				if (!(error instanceof AiSnapshotError) || error.code !== "limit")
					throw error;
				break;
			}
		}
		truncated ||= nextLine <= source.lines || !source.complete;
	}
	return {
		text: blocks.join(""),
		references,
		truncated,
		coverage: {
			basis: "lines-in-this-prompt" as const,
			returnedLines: references.reduce(
				(sum, ref) => sum + ref.endLine - ref.startLine + 1,
				0,
			),
			availableLines: manifest.sources.reduce(
				(sum, source) => sum + source.lines,
				0,
			),
			readSourceCount: new Set(references.map((ref) => ref.sourceId)).size,
			sourceCount: manifest.sources.length,
			omittedSourceCount: manifest.sources.filter(
				(source) => !source.hash || !source.complete,
			).length,
		},
	};
}
