import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ApiError,
  asBody,
  nowIso,
  optString,
  paginate,
  parseCursorPagination,
  registerAuthedRoute,
} from "../lib/auth-helpers.js";
import { randomId, randomToken, store } from "../lib/auth-store.js";
import { conversationStore } from "../lib/conversation-store.js";
import {
  optQueryEnum,
  optQueryString,
  reqQueryString,
  toContactResponse,
  toInviteResponse,
} from "../lib/social-helpers.js";
import {
  type InviteStatus,
  type StoredContact,
  type StoredInvite,
  socialStore,
} from "../lib/social-store.js";

const PRESENCE_VALUES = ["online", "away", "busy", "offline"] as const;
const INVITE_STATUS_VALUES: readonly InviteStatus[] = [
  "pending",
  "accepted",
  "declined",
  "expired",
];
const INVITE_DIRECTION_VALUES = ["sent", "received"] as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerContactsInvitesRoutes(
  app: FastifyInstance,
): Promise<void> {
  // ----- Contacts -----

  registerAuthedRoute(app, {
    method: "GET",
    url: "/contacts",
    handler: async ({ auth, request }) => {
      const query = optQueryString(request.query, "query", {
        minLength: 1,
        maxLength: 100,
      });
      const presence = optQueryEnum(
        request.query,
        "presence",
        PRESENCE_VALUES,
      );
      const params = parseCursorPagination(
        request.query,
        { defaultLimit: 50, maxLimit: 100 },
        { principalId: auth.user.id },
      );

      const rows = socialStore
        .listContacts(auth.user.id)
        .slice()
        .sort((a, b) =>
          a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
        );

      const needle = query?.toLowerCase();
      const out = [];
      for (const contact of rows) {
        const contactUser = store.users.get(contact.userId);
        if (!contactUser) {continue;}
        if (presence && presence !== "offline") {continue;}
        if (needle) {
          const alias = contact.alias?.toLowerCase() ?? "";
          const username = contactUser.username.toLowerCase();
          const display = contactUser.displayName?.toLowerCase() ?? "";
          if (
            !alias.includes(needle) &&
            !username.includes(needle) &&
            !display.includes(needle)
          ) {
            continue;
          }
        }
        out.push(toContactResponse(contact, contactUser));
      }
      return paginate(out, params, { principalId: auth.user.id });
    },
  });

  registerAuthedRoute(app, {
    method: "POST",
    url: "/contacts",
    handler: async ({ auth, request }) => {
      if (request.body === undefined || request.body === null) {
        throw new ApiError(400, "invalid_request", "JSON body is required");
      }
      const body = asBody(request.body);
      const userId = reqStringField(body, "userId", { maxLength: 128 });
      const alias = optString(body, "alias", {
        trim: true,
        minLength: 1,
        maxLength: 50,
      });

      if (userId === auth.user.id) {
        throw new ApiError(400, "invalid_request", "Cannot add yourself");
      }
      const target = store.users.get(userId);
      if (!target) {
        throw new ApiError(404, "not_found", "User not found");
      }

      const candidate: StoredContact = {
        ownerId: auth.user.id,
        userId,
        alias: alias ?? null,
        createdAt: nowIso(),
      };
      const { contact } = socialStore.addContactIfAbsent(candidate);
      return toContactResponse(contact, target);
    },
  });

  registerAuthedRoute(app, {
    method: "DELETE",
    url: "/contacts/:userId",
    handler: async ({ auth, request, reply }) => {
      const { userId } = request.params as { userId: string };
      if (!userId) {
        throw new ApiError(400, "invalid_request", "Missing user id");
      }
      const removed = socialStore.removeContact(auth.user.id, userId);
      if (!removed) {
        throw new ApiError(404, "not_found", "Contact not found");
      }
      return reply.code(204).send();
    },
  });

  // ----- Invite lookup (must precede /invites/:inviteId/* to avoid shadowing) -----

  registerAuthedRoute(app, {
    method: "GET",
    url: "/invites/lookup",
    handler: async ({ auth, request }) => {
      const code = reqQueryString(request.query, "code", {
        minLength: 1,
        maxLength: 512,
      });
      const invite = socialStore.getInviteByCode(code);
      if (!invite) {
        throw new ApiError(404, "not_found", "Invite not found");
      }
      if (!canLookupInvite(invite, auth.user.id, auth.user.emailNormalized)) {
        // Same 404 as unknown code so callers cannot infer code validity.
        throw new ApiError(404, "not_found", "Invite not found");
      }
      return toInviteResponse(invite);
    },
  });

  // ----- Invites -----

  registerAuthedRoute(app, {
    method: "POST",
    url: "/invites",
    handler: async ({ auth, request }) => {
      if (request.body === undefined || request.body === null) {
        throw new ApiError(400, "invalid_request", "JSON body is required");
      }
      const body = asBody(request.body);

      const hasTarget = "targetUserId" in body && body.targetUserId !== undefined;
      const hasEmail = "email" in body && body.email !== undefined;
      if (hasTarget === hasEmail) {
        throw new ApiError(
          400,
          "invalid_request",
          "Provide exactly one of 'targetUserId' or 'email'",
        );
      }

      let targetUserId: string | null = null;
      let email: string | null = null;
      let emailNormalized: string | null = null;

      if (hasTarget) {
        const v = body.targetUserId;
        if (typeof v !== "string" || v.length === 0) {
          throw new ApiError(
            400,
            "invalid_request",
            "Missing or invalid 'targetUserId'",
          );
        }
        if (v.length > 128) {
          throw new ApiError(400, "invalid_request", "'targetUserId' is too long");
        }
        if (v === auth.user.id) {
          throw new ApiError(
            400,
            "invalid_request",
            "Cannot invite yourself",
          );
        }
        if (!store.users.has(v)) {
          throw new ApiError(404, "not_found", "Target user not found");
        }
        targetUserId = v;
      } else {
        const v = body.email;
        if (typeof v !== "string" || v.length === 0) {
          throw new ApiError(
            400,
            "invalid_request",
            "Missing or invalid 'email'",
          );
        }
        const trimmed = v.trim();
        if (
          trimmed.length === 0 ||
          trimmed.length > 254 ||
          !EMAIL_PATTERN.test(trimmed)
        ) {
          throw new ApiError(400, "invalid_request", "'email' is invalid");
        }
        email = trimmed;
        emailNormalized = trimmed.toLowerCase();
      }

      const conversationIdRaw = optString(body, "conversationId", {
        trim: true,
        maxLength: 128,
      });
      let conversationId: string | null = null;
      if (conversationIdRaw !== undefined) {
        assertConversationExistsForInvite(conversationIdRaw, auth.user.id);
        conversationId = conversationIdRaw;
      }

      // `message`: 0–500 chars; whitespace-only becomes null.
      let message: string | null = null;
      if (body.message !== undefined && body.message !== null) {
        if (typeof body.message !== "string") {
          throw new ApiError(
            400,
            "invalid_request",
            "'message' must be a string",
          );
        }
        if (body.message.length > 500) {
          throw new ApiError(400, "invalid_request", "'message' is too long");
        }
        const trimmed = body.message.trim();
        message = trimmed.length === 0 ? null : trimmed;
      }

      const invite: StoredInvite = {
        id: randomId("inv"),
        code: randomToken(16),
        status: "pending",
        fromUserId: auth.user.id,
        toUserId: targetUserId,
        email,
        emailNormalized,
        conversationId,
        message,
        createdAt: nowIso(),
        respondedAt: null,
      };
      socialStore.addInvite(invite);
      return toInviteResponse(invite);
    },
  });

  registerAuthedRoute(app, {
    method: "GET",
    url: "/invites",
    handler: async ({ auth, request }) => {
      const direction = optQueryEnum(
        request.query,
        "direction",
        INVITE_DIRECTION_VALUES,
      );
      const status = optQueryEnum(
        request.query,
        "status",
        INVITE_STATUS_VALUES,
      );
      const params = parseCursorPagination(
        request.query,
        { defaultLimit: 50, maxLimit: 100 },
        { principalId: auth.user.id },
      );

      const emailNorm = auth.user.emailNormalized;
      const all = socialStore.listInvitesInvolving(auth.user.id, emailNorm);
      const filtered = all.filter((inv) => {
        if (status && inv.status !== status) {return false;}
        if (direction === "sent" && inv.fromUserId !== auth.user.id) {return false;}
        if (direction === "received") {
          const isRecipient =
            inv.toUserId === auth.user.id ||
            (inv.emailNormalized !== null &&
              inv.emailNormalized === emailNorm);
          if (!isRecipient) {return false;}
        }
        return true;
      });
      filtered.sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
      return paginate(filtered.map(toInviteResponse), params, {
        principalId: auth.user.id,
      });
    },
  });

  registerAuthedRoute(app, {
    method: "POST",
    url: "/invites/:inviteId/accept",
    handler: async ({ auth, request }) => {
      requireApplicationJsonContentTypeWhenBodyPresent(request);
      const invite = loadInviteForResponse(request);
      assertCanRespond(invite, auth.user.id, auth.user.emailNormalized);
      invite.status = "accepted";
      invite.respondedAt = nowIso();

      // User-to-user invites create bidirectional contacts (alias unset).
      if (invite.fromUserId && invite.toUserId) {
        const now = invite.respondedAt;
        socialStore.addContactIfAbsent({
          ownerId: invite.fromUserId,
          userId: invite.toUserId,
          alias: null,
          createdAt: now,
        });
        socialStore.addContactIfAbsent({
          ownerId: invite.toUserId,
          userId: invite.fromUserId,
          alias: null,
          createdAt: now,
        });
      } else if (invite.email && !invite.toUserId) {
        // Claim email invite for the authenticated user, then add contacts.
        invite.toUserId = auth.user.id;
        socialStore.addContactIfAbsent({
          ownerId: invite.fromUserId,
          userId: auth.user.id,
          alias: null,
          createdAt: invite.respondedAt,
        });
        socialStore.addContactIfAbsent({
          ownerId: auth.user.id,
          userId: invite.fromUserId,
          alias: null,
          createdAt: invite.respondedAt,
        });
      }

      if (invite.conversationId) {
        const recipientId = invite.toUserId ?? auth.user.id;
        addInviteRecipientToConversation(invite.conversationId, recipientId);
      }

      return toInviteResponse(invite);
    },
  });

  registerAuthedRoute(app, {
    method: "POST",
    url: "/invites/:inviteId/decline",
    handler: async ({ auth, request }) => {
      requireApplicationJsonContentTypeWhenBodyPresent(request);
      const invite = loadInviteForResponse(request);
      assertCanRespond(invite, auth.user.id, auth.user.emailNormalized);

      if (request.body !== undefined && request.body !== null) {
        const body = asBody(request.body);
        if (body.reason !== undefined && body.reason !== null) {
          if (typeof body.reason !== "string") {
            throw new ApiError(
              400,
              "invalid_request",
              "'reason' must be a string",
            );
          }
          if (body.reason.length > 500) {
            throw new ApiError(
              400,
              "invalid_request",
              "'reason' is too long",
            );
          }
        }
      }

      invite.status = "declined";
      invite.respondedAt = nowIso();
      return toInviteResponse(invite);
    },
  });
}

