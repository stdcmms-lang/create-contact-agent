import type {
  ConversationType,
  MessageStatus,
  Reaction,
} from "../types/models.js";

export type ConversationPrivacy = "public" | "private";
export type ConversationRole = "owner" | "admin" | "member";

export type StoredConversation = {
  id: string;
  type: ConversationType;
  title: string | null;
  topic: string | null;
  privacy: ConversationPrivacy;
  avatarAttachmentId: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredMember = {
  conversationId: string;
  userId: string;
  role: ConversationRole;
  joinedAt: string;
};

export type StoredConversationState = {
  conversationId: string;
  userId: string;
  muted: boolean;
  mutedUntil: string | null;
  archived: boolean;
  pinned: boolean;
  readAt: string | null;
  deliveredAt: string | null;
  deliveredMessageId: string | null;
};

export type StoredMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string | null;
  /** Trimmed text, or undefined before first persist; null tombstone / attachment-only */
  body?: string | null;
  /** Attachment ids only in storage; resolved to AttachmentRef in API layer */
  attachmentIds: string[];
  replyToMessageId?: string;
  mentions: string[];
  reactions: Reaction[];
  status: MessageStatus;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  deletedByUserId: string | null;
  deleteForEveryone: boolean;
  pinnedAt: string | null;
  pinnedByUserId: string | null;
};

export type StoredDraft = {
  conversationId: string;
  userId: string;
  body: string | null;
  attachmentIds: string[];
  replyToMessageId: string | null;
  updatedAt: string;
};

export type StoredStar = {
  userId: string;
  messageId: string;
  starredAt: string;
  starNote: string | null;
};

export type ClientIdRecord = {
  userId: string;
  clientId: string;
  fingerprint: string;
  conversationId: string;
};

/** Idempotency record for POST /conversations/:id/messages (per sender + conversation + clientId). */
export type MessageSendClientRecord = {
  userId: string;
  conversationId: string;
  clientId: string;
  fingerprint: string;
  messageId: string;
};

function memberKey(conversationId: string, userId: string): string {
  return `${conversationId}:${userId}`;
}

function stateKey(conversationId: string, userId: string): string {
  return `${conversationId}:${userId}`;
}

function clientIdKey(userId: string, clientId: string): string {
  return `${userId}:${clientId}`;
}

function messageSendClientKey(
  userId: string,
  conversationId: string,
  clientId: string,
): string {
  return `${userId}:${conversationId}:${clientId}`;
}

function starKey(userId: string, messageId: string): string {
  return `${userId}:${messageId}`;
}

function draftKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

function threadReadKey(userId: string, rootMessageId: string): string {
  return `${userId}:${rootMessageId}`;
}

function selfHiddenKey(userId: string, messageId: string): string {
  return `${userId}:${messageId}`;
}

function compareMessageTimelineOrder(a: StoredMessage, b: StoredMessage): number {
  if (a.createdAt < b.createdAt) {return -1;}
  if (a.createdAt > b.createdAt) {return 1;}
  if (a.id < b.id) {return -1;}
  if (a.id > b.id) {return 1;}
  return 0;
}

function isRootMessageStored(m: StoredMessage): boolean {
  return m.replyToMessageId === undefined || m.replyToMessageId === null;
}

export class ConversationStore {
  conversations = new Map<string, StoredConversation>();
  members = new Map<string, StoredMember>();
  states = new Map<string, StoredConversationState>();
  messages = new Map<string, StoredMessage>();
  clientIds = new Map<string, ClientIdRecord>();
  messageSendClients = new Map<string, MessageSendClientRecord>();
  /** Per-user per-message hide for deleteFor=self */
  messageSelfHidden = new Set<string>();
  stars = new Map<string, StoredStar>();
  drafts = new Map<string, StoredDraft>();
  /** userId -> draft map keys (`userId:conversationId`) for that user */
  private draftKeysByUser = new Map<string, Set<string>>();
  /** ISO datetime: user has read thread through this time (inclusive) */
  threadReadAt = new Map<string, string>();
  /** attachmentId -> owning userId (minimal in-memory ownership for messaging) */
  attachmentOwners = new Map<string, string>();
  /** Monotonic realtime sequence per resource key (conversation:<id> | user:<id>). */
  private resourceSequences = new Map<string, number>();

  /** conversationId -> message ids in timeline order (createdAt asc, id tie-break) */
  private messageIdsByConversation = new Map<string, string[]>();
  /** conversationId -> root message ids in same timeline order (includes soft-deleted roots) */
  private rootMessageIdsByConversation = new Map<string, string[]>();
  /** rootMessageId -> direct reply ids in timeline order */
  private replyMessageIdsByRoot = new Map<string, string[]>();

