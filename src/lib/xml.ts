// XML 1.0 cannot represent these controls or unpaired UTF-16 surrogates.
// Replace them visibly instead of producing an unreadable handoff document.
function xmlCharacters(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/gu,
    "\uFFFD",
  );
}

export function escapeXmlAttribute(value: string): string {
  return (
    xmlCharacters(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      // Literal attribute whitespace is normalized by XML parsers.
      .replace(/\t/g, "&#9;")
      .replace(/\n/g, "&#10;")
      .replace(/\r/g, "&#13;")
  );
}

/** Encode text placed inside an existing CDATA section, preserving its value. */
export function escapeCdataText(value: string): string {
  return xmlCharacters(value)
    .replace(/\]\]>/g, "]]]]><![CDATA[>")
    .replace(/\r/g, "]]>&#13;<![CDATA[");
}

/** Keep formatter-owned instruction examples as text, not XML child elements. */
export function joinReviewXml(lines: string[]): string {
  const start = lines.indexOf("  <instructions>");
  const end = start < 0 ? -1 : lines.indexOf("  </instructions>", start + 1);
  if (end < 0) return lines.join("\n");
  return [
    ...lines.slice(0, start + 1),
    `<![CDATA[${escapeCdataText(lines.slice(start + 1, end).join("\n"))}]]>`,
    ...lines.slice(end),
  ].join("\n");
}