/**
 * When a request declares a non-zero Content-Length, require JSON so clients
 * cannot accidentally hit accept/decline with the wrong parser (see user-interface.md).
 */
function requireApplicationJsonContentTypeWhenBodyPresent(
  request: FastifyRequest,
): void {
  const rawCl = request.headers["content-length"];
  const cl =
    typeof rawCl === "string" && rawCl.length > 0 ? Number(rawCl) : NaN;
  if (!Number.isFinite(cl) || cl <= 0) {return;}

  const rawCt = request.headers["content-type"];
  const ct =
    typeof rawCt === "string"
      ? rawCt.split(";")[0]?.trim().toLowerCase()
      : undefined;
  if (ct !== "application/json") {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
    );
  }
}

function canLookupInvite(
  invite: StoredInvite,
  userId: string,
  emailNormalized: string,
): boolean {
  if (invite.fromUserId === userId) {return true;}
  if (invite.toUserId === userId) {return true;}
  return (
    invite.toUserId === null &&
    invite.emailNormalized !== null &&
    invite.emailNormalized === emailNormalized
  );
}

function loadInviteForResponse(
  request: { params: unknown },
): StoredInvite {
  const params = request.params as { inviteId?: string };
  const inviteId = params.inviteId;
  if (!inviteId) {
    throw new ApiError(400, "invalid_request", "Missing invite id");
  }
  const invite = socialStore.getInvite(inviteId);
  if (!invite) {
    throw new ApiError(404, "not_found", "Invite not found");
  }
  return invite;
}

