import { ApiError } from "./auth-helpers.js";
import {
  conversationStore,
  type StoredConversation,
} from "./conversation-store.js";

export function canViewConversation(
  conversationId: string,
  userId: string,
): StoredConversation | undefined {
  const conversation = conversationStore.getConversation(conversationId);
  if (!conversation) {return undefined;}
  if (conversationStore.getMember(conversationId, userId)) {return conversation;}
  if (conversation.type === "channel" && conversation.privacy === "public") {
    return conversation;
  }
  return undefined;
}

export function requireVisibleConversation(
  conversationId: string,
  userId: string,
): StoredConversation {
  const c = canViewConversation(conversationId, userId);
  if (!c) {throw new ApiError(404, "not_found", "Conversation not found");}
  return c;
}
