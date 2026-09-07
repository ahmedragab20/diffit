// Parse real XML to verify the shared escaping helpers and text round trips.
import { describe, it, expect } from "vitest";
import {
  escapeXmlAttribute,
  escapeCdataText,
  joinReviewXml,
} from "../../../lib/xml.js";

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const errors = Array.from(doc.getElementsByTagName("parsererror"));
  expect(
    errors,
    `helper emitted malformed XML (parsererror: ${errors.map((e) => e.textContent?.trim()).join(" | ")})\n---\n${xml}`,
  ).toHaveLength(0);
  return doc;
}

describe("escapeXmlAttribute", () => {
  it("round-trips quoted attribute text containing ampersand, <, >, both quotes, tab/LF/CR and emoji", () => {
    const hostile =
      "say \"hi\" & <injected/> > ok 'single' \t tab \n line \r cr \u{1F600} done";
    const xml = `<root a="${escapeXmlAttribute(hostile)}"/>`;
    const doc = parseXml(xml);
    expect(doc.documentElement.getAttribute("a")).toBe(hostile);
  });

  it("replaces NUL and unpaired surrogates with U+FFFD but keeps emoji intact", () => {
    const input = "a\0b\uD800c\u{1F600}d";
    const xml = `<root a="${escapeXmlAttribute(input)}"/>`;
    const doc = parseXml(xml);
    expect(doc.documentElement.getAttribute("a")).toBe(
      "a\uFFFDb\uFFFDc\u{1F600}d",
    );
  });
});

describe("escapeCdataText", () => {
  it("round-trips text containing repeated ]]> and CRLF inside a CDATA section", () => {
    const hostile = "before ]]> middle ]]> after \r\n tail";
    const xml = `<root><t><![CDATA[${escapeCdataText(hostile)}]]></t></root>`;
    const doc = parseXml(xml);
    expect(doc.getElementsByTagName("t")[0].textContent).toBe(hostile);
  });

  it("replaces NUL and unpaired surrogates with U+FFFD inside CDATA", () => {
    const input = "x\0y\uDFFFz";
    const xml = `<root><t><![CDATA[${escapeCdataText(input)}]]></t></root>`;
    const doc = parseXml(xml);
    expect(doc.getElementsByTagName("t")[0].textContent).toBe(
      "x\uFFFDy\uFFFDz",
    );
  });
});

describe("joinReviewXml", () => {
  it('wraps instruction examples containing <reply to="<id>"> and literal ]]> as text: one instructions element, no reply element', () => {
    const lines = [
      "<code-review-comments>",
      "  <instructions>",
      '    To answer, emit: <reply to="<id>">your text with ]]> inside</reply>',
      "  </instructions>",
      "</code-review-comments>",
    ];
    const xml = joinReviewXml(lines);
    const doc = parseXml(xml);
    expect(doc.getElementsByTagName("instructions")).toHaveLength(1);
    expect(doc.getElementsByTagName("reply")).toHaveLength(0);
    const instructions = doc.getElementsByTagName("instructions")[0];
    expect(instructions.textContent).toContain('<reply to="<id>">');
    expect(instructions.textContent).toContain("]]>");
  });

  it("leaves input without an instructions block unchanged", () => {
    const lines = [
      "<code-review-comments>",
      "  <body><![CDATA[plain comment]]></body>",
      "</code-review-comments>",
    ];
    expect(joinReviewXml(lines)).toBe(lines.join("\n"));
  });
});