function assertCanRespond(
  invite: StoredInvite,
  userId: string,
  emailNormalized: string,
): void {
  const isRecipient =
    invite.toUserId === userId ||
    (invite.toUserId === null &&
      invite.emailNormalized !== null &&
      invite.emailNormalized === emailNormalized);
  if (!isRecipient) {
    throw new ApiError(
      403,
      "forbidden",
      "Only the recipient can respond to this invite",
    );
  }
  if (invite.status !== "pending") {
    throw new ApiError(409, "conflict", "Invite is already resolved");
  }
}

function assertConversationExistsForInvite(
  conversationId: string,
  senderId: string,
): void {
  const conversation = conversationStore.getConversation(conversationId);
  if (!conversation || !conversationStore.getMember(conversationId, senderId)) {
    throw new ApiError(404, "not_found", "Conversation not found");
  }
}

function addInviteRecipientToConversation(
  conversationId: string,
  recipientId: string,
): void {
  const conversation = conversationStore.getConversation(conversationId);
  if (!conversation) {
    throw new ApiError(404, "not_found", "Conversation not found");
  }
  if (conversationStore.getMember(conversationId, recipientId)) {return;}
  conversationStore.addMember({
    conversationId,
    userId: recipientId,
    role: "member",
    joinedAt: nowIso(),
  });
}

function reqStringField(
  body: Record<string, unknown>,
  field: string,
  opts: { maxLength: number },
): string {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new ApiError(400, "invalid_request", `Missing or invalid '${field}'`);
  }
  if (v.length > opts.maxLength) {
    throw new ApiError(400, "invalid_request", `'${field}' is too long`);
  }
  return v;
}