  addConversation(conversation: StoredConversation): void {
    this.conversations.set(conversation.id, conversation);
  }

  getConversation(conversationId: string): StoredConversation | undefined {
    return this.conversations.get(conversationId);
  }

  removeConversation(conversationId: string): void {
    this.conversations.delete(conversationId);
    for (const key of Array.from(this.members.keys())) {
      if (key.startsWith(`${conversationId}:`)) {this.members.delete(key);}
    }
    for (const key of Array.from(this.states.keys())) {
      if (key.startsWith(`${conversationId}:`)) {this.states.delete(key);}
    }
    const messageIds: string[] = [];
    for (const [id, message] of Array.from(this.messages.entries())) {
      if (message.conversationId === conversationId) {
        this.messages.delete(id);
        messageIds.push(id);
      }
    }
    const midSet = new Set(messageIds);
    for (const [key, star] of Array.from(this.stars.entries())) {
      if (midSet.has(star.messageId)) {this.stars.delete(key);}
    }
    for (const k of Array.from(this.messageSelfHidden)) {
      const colon = k.lastIndexOf(":");
      const mid = colon === -1 ? k : k.slice(colon + 1);
      if (midSet.has(mid)) {this.messageSelfHidden.delete(k);}
    }
    for (const [key] of Array.from(this.threadReadAt.entries())) {
      const colon = key.lastIndexOf(":");
      const rootId = colon === -1 ? key : key.slice(colon + 1);
      if (midSet.has(rootId)) {this.threadReadAt.delete(key);}
    }
    for (const [key, rec] of Array.from(this.messageSendClients.entries())) {
      if (rec.conversationId === conversationId) {this.messageSendClients.delete(key);}
    }
    for (const [key, draft] of Array.from(this.drafts.entries())) {
      if (draft.conversationId === conversationId) {
        this.drafts.delete(key);
        this.forgetDraftKey(draft.userId, key);
      }
    }
    const indexed = this.messageIdsByConversation.get(conversationId);
    this.messageIdsByConversation.delete(conversationId);
    this.rootMessageIdsByConversation.delete(conversationId);
    if (indexed) {
      for (const id of indexed) {
        this.replyMessageIdsByRoot.delete(id);
      }
    } else {
      for (const id of messageIds) {
        this.replyMessageIdsByRoot.delete(id);
      }
    }
  }

  addMember(member: StoredMember): { member: StoredMember; created: boolean } {
    const key = memberKey(member.conversationId, member.userId);
    const existing = this.members.get(key);
    if (existing) {return { member: existing, created: false };}
    this.members.set(key, member);
    this.ensureState(member.conversationId, member.userId);
    return { member, created: true };
  }

  getMember(conversationId: string, userId: string): StoredMember | undefined {
    return this.members.get(memberKey(conversationId, userId));
  }

  removeMember(conversationId: string, userId: string): boolean {
    return this.members.delete(memberKey(conversationId, userId));
  }

  listMembers(conversationId: string): StoredMember[] {
    const out: StoredMember[] = [];
    for (const member of this.members.values()) {
      if (member.conversationId === conversationId) {out.push(member);}
    }
    return out;
  }

  ensureState(conversationId: string, userId: string): StoredConversationState {
    const key = stateKey(conversationId, userId);
    const existing = this.states.get(key);
    if (existing) {return existing;}
    const state: StoredConversationState = {
      conversationId,
      userId,
      muted: false,
      mutedUntil: null,
      archived: false,
      pinned: false,
      readAt: null,
      deliveredAt: null,
      deliveredMessageId: null,
    };
    this.states.set(key, state);
    return state;
  }

  getState(
    conversationId: string,
    userId: string,
  ): StoredConversationState | undefined {
    return this.states.get(stateKey(conversationId, userId));
  }

  findDirectConversation(userA: string, userB: string): StoredConversation | undefined {
    const wanted = new Set([userA, userB]);
    for (const conversation of this.conversations.values()) {
      if (conversation.type !== "direct") {continue;}
      const members = this.listMembers(conversation.id);
      if (members.length !== 2) {continue;}
      if (members.every((member) => wanted.has(member.userId))) {return conversation;}
    }
    return undefined;
  }

  listConversationsForUser(userId: string): StoredConversation[] {
    const out: StoredConversation[] = [];
    for (const conversation of this.conversations.values()) {
      if (this.getMember(conversation.id, userId)) {out.push(conversation);}
    }
    return out;
  }

