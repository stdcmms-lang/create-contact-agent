import { ApiError } from "./auth-helpers.js";
import type { StoredUser } from "./auth-store.js";
import type { StoredContact, StoredInvite } from "./social-store.js";

export type PublicUserProfile = {
  id: string;
  username: string;
  displayName: string | null;
  presence: "online" | "away" | "busy" | "offline";
  statusMessage: string | null;
  avatarAttachmentId: string | null;
};

export type ContactResponse = {
  userId: string;
  alias: string | null;
  user: PublicUserProfile;
  createdAt: string;
};

export type InviteResponse = {
  id: string;
  code: string;
  status: "pending" | "accepted" | "declined" | "expired";
  fromUserId: string;
  toUserId: string | null;
  email: string | null;
  conversationId: string | null;
  message: string | null;
  createdAt: string;
  respondedAt: string | null;
};

export function toPublicProfile(user: StoredUser): PublicUserProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    presence: "offline",
    statusMessage: user.statusMessage ?? null,
    avatarAttachmentId: user.avatarAttachmentId ?? null,
  };
}

export function toContactResponse(
  contact: StoredContact,
  user: StoredUser,
): ContactResponse {
  return {
    userId: contact.userId,
    alias: contact.alias,
    user: toPublicProfile(user),
    createdAt: contact.createdAt,
  };
}

export function toInviteResponse(invite: StoredInvite): InviteResponse {
  return {
    id: invite.id,
    code: invite.code,
    status: invite.status,
    fromUserId: invite.fromUserId,
    toUserId: invite.toUserId,
    email: invite.email,
    conversationId: invite.conversationId,
    message: invite.message,
    createdAt: invite.createdAt,
    respondedAt: invite.respondedAt,
  };
}

function asQueryObject(query: unknown): Record<string, unknown> {
  if (query !== null && typeof query === "object" && !Array.isArray(query)) {
    return query as Record<string, unknown>;
  }
  return {};
}

/**
 * Returns the trimmed string value of an optional query parameter.
 * - Missing key  → undefined
 * - Empty string → 400 (per user-interface.md: present-but-empty optional → 400)
 * - Non-string   → 400
 * - Out of range → 400
 */
export function optQueryString(
  query: unknown,
  key: string,
  opts: { minLength: number; maxLength: number },
): string | undefined {
  const q = asQueryObject(query);
  if (!(key in q)) {return undefined;}
  const v = q[key];
  if (typeof v !== "string") {
    throw new ApiError(400, "invalid_request", `'${key}' must be a string`);
  }
  if (v.length === 0) {
    throw new ApiError(400, "invalid_request", `'${key}' must not be empty`);
  }
  if (v.length < opts.minLength) {
    throw new ApiError(400, "invalid_request", `'${key}' is too short`);
  }
  if (v.length > opts.maxLength) {
    throw new ApiError(400, "invalid_request", `'${key}' is too long`);
  }
  return v;
}

/**
 * Returns the value of an optional enum query parameter.
 * - Missing key                → undefined
 * - Empty / wrong type / unknown value → 400
 */
export function optQueryEnum<T extends string>(
  query: unknown,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const q = asQueryObject(query);
  if (!(key in q)) {return undefined;}
  const v = q[key];
  if (typeof v !== "string") {
    throw new ApiError(400, "invalid_request", `'${key}' must be a string`);
  }
  if (v.length === 0) {
    throw new ApiError(400, "invalid_request", `'${key}' must not be empty`);
  }
  if (!allowed.includes(v as T)) {
    throw new ApiError(
      400,
      "invalid_request",
      `'${key}' must be one of: ${allowed.join(", ")}`,
    );
  }
  return v as T;
}

/**
 * Like {@link optQueryString} but mandatory. Used for `GET /invites/lookup?code=`.
 */
export function reqQueryString(
  query: unknown,
  key: string,
  opts: { minLength: number; maxLength: number },
): string {
  const q = asQueryObject(query);
  if (!(key in q)) {
    throw new ApiError(400, "invalid_request", `Missing '${key}'`);
  }
  const v = q[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ApiError(400, "invalid_request", `Missing or invalid '${key}'`);
  }
  if (v.length < opts.minLength) {
    throw new ApiError(400, "invalid_request", `'${key}' is too short`);
  }
  if (v.length > opts.maxLength) {
    throw new ApiError(400, "invalid_request", `'${key}' is too long`);
  }
  return v;
}
