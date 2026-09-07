import { describe, expect, it } from "vitest";
import { parseGhPaginatedJson } from "../github.js";

describe("parseGhPaginatedJson", () => {
  it("parses a single JSON array page", () => {
    expect(
      parseGhPaginatedJson(JSON.stringify([{ id: 1 }, { id: 2 }])),
    ).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("flattens --slurp nested page arrays", () => {
    expect(
      parseGhPaginatedJson(JSON.stringify([[{ id: 1 }], [{ id: 2 }]])),
    ).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("parses concatenated JSON arrays from gh --paginate without --slurp", () => {
    const stdout = `${JSON.stringify([{ id: 1 }])}\n${JSON.stringify([{ id: 2 }])}\n`;
    expect(parseGhPaginatedJson(stdout)).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