  getClientIdRecord(userId: string, clientId: string): ClientIdRecord | undefined {
    return this.clientIds.get(clientIdKey(userId, clientId));
  }

  setClientIdRecord(record: ClientIdRecord): void {
    this.clientIds.set(clientIdKey(record.userId, record.clientId), record);
  }

  getMessageSendClientRecord(
    userId: string,
    conversationId: string,
    clientId: string,
  ): MessageSendClientRecord | undefined {
    return this.messageSendClients.get(
      messageSendClientKey(userId, conversationId, clientId),
    );
  }

  setMessageSendClientRecord(record: MessageSendClientRecord): void {
    this.messageSendClients.set(
      messageSendClientKey(record.userId, record.conversationId, record.clientId),
      record,
    );
  }

  addMessage(message: StoredMessage): void {
    this.messages.set(message.id, message);
    this.appendMessageIndexes(message);
  }

  private insertMessageIdOrdered(convId: string, messageId: string): void {
    const message = this.messages.get(messageId);
    if (!message || message.conversationId !== convId) {return;}
    let ids = this.messageIdsByConversation.get(convId);
    if (!ids) {
      ids = [];
      this.messageIdsByConversation.set(convId, ids);
    }
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midMsg = this.messages.get(ids[mid]);
      if (!midMsg || compareMessageTimelineOrder(midMsg, message) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    ids.splice(lo, 0, messageId);
  }

  private insertRootMessageIdOrdered(convId: string, rootId: string): void {
    const message = this.messages.get(rootId);
    if (!message || message.conversationId !== convId || !isRootMessageStored(message)) {return;}
    let ids = this.rootMessageIdsByConversation.get(convId);
    if (!ids) {
      ids = [];
      this.rootMessageIdsByConversation.set(convId, ids);
    }
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midMsg = this.messages.get(ids[mid]);
      if (!midMsg || compareMessageTimelineOrder(midMsg, message) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    ids.splice(lo, 0, rootId);
  }

  private insertReplyIdOrdered(rootId: string, replyId: string): void {
    const reply = this.messages.get(replyId);
    if (!reply || reply.replyToMessageId !== rootId) {return;}
    let ids = this.replyMessageIdsByRoot.get(rootId);
    if (!ids) {
      ids = [];
      this.replyMessageIdsByRoot.set(rootId, ids);
    }
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const midMsg = this.messages.get(ids[mid]);
      if (!midMsg || compareMessageTimelineOrder(midMsg, reply) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    ids.splice(lo, 0, replyId);
  }

  private appendMessageIndexes(message: StoredMessage): void {
    const convId = message.conversationId;
    this.insertMessageIdOrdered(convId, message.id);
    if (isRootMessageStored(message)) {
      this.insertRootMessageIdOrdered(convId, message.id);
      return;
    }
    const rootId = message.replyToMessageId;
    if (!rootId) {return;}
    const root = this.messages.get(rootId);
    if (root && isRootMessageStored(root)) {
      this.insertReplyIdOrdered(rootId, message.id);
    }
  }

  /**
   * Keep reply / root id lists consistent after soft-delete (status -> deleted).
   * Tombstone roots stay in {@link rootMessageIdsByConversation} for timeline rules.
   */
  applyMessageSoftDeleteIndexes(message: StoredMessage): void {
    if (isRootMessageStored(message)) {return;}
    const rootId = message.replyToMessageId;
    if (!rootId) {return;}
    const ids = this.replyMessageIdsByRoot.get(rootId);
    if (!ids) {return;}
    const i = ids.indexOf(message.id);
    if (i >= 0) {ids.splice(i, 1);}
    if (ids.length === 0) {this.replyMessageIdsByRoot.delete(rootId);}
  }

  /** Root ids for a conversation in timeline order (oldest first). Includes deleted roots. */
  listRootMessageIds(conversationId: string): string[] {
    const ids = this.rootMessageIdsByConversation.get(conversationId);
    return ids ? [...ids] : [];
  }

  /** Direct reply ids for a root in timeline order (may include ids whose messages are now deleted). */
  listReplyMessageIdsForRoot(rootMessageId: string): string[] {
    const ids = this.replyMessageIdsByRoot.get(rootMessageId);
    return ids ? [...ids] : [];
  }

  getMessage(messageId: string): StoredMessage | undefined {
    return this.messages.get(messageId);
  }

  listMessages(conversationId: string): StoredMessage[] {
    const ids = this.messageIdsByConversation.get(conversationId);
    if (ids && ids.length > 0) {
      const out: StoredMessage[] = [];
      for (const id of ids) {
        const m = this.messages.get(id);
        if (m) {out.push(m);}
      }
      return out;
    }
    const out: StoredMessage[] = [];
    for (const message of this.messages.values()) {
      if (message.conversationId === conversationId) {out.push(message);}
    }
    return out.sort((a, b) => compareMessageTimelineOrder(a, b));
  }

  listPinnedMessages(conversationId: string): StoredMessage[] {
    return this.listMessages(conversationId)
      .filter((message) => message.pinnedAt !== null)
      .sort((a, b) =>
        (a.pinnedAt ?? "") < (b.pinnedAt ?? "")
          ? 1
          : (a.pinnedAt ?? "") > (b.pinnedAt ?? "")
            ? -1
            : 0,
      );
  }

  isSelfHidden(userId: string, messageId: string): boolean {
    return this.messageSelfHidden.has(selfHiddenKey(userId, messageId));
  }

  setSelfHidden(userId: string, messageId: string, hidden: boolean): void {
    const k = selfHiddenKey(userId, messageId);
    if (hidden) {this.messageSelfHidden.add(k);}
    else {this.messageSelfHidden.delete(k);}
  }

  getStar(userId: string, messageId: string): StoredStar | undefined {
    return this.stars.get(starKey(userId, messageId));
  }

  setStar(star: StoredStar): void {
    this.stars.set(starKey(star.userId, star.messageId), star);
  }

  removeStar(userId: string, messageId: string): boolean {
    return this.stars.delete(starKey(userId, messageId));
  }

  listStarsForUser(userId: string): StoredStar[] {
    const out: StoredStar[] = [];
    for (const star of this.stars.values()) {
      if (star.userId === userId) {out.push(star);}
    }
    return out.sort((a, b) =>
      a.starredAt < b.starredAt ? 1 : a.starredAt > b.starredAt ? -1 : 0,
    );
  }

  getDraft(userId: string, conversationId: string): StoredDraft | undefined {
    return this.drafts.get(draftKey(userId, conversationId));
  }

  setDraft(draft: StoredDraft): void {
    const key = draftKey(draft.userId, draft.conversationId);
    this.drafts.set(key, draft);
    this.noteDraftKey(draft.userId, key);
  }

  removeDraft(userId: string, conversationId: string): boolean {
    const key = draftKey(userId, conversationId);
    const deleted = this.drafts.delete(key);
    if (deleted) {this.forgetDraftKey(userId, key);}
    return deleted;
  }

  listDraftsForUser(userId: string): StoredDraft[] {
    const keys = this.draftKeysByUser.get(userId);
    if (!keys || keys.size === 0) {return [];}
    const out: StoredDraft[] = [];
    for (const key of keys) {
      const draft = this.drafts.get(key);
      if (draft) {out.push(draft);}
    }
    return out.sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    );
  }

  private noteDraftKey(userId: string, storageKey: string): void {
    let set = this.draftKeysByUser.get(userId);
    if (!set) {
      set = new Set();
      this.draftKeysByUser.set(userId, set);
    }
    set.add(storageKey);
  }

  private forgetDraftKey(userId: string, storageKey: string): void {
    const set = this.draftKeysByUser.get(userId);
    if (!set) {return;}
    set.delete(storageKey);
    if (set.size === 0) {this.draftKeysByUser.delete(userId);}
  }

  getThreadReadAt(userId: string, rootMessageId: string): string | undefined {
    return this.threadReadAt.get(threadReadKey(userId, rootMessageId));
  }

  setThreadReadAt(userId: string, rootMessageId: string, at: string): void {
    const key = threadReadKey(userId, rootMessageId);
    const prev = this.threadReadAt.get(key);
    if (!prev || Date.parse(at) > Date.parse(prev)) {
      this.threadReadAt.set(key, at);
    }
  }

  registerAttachmentOwner(attachmentId: string, userId: string): void {
    this.attachmentOwners.set(attachmentId, userId);
  }

  getAttachmentOwner(attachmentId: string): string | undefined {
    return this.attachmentOwners.get(attachmentId);
  }

  /** Next monotonic sequence for a durable realtime resource stream. */
  nextResourceSequence(scope: "conversation" | "user", resourceId: string): number {
    const key = `${scope}:${resourceId}`;
    const next = (this.resourceSequences.get(key) ?? 0) + 1;
    this.resourceSequences.set(key, next);
    return next;
  }
}

export const conversationStore = new ConversationStore();
