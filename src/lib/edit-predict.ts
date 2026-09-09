/**
 * Bounded edit-prediction: turn a model reply into the editor's TextEdit
 * shape. The language server never sees this path; it is the AI half of the
 * in-place editor, confined to the file the reviewer is already editing.
 */

export interface PredictedEdit {
	range: {
		start: { line: number; character: number };
		end: { line: number; character: number };
	};
	newText: string;
}

export interface PredictedEdits {
	edits: PredictedEdit[];
	newCursor: { line: number; character: number };
}

const MAX_EDITS = 32;
const MAX_TEXT = 8 * 1024;

/** Prompt the model for a JSON edit list against one excerpt. */
export function editPredictPrompt(input: {
	path: string;
	excerptText: string;
	cursorOffsetInExcerpt: number;
}): string {
	const cursor = Math.max(
		0,
		Math.min(input.cursorOffsetInExcerpt, input.excerptText.length),
	);
	const before = input.excerptText.slice(0, cursor);
	const after = input.excerptText.slice(cursor);
	return [
		"Predict the next edit in this file. Reply with JSON only:",
		'{"edits":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"newText":""}],"newCursor":{"line":0,"character":0}}',
		"Positions are zero-based and absolute in the full document. Do not touch any other file.",
		`File: ${input.path}`,
		"Excerpt with the cursor marked as <|> :",
		"```",
		`${before}<|>${after}`,
		"```",
	].join("\n");
}

function position(value: unknown): { line: number; character: number } | null {
	if (!value || typeof value !== "object") return null;
	const item = value as { line?: unknown; character?: unknown };
	if (
		!Number.isSafeInteger(item.line) ||
		!Number.isSafeInteger(item.character) ||
		(item.line as number) < 0 ||
		(item.character as number) < 0
	)
		return null;
	return { line: item.line as number, character: item.character as number };
}

/**
 * Read a model's reply. Accepts a bare object or one wrapped in a fenced
 * block. Anything that is not a well-formed, bounded edit list is refused.
 */
export function parsePredictedEdits(text: string): PredictedEdits | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	const raw = (fenced?.[1] ?? text).trim();
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		if (start < 0 || end <= start) return null;
		try {
			value = JSON.parse(raw.slice(start, end + 1));
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object") return null;
	const item = value as { edits?: unknown; newCursor?: unknown };
	if (!Array.isArray(item.edits) || item.edits.length === 0) return null;
	if (item.edits.length > MAX_EDITS) return null;
	const newCursor = position(item.newCursor);
	if (!newCursor) return null;
	const edits: PredictedEdit[] = [];
	for (const entry of item.edits) {
		if (!entry || typeof entry !== "object") return null;
		const edit = entry as { range?: unknown; newText?: unknown };
		if (typeof edit.newText !== "string" || edit.newText.length > MAX_TEXT)
			return null;
		const range = edit.range as
			| { start?: unknown; end?: unknown }
			| undefined;
		const start = position(range?.start);
		const end = position(range?.end);
		if (!start || !end) return null;
		edits.push({ range: { start, end }, newText: edit.newText });
	}
	return { edits, newCursor };
}

export type EditPredictResult =
	| { available: true; edits: PredictedEdit[]; newCursor: { line: number; character: number } }
	| { available: false; reason: "not-configured" | "server-error" };

/**
 * Ask a completer for the next edit and parse the reply. The completer is the
 * existing AI backend; this module only owns the prompt and the bound.
 */
export async function runEditPrediction(
	input: {
		path: string;
		excerptText: string;
		cursorOffsetInExcerpt: number;
	},
	complete: (prompt: string, signal: AbortSignal) => Promise<string | null>,
	signal: AbortSignal,
): Promise<EditPredictResult> {
	const text = await complete(editPredictPrompt(input), signal);
	if (text === null) return { available: false, reason: "not-configured" };
	const parsed = parsePredictedEdits(text);
	if (!parsed) return { available: false, reason: "server-error" };
	return { available: true, ...parsed };
}
