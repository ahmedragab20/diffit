import { createContext, useContext, type ReactNode } from "react";

/** Actions belong to the displayed comment store, not the reusable bubble. */
export interface CommentActions {
  addReply: (id: string, body: string) => Promise<unknown>;
  editComment: (id: string, body: string) => void | Promise<unknown>;
  resolveComment: (id: string) => void | Promise<unknown>;
  unresolveComment: (id: string) => void | Promise<unknown>;
  editReply?: (commentId: string, replyId: string, body: string) => void | Promise<unknown>;
  removeReply?: (commentId: string, replyId: string) => void | Promise<unknown>;
  applySuggestion?: (id: string) => Promise<unknown>;
}

const CommentActionsContext = createContext<CommentActions | null>(null);

export function CommentActionsProvider({ actions, children }: { actions: CommentActions; children: ReactNode }) {
  return <CommentActionsContext.Provider value={actions}>{children}</CommentActionsContext.Provider>;
}

export function useScopedCommentActions() {
  return useContext(CommentActionsContext);
}
