import { useRef, useState } from "react";
import { ChevronDown, GitMerge, Pencil, XCircle } from "lucide-react";
import type { PrSession } from "../../lib/pr-session";
import { mergeBlockedReason } from "../../lib/pr-timeline";
import { ConfirmDialog } from "../primitives/ConfirmDialog";
import { Popover } from "../primitives/Popover";
import { PrDetailsEditor } from "./PrDetailsEditor";

export function PrAuthorActions({
  session,
  onChanged,
}: {
  session: PrSession;
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"close" | "reopen" | "merge" | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const blocked = mergeBlockedReason(session);
  const run = async () => {
    if (busy || !confirm) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gh/pr/${confirm}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          confirm === "merge"
            ? { method: "merge", expectedHeadSha: session.headSha }
            : {},
        ),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onChanged?.();
      setConfirm(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub update failed");
    } finally {
      setBusy(false);
    }
  };
  const choose = (action: "close" | "reopen" | "merge") => {
    setActionsOpen(false);
    setError(null);
    setConfirm(action);
  };
  if (session.state === "merged") return null;
  return (
    <div className="pr-author-actions">
      <button
        ref={editRef}
        type="button"
        className="btn btn-sm"
        onClick={() => setEditing(true)}
      >
        <Pencil size={12} /> Edit details
      </button>
      <Popover
        open={actionsOpen}
        onOpenChange={setActionsOpen}
        ariaLabel="PR actions"
        className="pr-actions-popover"
        trigger={
          <button type="button" className="btn btn-sm">
            PR actions <ChevronDown size={12} />
          </button>
        }
      >
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || Boolean(blocked)}
          title={blocked ?? "Merge this pull request on GitHub"}
          onClick={() => choose("merge")}
        >
          <GitMerge size={12} /> Merge pull request
        </button>
        {blocked && <p className="pr-actions-hint">{blocked}</p>}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() =>
            choose(session.state === "closed" ? "reopen" : "close")
          }
        >
          <XCircle size={12} />{" "}
          {session.state === "closed"
            ? "Reopen pull request"
            : "Close pull request"}
        </button>
      </Popover>
      {editing && (
        <PrDetailsEditor
          session={session}
          onChanged={onChanged}
          onClose={() => {
            setEditing(false);
            editRef.current?.focus();
          }}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === "merge"
            ? "Merge pull request?"
            : confirm === "reopen"
              ? "Reopen pull request?"
              : "Close pull request?"
        }
        description={
          confirm === "merge"
            ? (blocked ??
              `Merges ${session.headRefName ?? "the head branch"} into ${session.baseRefName ?? "the base"} at ${session.headSha.slice(0, 7)}. This cannot be undone from diffing.`)
            : confirm === "reopen"
              ? "This reopens the pull request on GitHub."
              : "This closes the pull request on GitHub. You can reopen it later."
        }
        confirmLabel={
          confirm === "merge"
            ? "Merge"
            : confirm === "reopen"
              ? "Reopen"
              : "Close pull request"
        }
        variant={confirm === "reopen" ? "primary" : "danger"}
        busy={busy}
        error={error}
        onConfirm={run}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
