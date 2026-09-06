import { useState } from "react";
import { AlignLeft, GitMerge, Pencil, XCircle } from "lucide-react";
import type { PrSession } from "../../lib/pr-session";
import { mergeBlockedReason } from "../../lib/pr-timeline";
import { ConfirmDialog } from "../primitives/ConfirmDialog";

export function PrAuthorActions({
  session,
  onChanged,
}: {
  session: PrSession;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"close" | "reopen" | "merge" | null>(null);
  const [editing, setEditing] = useState<null | "title" | "body">(null);
  const [title, setTitle] = useState(session.title);
  const [body, setBody] = useState(session.body ?? "");
  const blocked = mergeBlockedReason(session);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub update failed");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const post = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  };

  const patchPr = async (fields: { title?: string; body?: string }) => {
    const res = await fetch("/api/gh/pr", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    setEditing(null);
  };

  const saveTitle = async () => {
    const next = title.trim();
    if (!next || next === session.title) {
      setEditing(null);
      return;
    }
    await run(() => patchPr({ title: next }));
  };

  const saveBody = async () => {
    if (body === (session.body ?? "")) {
      setEditing(null);
      return;
    }
    await run(() => patchPr({ body }));
  };

  if (session.state === "merged") return null;

  return (
    <div className="pr-author-actions">
      {editing === "title" ? (
        <form
          className="pr-author-title-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveTitle();
          }}
        >
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-label="Pull request title"
            disabled={busy}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setTitle(session.title);
              setEditing(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          title="Edit title on GitHub"
          onClick={() => setEditing("title")}
        >
          <Pencil size={12} /> <span className="btn-label">Title</span>
        </button>
      )}
      {editing === "body" ? (
        <form
          className="pr-author-title-form is-body"
          onSubmit={(event) => {
            event.preventDefault();
            void saveBody();
          }}
        >
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            aria-label="Pull request description"
            disabled={busy}
            rows={4}
          />
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setBody(session.body ?? "");
              setEditing(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          title="Edit description on GitHub"
          onClick={() => setEditing("body")}
        >
          <AlignLeft size={12} /> <span className="btn-label">Description</span>
        </button>
      )}
      {session.state === "closed" ? (
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => setConfirm("reopen")}
        >
          Reopen
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => setConfirm("close")}
        >
          <XCircle size={12} /> <span className="btn-label">Close</span>
        </button>
      )}
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={busy || Boolean(blocked)}
        title={blocked ?? "Merge this pull request on GitHub"}
        onClick={() => setConfirm("merge")}
      >
        <GitMerge size={12} /> <span className="btn-label">Merge</span>
      </button>
      {error && (
        <span className="pr-author-actions-error" role="alert">
          {error}
        </span>
      )}
      <ConfirmDialog
        open={confirm === "close"}
        title="Close pull request?"
        description="This closes the pull request on GitHub. You can reopen it later."
        confirmLabel="Close pull request"
        variant="danger"
        busy={busy}
        onConfirm={() => void run(() => post("/api/gh/pr/close", {}))}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "reopen"}
        title="Reopen pull request?"
        description="This reopens the pull request on GitHub."
        confirmLabel="Reopen"
        variant="primary"
        busy={busy}
        onConfirm={() => void run(() => post("/api/gh/pr/reopen", {}))}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "merge"}
        title="Merge pull request?"
        description={
          blocked ??
          `Merges ${session.headRefName ?? "the head branch"} into ${session.baseRefName ?? "the base"} at ${session.headSha.slice(0, 7)}. This cannot be undone from diffing.`
        }
        confirmLabel="Merge"
        variant="danger"
        busy={busy}
        onConfirm={() =>
          void run(() =>
            post("/api/gh/pr/merge", {
              method: "merge",
              expectedHeadSha: session.headSha,
            }),
          )
        }
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
