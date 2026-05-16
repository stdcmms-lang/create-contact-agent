/**
 * Minimal `/conversations` routes so invite flows using `conversationId` share
 * the same in-memory {@link conversationStore} as messaging-server.
 */
import type { FastifyInstance } from "fastify";
import {
  ApiError,
  asBody,
  nowIso,
  optString,
  registerAuthedRoute,
  reqEnum,
  type Body,
} from "../lib/auth-helpers.js";
import { randomId, store } from "../lib/auth-store.js";
import { requireVisibleConversation } from "../lib/conversation-access.js";
import {
  conversationStore,
  type ConversationPrivacy,
  type StoredConversation,
  type StoredConversationState,
} from "../lib/conversation-store.js";
import type { Conversation, ConversationType } from "../types/models.js";

const CONVERSATION_TYPES: readonly ConversationType[] = [
  "direct",
  "group",
  "channel",
];
const PRIVACY_VALUES: readonly ConversationPrivacy[] = ["public", "private"];

function hasField(body: Body, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function reqBodyStringArray(body: Body, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", `'${field}' must be an array`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw new ApiError(
        400,
        "invalid_request",
        `'${field}' must contain string ids`,
      );
    }
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function optBodyEnum<T extends string>(
  body: Body,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = body[field];
  if (value === undefined || value === null) {return undefined;}
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(
      400,
      "invalid_request",
      `'${field}' must be one of: ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

function creationFingerprint(input: {
  type: ConversationType;
  memberIds: string[];
  title: string | null;
  privacy: ConversationPrivacy;
}): string {
  return JSON.stringify({
    type: input.type,
    memberIds: [...input.memberIds].sort(),
    title: input.title,
    privacy: input.privacy,
  });
}

function ensureUsersExist(userIds: string[]): void {
  for (const userId of userIds) {
    if (!store.users.has(userId)) {
      throw new ApiError(404, "not_found", "User not found");
    }
  }
}

function addInitialMembers(
  conversationId: string,
  creatorId: string,
  peerIds: string[],
  now: string,
): void {
  conversationStore.addMember({
    conversationId,
    userId: creatorId,
    role: "owner",
    joinedAt: now,
  });
  for (const userId of peerIds) {
    conversationStore.addMember({
      conversationId,
      userId,
      role: "member",
      joinedAt: now,
    });
  }
}

function activeState(
  conversationId: string,
  userId: string,
): StoredConversationState | undefined {
  const member = conversationStore.getMember(conversationId, userId);
  if (!member) {return undefined;}
  const state = conversationStore.ensureState(conversationId, userId);
  if (
    state.muted &&
    state.mutedUntil !== null &&
    Date.parse(state.mutedUntil) <= Date.now()
  ) {
    state.muted = false;
    state.mutedUntil = null;
  }
  return state;
}

function conversationUnreadCount(
  conversationId: string,
  userId: string,
  state: StoredConversationState | undefined,
): number {
  const readAt = state?.readAt ? Date.parse(state.readAt) : -Infinity;
  return conversationStore
    .listMessages(conversationId)
    .filter(
      (message) =>
        message.senderId !== userId && Date.parse(message.createdAt) > readAt,
    ).length;
}

function conversationMentionCount(
  conversationId: string,
  userId: string,
  state: StoredConversationState | undefined,
): number {
  const readAt = state?.readAt ? Date.parse(state.readAt) : -Infinity;
  return conversationStore
    .listMessages(conversationId)
    .filter(
      (message) =>
        message.senderId !== userId &&
        message.mentions.includes(userId) &&
        Date.parse(message.createdAt) > readAt,
    ).length;
}

function toConversation(
  conversation: StoredConversation,
  userId: string,
): Conversation {
  const state = activeState(conversation.id, userId);
  const members = conversationStore.listMembers(conversation.id);
  const callerIsMember = members.some((member) => member.userId === userId);
  let memberIds = members.slice(0, 50).map((member) => member.userId);
  if (callerIsMember && !memberIds.includes(userId)) {
    memberIds = memberIds.slice(0, 49);
    memberIds.push(userId);
  }
  return {
    id: conversation.id,
    type: conversation.type,
    title: conversation.type === "direct" ? null : conversation.title,
    topic: conversation.topic,
    privacy: conversation.type === "channel" ? conversation.privacy : "private",
    avatarAttachmentId: conversation.avatarAttachmentId,
    memberIds,
    memberPreviewTruncated: members.length > memberIds.length,
    unreadCount: callerIsMember
      ? conversationUnreadCount(conversation.id, userId, state)
      : 0,
    mentionCount: callerIsMember
      ? conversationMentionCount(conversation.id, userId, state)
      : 0,
    muted: state?.muted ?? false,
    mutedUntil: state?.mutedUntil ?? null,
    archived: state?.archived ?? false,
    pinned: state?.pinned ?? false,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export async function registerMinimalConversationRoutes(
  app: FastifyInstance,
): Promise<void> {
  registerAuthedRoute(app, {
    method: "POST",
    url: "/conversations",
    handler: async ({ auth, request, reply }) => {
      if (request.body === undefined || request.body === null) {
        throw new ApiError(400, "invalid_request", "JSON body is required");
      }
      const body = asBody(request.body);
      const type = reqEnum(body, "type", CONVERSATION_TYPES);
      const memberIds = reqBodyStringArray(body, "memberIds");
      if (memberIds.includes(auth.user.id)) {
        throw new ApiError(
          400,
          "invalid_request",
          "'memberIds' must not include caller",
        );
      }
      ensureUsersExist(memberIds);

      const title = optString(body, "title", {
        trim: true,
        minLength: 1,
        maxLength: 200,
      });
      const privacy = optBodyEnum(body, "privacy", PRIVACY_VALUES);
      const clientId = optString(body, "clientId", {
        trim: true,
        minLength: 1,
        maxLength: 128,
      });

      if (type === "direct") {
        if (memberIds.length !== 1) {
          throw new ApiError(
            400,
            "invalid_request",
            "Direct conversations require exactly one peer",
          );
        }
        if (hasField(body, "title") || hasField(body, "clientId")) {
          throw new ApiError(
            400,
            "invalid_request",
            "Direct conversations reject title and clientId",
          );
        }
        if (privacy === "public") {
          throw new ApiError(
            400,
            "invalid_request",
            "Direct conversations must be private",
          );
        }
        const existing = conversationStore.findDirectConversation(
          auth.user.id,
          memberIds[0] ?? "",
        );
        if (existing) {
          return reply.code(200).send(toConversation(existing, auth.user.id));
        }
      } else if (type === "group") {
        if (memberIds.length < 1) {
          throw new ApiError(
            400,
            "invalid_request",
            "Group conversations require at least one peer",
          );
        }
        if (privacy === "public") {
          throw new ApiError(400, "invalid_request", "Groups must be private");
        }
      }

      const resolvedPrivacy: ConversationPrivacy =
        type === "channel" ? (privacy ?? "private") : "private";
      const resolvedTitle = type === "direct" ? null : (title ?? null);

      if (clientId && type !== "direct") {
        const fingerprint = creationFingerprint({
          type,
          memberIds,
          title: resolvedTitle,
          privacy: resolvedPrivacy,
        });
        const existingRecord = conversationStore.getClientIdRecord(
          auth.user.id,
          clientId,
        );
        if (existingRecord) {
          if (existingRecord.fingerprint !== fingerprint) {
            throw new ApiError(
              409,
              "conflict",
              "clientId was already used with different payload",
            );
          }
          const existing = conversationStore.getConversation(
            existingRecord.conversationId,
          );
          if (existing) {
            return reply.code(200).send(toConversation(existing, auth.user.id));
          }
        }
      }

      const now = nowIso();
      const conversation: StoredConversation = {
        id: randomId("conv"),
        type,
        title: resolvedTitle,
        topic: null,
        privacy: resolvedPrivacy,
        avatarAttachmentId: null,
        createdByUserId: auth.user.id,
        createdAt: now,
        updatedAt: now,
      };
      conversationStore.addConversation(conversation);
      addInitialMembers(conversation.id, auth.user.id, memberIds, now);
      if (clientId && type !== "direct") {
        conversationStore.setClientIdRecord({
          userId: auth.user.id,
          clientId,
          fingerprint: creationFingerprint({
            type,
            memberIds,
            title: resolvedTitle,
            privacy: resolvedPrivacy,
          }),
          conversationId: conversation.id,
        });
      }
      return reply.code(201).send(toConversation(conversation, auth.user.id));
    },
  });

  registerAuthedRoute(app, {
    method: "GET",
    url: "/conversations/:conversationId",
    handler: async ({ auth, request }) => {
      const { conversationId } = request.params as { conversationId: string };
      const conversation = requireVisibleConversation(
        conversationId,
        auth.user.id,
      );
      return toConversation(conversation, auth.user.id);
    },
  });
}
