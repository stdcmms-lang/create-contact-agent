import type { FastifyInstance } from "fastify";
import {
  ApiError,
  asBody,
  assertUsernameNotAdminPrefix,
  buildDeviceSessionsForUser,
  getRequestIp,
  getRequestUserAgent,
  nowIso,
  optLocale,
  optString,
  optStringAllowClear,
  paginate,
  parseCursorPagination,
  registerAuthedRoute,
  reqString,
  requirePushProvider,
  toMeProfile,
} from "../lib/auth-helpers.js";
import { store, type StoredUser } from "../lib/auth-store.js";
import {
  optQueryEnum,
  optQueryString,
  toPublicProfile,
} from "../lib/social-helpers.js";

const PRESENCE_VALUES = ["online", "away", "busy", "offline"] as const;

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  registerAuthedRoute(app, {
    method: "GET",
    url: "/me",
    handler: async ({ auth }) => {
      return toMeProfile(auth.user);
    },
  });

  registerAuthedRoute(app, {
    method: "PATCH",
    url: "/me",
    handler: async ({ auth, request }) => {
      if (request.body === undefined || request.body === null) {
        throw new ApiError(400, "invalid_request", "JSON body is required");
      }
      const body = asBody(request.body);
      const displayName = optString(body, "displayName", {
        trim: true,
        minLength: 1,
        maxLength: 64,
      });
      const username = optString(body, "username", {
        trim: true,
        minLength: 3,
        maxLength: 32,
        pattern: /^[a-zA-Z0-9_.-]{3,32}$/,
      });
      const avatarAttachmentId = optString(body, "avatarAttachmentId", {
        trim: true,
        maxLength: 128,
      });
      const statusMessage = optStringAllowClear(body, "statusMessage", {
        maxLength: 280,
      });

      if (username && username.toLowerCase() !== auth.user.usernameNormalized) {
        assertUsernameNotAdminPrefix(username);
        const existing = store.findUserByUsername(username);
        if (existing && existing.id !== auth.user.id) {
          throw new ApiError(
            409,
            "username_taken",
            "Username is already taken",
          );
        }
        auth.user.username = username;
        auth.user.usernameNormalized = username.toLowerCase();
      }
      if (displayName !== undefined) {auth.user.displayName = displayName;}
      if (avatarAttachmentId !== undefined) {
        if (!store.userHasProfileAttachment(auth.user.id, avatarAttachmentId)) {
          throw new ApiError(404, "not_found", "Attachment not found");
        }
        auth.user.avatarAttachmentId = avatarAttachmentId;
      }
      if (statusMessage === null) {
        delete auth.user.statusMessage;
      } else if (statusMessage !== undefined) {
        auth.user.statusMessage = statusMessage;
      }
      auth.user.updatedAt = nowIso();
      return toMeProfile(auth.user);
    },
  });

  registerAuthedRoute(app, {
    method: "GET",
    url: "/me/devices",
    handler: async ({ auth, request }) => {
      const params = parseCursorPagination(
        request.query,
        {
          defaultLimit: 25,
          maxLimit: 100,
        },
        { principalId: auth.user.id },
      );
      const rows = buildDeviceSessionsForUser(auth.user.id, auth.session.id);
      return paginate(rows, params, { principalId: auth.user.id });
    },
  });

  registerAuthedRoute(app, {
    method: "DELETE",
    url: "/me/devices/:deviceId",
    handler: async ({ auth, request, reply }) => {
      const { deviceId } = request.params as { deviceId: string };
      if (!deviceId) {
        throw new ApiError(400, "invalid_request", "Missing device id");
      }
      let removed = false;
      const device = store.getDevice(auth.user.id, deviceId);
      if (device) {
        store.removeSessionsForDevice(auth.user.id, deviceId);
        store.removeDevice(auth.user.id, deviceId);
        removed = true;
      } else {
        const session = store.sessions.get(deviceId);
        if (session && session.userId === auth.user.id) {
          store.removeSession(session.id);
          removed = true;
        }
      }
      if (!removed) {
        throw new ApiError(404, "not_found", "Device or session not found");
      }
      return reply.code(204).send();
    },
  });

  registerAuthedRoute(app, {
    method: "PUT",
    url: "/me/devices/:deviceId/push-token",
    handler: async ({ auth, request }) => {
      const { deviceId } = request.params as { deviceId: string };
      if (!deviceId) {
        throw new ApiError(400, "invalid_request", "Missing device id");
      }
      const body = asBody(request.body);
      const provider = requirePushProvider(body);
      const token = reqString(body, "token", { maxLength: 1024 });
      const appVersion = optString(body, "appVersion", { maxLength: 64 });
      const locale = optLocale(body, "locale", 32);
      const now = nowIso();
      const device = store.upsertDevice(auth.user.id, deviceId, {
        userAgent: getRequestUserAgent(request),
        ipAddress: getRequestIp(request),
        now,
      });
      device.pushToken = {
        provider,
        token,
        appVersion,
        locale,
        updatedAt: now,
      };
      return {
        deviceId: device.id,
        pushToken: { ...device.pushToken },
      };
    },
  });

  registerAuthedRoute(app, {
    method: "DELETE",
    url: "/me/devices/:deviceId/push-token",
    handler: async ({ auth, request, reply }) => {
      const { deviceId } = request.params as { deviceId: string };
      const device = store.getDevice(auth.user.id, deviceId);
      if (!device) {
        throw new ApiError(404, "not_found", "Device not found");
      }
      delete device.pushToken;
      return reply.code(204).send();
    },
  });

  registerAuthedRoute(app, {
    method: "GET",
    url: "/me/blocked-users",
    handler: async ({ auth, request }) => {
      const params = parseCursorPagination(
        request.query,
        {
          defaultLimit: 25,
          maxLimit: 100,
        },
        { principalId: auth.user.id },
      );
      const items = store.blocks.get(auth.user.id) ?? [];
      return paginate(items, params, { principalId: auth.user.id });
    },
  });

  registerAuthedRoute(app, {
    method: "POST",
    url: "/me/blocked-users",
    handler: async ({ auth, request }) => {
      const body = asBody(request.body);
      const userId = reqString(body, "userId", {
        trim: true,
        maxLength: 128,
      });
      const reason = optString(body, "reason", { maxLength: 280 });
      if (userId === auth.user.id) {
        throw new ApiError(400, "invalid_request", "Cannot block yourself");
      }
      if (!store.users.has(userId)) {
        throw new ApiError(404, "not_found", "User not found");
      }
      const existing = store.blocks.get(auth.user.id) ?? [];
      const without = existing.filter((b) => b.userId !== userId);
      const entry = { userId, reason, blockedAt: nowIso() };
      store.blocks.set(auth.user.id, [entry, ...without]);
      return entry;
    },
  });

  registerAuthedRoute(app, {
    method: "DELETE",
    url: "/me/blocked-users/:userId",
    handler: async ({ auth, request, reply }) => {
      const { userId } = request.params as { userId: string };
      const list = store.blocks.get(auth.user.id) ?? [];
      const next = list.filter((b) => b.userId !== userId);
      if (next.length === list.length) {
        throw new ApiError(404, "not_found", "User is not blocked");
      }
      store.blocks.set(auth.user.id, next);
      return reply.code(204).send();
    },
  });

  registerAuthedRoute(app, {
    method: "GET",
    url: "/users/:userId",
    handler: async ({ request }) => {
      const { userId } = request.params as { userId: string };
      if (!userId) {
        throw new ApiError(400, "invalid_request", "Missing user id");
      }
      const target = store.users.get(userId);
      if (!target) {
        throw new ApiError(404, "not_found", "User not found");
      }
      return toPublicProfile(target);
    },
  });

  registerAuthedRoute(app, {
    method: "GET",
    url: "/users",
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
        { defaultLimit: 20, maxLimit: 50 },
        { principalId: auth.user.id },
      );

      const matches = matchUsers(auth.user.id, query, presence);
      return paginate(matches.map(toPublicProfile), params, {
        principalId: auth.user.id,
      });
    },
  });
}

function matchUsers(
  selfId: string,
  query: string | undefined,
  presence: (typeof PRESENCE_VALUES)[number] | undefined,
): StoredUser[] {
  const needle = query?.toLowerCase();
  const out: StoredUser[] = [];
  for (const user of store.users.values()) {
    if (user.id === selfId) {continue;}
    if (needle) {
      const username = user.username.toLowerCase();
      const display = user.displayName?.toLowerCase() ?? "";
      if (!username.includes(needle) && !display.includes(needle)) {continue;}
    }
    if (presence && presence !== "offline") {continue;}
    out.push(user);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  return out;
}
