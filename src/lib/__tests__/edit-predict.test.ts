import { describe, expect, it } from "vitest";
import { editPredictPrompt, parsePredictedEdits } from "../edit-predict.js";

describe("parsePredictedEdits", () => {
	const valid = {
		edits: [
			{
				range: {
					start: { line: 3, character: 2 },
					end: { line: 3, character: 5 },
				},
				newText: "renamed",
			},
		],
		newCursor: { line: 3, character: 9 },
	};

	it("accepts a bare JSON object", () => {
		expect(parsePredictedEdits(JSON.stringify(valid))).toEqual(valid);
	});

	it("accepts a fenced JSON block", () => {
		expect(
			parsePredictedEdits("Sure.\n```json\n" + JSON.stringify(valid) + "\n```"),
		).toEqual(valid);
	});

	it("refuses an empty edit list", () => {
		expect(
			parsePredictedEdits(
				JSON.stringify({ edits: [], newCursor: { line: 0, character: 0 } }),
			),
		).toBeNull();
	});

	it("refuses a reply that is not JSON", () => {
		expect(parsePredictedEdits("I would add a comma here.")).toBeNull();
	});
});

describe("runEditPrediction", () => {
	it("returns not-configured when the completer has nothing to say", async () => {
		const { runEditPrediction } = await import("../edit-predict.js");
		const result = await runEditPrediction(
			{ path: "src/a.ts", excerptText: "x", cursorOffsetInExcerpt: 0 },
			async () => null,
			new AbortController().signal,
		);
		expect(result).toEqual({ available: false, reason: "not-configured" });
	});
});

describe("editPredictPrompt", () => {
	it("marks the cursor inside the excerpt", () => {
		const prompt = editPredictPrompt({
			path: "src/a.ts",
			excerptText: "const x = 1;",
			cursorOffsetInExcerpt: 6,
		});
		expect(prompt).toContain("File: src/a.ts");
		expect(prompt).toContain("const <|>x = 1;");
	});
});
