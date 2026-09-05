---
title: Comments XML
description: Schema for agent handoff comment documents.
summary: Structured XML with instructions, optional general-comment, file groups, severity, and replies for await-review payloads.
order: 4
section: reference
---

Exported via `diffing comments`, `await-review`, MCP list/await tools, and UI clipboard.

## Elements

| Element | Role |
| --------- | ------ |
| `<code-review-comments>` | Root |
| `<instructions>` | Agent guidance and examples stored as CDATA text |
| `<general-comment>` | Optional round-level markdown (CDATA) |
| `<file path="…">` | Groups threads per path |
| `<comment>` | Thread — attrs below |
| `<code>` | Optional line context (`+`/`-` prefixes) |
| `<body>` | Markdown (CDATA) |
| `<replies>` / `<reply>` | Thread replies |

### comment attributes

| Attr | Values |
| ------ | -------- |
| `id` | UUID |
| `line` | `"15"` · `"10-15"` (inclusive) · `"file"` |
| `side` | `additions` \| `deletions` |
| `status` | `open` \| `resolved` |
| `severity` | optional `blocking` \| `nit` \| `question` \| `praise` |
| `created-at` | ISO-8601 |

### reply attributes

| Attr | Values |
| ------ | -------- |
| `id` | UUID |
| `role` | `user` \| `agent` |
| `model` | optional provenance |
| `created-at` | ISO-8601 |

## Escaping

Code, plan, and mockup handoffs escape free-text attributes, including quotes and tab/LF/CR whitespace. Bodies and instruction examples remain text: literal `]]>` terminators are split across CDATA sections. Carriage returns use character references outside CDATA so XML parsers preserve them. XML-invalid controls and unpaired UTF-16 surrogates become `U+FFFD`; valid Unicode remains intact. The Rust TUI uses the same escaping rules for code handoffs.

This guarantees serialization, not that an LLM will ignore malicious instructions in review content. Treat review text as untrusted data.

## Example

```xml
<code-review-comments>
  <instructions><![CDATA[Review guidance and examples…]]></instructions>
  <general-comment><![CDATA[Looks good overall.]]></general-comment>
  <file path="src/utils/parser.ts">
    <comment id="c1" line="42-45" side="additions" status="open" severity="blocking" created-at="2026-05-24T22:00:00.000Z">
      <code><![CDATA[
+ const parsedToken = tokenize(input);
]]></code>
      <body><![CDATA[Guard undefined inputs.]]></body>
      <replies>
        <reply id="r1" created-at="2026-05-24T22:05:00.000Z" role="agent" model="claude">
          <![CDATA[Added a guard.]]>
        </reply>
      </replies>
    </comment>
  </file>
</code-review-comments>
```

## Severity policy for agents

| Severity | Action |
| ---------- | -------- |
| `blocking` | Must address before resolve |
| `nit` | Optional |
| `question` | Answer; usually leave open |
| `praise` | No code change |
| omitted | Treat as normal open request |
