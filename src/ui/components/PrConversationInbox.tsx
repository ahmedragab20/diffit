import { MessageCircle } from "lucide-react";
import type { PrExistingComment } from "../../lib/pr-session";
import { ExistingPrCommentBubble } from "./ExistingPrCommentBubble";

interface PrConversationInboxProps {
      comments: PrExistingComment[];
      onReply?: (commentId: number, body: string) => Promise<void> | void;
      onEdit?: (commentId: number, body: string) => Promise<void>;
      onDelete?: (commentId: number) => Promise<void>;
      onSetResolved?: (threadId: string, resolved: boolean) => Promise<void>;
}

/**
 * Threads whose files left the current patch. They cannot render on a FileDiffCard.
 */
export function PrConversationInbox({
      comments,
      onReply,
      onEdit,
      onDelete,
      onSetResolved,
}: PrConversationInboxProps) {
      if (comments.length === 0) return null;
      return (
            <section
                  className="pr-conversation-inbox"
                  aria-label="Conversations on files no longer in this patch"
            >
                  <header className="pr-conversation-inbox-head">
                        <MessageCircle size={13} aria-hidden="true" />
                        <span>
                              {comments.length} conversation
                              {comments.length === 1 ? "" : "s"} on files no
                              longer in this patch
                        </span>
                  </header>
                  <ul className="pr-conversation-inbox-list">
                        {comments.map((comment) => (
                              <li
                                    key={comment.id}
                                    className="pr-conversation-inbox-item"
                              >
                                    <code className="pr-conversation-inbox-path">
                                          {comment.path}
                                    </code>
                                    <ExistingPrCommentBubble
                                          comment={comment}
                                          onReply={onReply}
                                          onEdit={onEdit}
                                          onDelete={onDelete}
                                          onSetResolved={onSetResolved}
                                    />
                              </li>
                        ))}
                  </ul>
            </section>
      );
}
