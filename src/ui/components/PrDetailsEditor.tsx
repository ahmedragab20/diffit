import { useRef, useState } from "react";
import type { PrSession } from "../../lib/pr-session";
import { Modal } from "../primitives/Modal";
import { ConfirmDialog } from "../primitives/ConfirmDialog";
import { Markdown } from "./Markdown";

export function PrDetailsEditor({
  session,
  onClose,
  onChanged,
}: {
  session: PrSession;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [original] = useState({
    title: session.title,
    body: session.body ?? "",
  });
  const [title, setTitle] = useState(original.title);
  const [body, setBody] = useState(original.body);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const dirty = title !== original.title || body !== original.body;
  const close = () => {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  };
  const save = async () => {
    if (busy || !title.trim()) return;
    const fields: { title?: string; body?: string } = {};
    if (title.trim() !== original.title) fields.title = title.trim();
    if (body !== original.body) fields.body = body;
    if (!Object.keys(fields).length) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/gh/pr", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      onChanged?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "GitHub update failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        open
        onClose={close}
        className="pr-details-editor"
        ariaLabel="Edit pull request"
        initialFocus={titleRef}
        ariaBusy={busy}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <header>
            <h2>Edit pull request</h2>
            <p>Changes are saved directly to GitHub.</p>
          </header>
          <div className="pr-details-editor-fields">
            <label htmlFor="pr-details-title">Title</label>
            <input
              id="pr-details-title"
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={busy}
              required
              aria-invalid={!title.trim()}
            />
            {!title.trim() && <p role="alert">Title cannot be blank.</p>}
            <div className="pr-details-description-heading">
              <label htmlFor="pr-details-body">Description</label>
              <div role="group" aria-label="Description mode">
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-pressed={!preview}
                  onClick={() => setPreview(false)}
                >
                  Write
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-pressed={preview}
                  onClick={() => setPreview(true)}
                >
                  Preview
                </button>
              </div>
            </div>
            {preview ? (
              <div className="pr-details-preview">
                {body.trim() ? (
                  <Markdown content={body} className="markdown-body" />
                ) : (
                  <p>No description.</p>
                )}
              </div>
            ) : (
              <textarea
                id="pr-details-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                disabled={busy}
                rows={12}
              />
            )}
            {error && (
              <p className="pr-author-actions-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={busy || !title.trim()}
            >
              {busy ? "Saving…" : "Save to GitHub"}
            </button>
          </footer>
        </form>
      </Modal>
      <ConfirmDialog
        open={discard}
        title="Discard changes?"
        description="Your unsaved title and description changes will be lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onConfirm={onClose}
        onCancel={() => setDiscard(false)}
      />
    </>
  );
}
