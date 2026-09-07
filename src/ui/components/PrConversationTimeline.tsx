import { useState } from "react";
import { ChevronLeft, ChevronRight, MessageCircle } from "lucide-react";
import type { PrTimelineItem } from "../../lib/pr-timeline";
import { Markdown } from "./Markdown";

const KIND_LABEL: Record<PrTimelineItem["kind"], string> = {
  "pr-description": "Description",
  "issue-comment": "Comment",
  review: "Review",
  "timeline-event": "Event",
};

export function PrConversationTimeline({
  items,
  total,
  cursor,
  onPage,
}: {
  items: PrTimelineItem[];
  total: number;
  cursor: number;
  onPage?: (cursor: number) => void;
}) {
  const [active, setActive] = useState(0);
  if (items.length === 0 && total === 0) return null;
  const item = items[Math.min(active, items.length - 1)] ?? items[0];
  if (!item) return null;

  return (
    <section className="pr-conversation-timeline" aria-label="Pull request conversation">
      <header className="pr-conversation-timeline-head">
        <span>
          <MessageCircle size={13} aria-hidden="true" /> Conversation
        </span>
        <span>
          {cursor + active + 1} / {total}
        </span>
        <nav aria-label="Walk conversation">
          <button
            type="button"
            className="btn btn-sm commit-walk-btn"
            disabled={cursor === 0 && active === 0}
            onClick={() => {
              if (active > 0) setActive((value) => value - 1);
              else onPage?.(Math.max(0, cursor - items.length));
            }}
            aria-label="Newer conversation item"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className="btn btn-sm commit-walk-btn"
            disabled={cursor + active + 1 >= total}
            onClick={() => {
              if (active < items.length - 1) setActive((value) => value + 1);
              else onPage?.(cursor + items.length);
            }}
            aria-label="Older conversation item"
          >
            <ChevronRight size={14} />
          </button>
        </nav>
      </header>
      <div className="pr-conversation-timeline-meta">
        <strong>{KIND_LABEL[item.kind]}</strong>
        {item.author ? <span>@{item.author}</span> : null}
        {item.reviewState ? <span data-state={item.reviewState}>{item.reviewState}</span> : null}
        {item.event ? <span>{item.event}{item.label ? ` ${item.label}` : ""}</span> : null}
      </div>
      {item.body?.trim() ? (
        <Markdown content={item.body} className="pr-conversation-timeline-body markdown-body" />
      ) : (
        <p className="pr-conversation-timeline-empty">No body on this item.</p>
      )}
    </section>
  );
}
