# Code intel

The review page can act like a small editor: hover a token for its type and
docs, jump to its declaration, see compiler diagnostics while editing in
place, and apply a rename, format, or quick fix — without leaving the diff.

Everything is **off by default**. Turn it on under Settings → Editing after
configuring a language server.

## Configure a language server

Nothing is presumed. Add a server per file extension in the settings file
(`diffing config` or `~/.config/diffing/settings.json`):

```jsonc
{
  "aiLanguageServers": {
    "ts": { "command": "typescript-language-server", "args": ["--stdio"] },
    "tsx": { "command": "typescript-language-server", "args": ["--stdio"] }
  }
}
```

`languageServers` is accepted as an alias for `aiLanguageServers`. The command
is resolved on `PATH` and never run through a shell. A missing binary reports
the feature unavailable rather than pretending there were no results.

Language servers answer about the **working tree**. Code intel is therefore
unavailable for pull-request reviews, revision ranges, and the staged-only
view.

## What you get

| Setting | What it does |
| --- | --- |
| **Code intel** | Hover a token for type and docs. Modifier-click (⌘/Ctrl) opens the declaration — in the diff when that file is already there, otherwise in a peek panel. While editing: F2 rename, Shift+Alt+F format, **Fix…** on a selection for quick fixes. |
| **Edit diagnostics** | Built-in whitespace checks while editing. Combined with Code intel, also shows the language server's diagnostics, merged and capped. |
| **Edit prediction (Alt)** | Ghost-text suggestions from the configured AI model, only for files already in the diff. Hold Alt to show one. Off by default. |

A rename or quick fix that would also change other files is **reported, not
applied**: "12 edits across 4 files — not applied, this file only". Code
actions that only run a language-server command are listed as unavailable.

## Limits

- One language server per extension, rooted at the repository.
- The language server never writes files or runs commands. Edits go through
  the local editor's undo stack.
- Hover markdown is sanitized like every other repository-derived body.
