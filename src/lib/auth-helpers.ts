import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";
import type {
  AccountState,
  AuthSuccess,
  AuthTokens,
  CursorPage,
  DeviceSession,
  MeProfile,
  MfaMethod,
  PushProvider,
} from "../types/models.js";
import {
  hashPassword,
  randomId,
  randomToken,
  store,
  type StoredDevice,
  type StoredSession,
  type StoredUser,
} from "./auth-store.js";
import { logRequest } from "./request-log.js";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR;

function readPositiveIntEnv(
  name: string,
  defaultSeconds: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {return defaultSeconds;}
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid ${name}: expected non-negative integer seconds, got ${JSON.stringify(raw)}`,
    );
  }
  const n = Number.parseInt(trimmed, 10);
  if (n < min || n > max) {
    throw new Error(`Invalid ${name}: value ${n} out of allowed range [${min}, ${max}]`);
  }
  return n;
}

export const ACCESS_TOKEN_TTL_SECONDS = readPositiveIntEnv(
  "ACCESS_TOKEN_TTL_SECONDS",
  SECONDS_PER_HOUR,
  1,
  7 * SECONDS_PER_DAY,
);
export const REFRESH_TOKEN_TTL_SECONDS = readPositiveIntEnv(
  "REFRESH_TOKEN_TTL_SECONDS",
  30 * SECONDS_PER_DAY,
  60,
  400 * SECONDS_PER_DAY,
);
if (REFRESH_TOKEN_TTL_SECONDS < ACCESS_TOKEN_TTL_SECONDS) {
  throw new Error(
    `REFRESH_TOKEN_TTL_SECONDS (${REFRESH_TOKEN_TTL_SECONDS}) must be >= ACCESS_TOKEN_TTL_SECONDS (${ACCESS_TOKEN_TTL_SECONDS})`,
  );
}
export const EMAIL_VERIFY_TTL_SECONDS = readPositiveIntEnv(
  "EMAIL_VERIFY_TTL_SECONDS",
  SECONDS_PER_DAY,
  5 * SECONDS_PER_MINUTE,
  30 * SECONDS_PER_DAY,
);
export const PASSWORD_RESET_TTL_SECONDS = readPositiveIntEnv(
  "PASSWORD_RESET_TTL_SECONDS",
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
  7 * SECONDS_PER_DAY,
);
export const MFA_ENROLLMENT_TTL_SECONDS = readPositiveIntEnv(
  "MFA_ENROLLMENT_TTL_SECONDS",
  10 * SECONDS_PER_MINUTE,
  SECONDS_PER_MINUTE,
  SECONDS_PER_HOUR,
);
export const MFA_TICKET_TTL_SECONDS = readPositiveIntEnv(
  "MFA_TICKET_TTL_SECONDS",
  5 * SECONDS_PER_MINUTE,
  30,
  SECONDS_PER_HOUR,
);
/** Minimum length for passwords on register, login, and password reset. */
export const PASSWORD_MIN_LENGTH = 8;

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Body = Record<string, unknown>;

export function asBody(raw: unknown): Body {
  if (raw === null || raw === undefined) {return {};}
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Body;
  }
  throw new ApiError(400, "invalid_body", "Request body must be a JSON object");
}

type StringOpts = {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  trim?: boolean;
};

function validateString(value: string, field: string, opts?: StringOpts): string {
  let v = value;
  if (opts?.trim) {v = v.trim();}
  if (opts?.minLength != null && v.length < opts.minLength) {
    throw new ApiError(400, "invalid_request", `'${field}' is too short`);
  }
  if (opts?.maxLength != null && v.length > opts.maxLength) {
    throw new ApiError(400, "invalid_request", `'${field}' is too long`);
  }
  if (opts?.pattern && !opts.pattern.test(v)) {
    throw new ApiError(400, "invalid_request", `'${field}' has invalid format`);
  }
  return v;
}

export function reqString(body: Body, field: string, opts?: StringOpts): string {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new ApiError(400, "invalid_request", `Missing or invalid '${field}'`);
  }
  return validateString(v, field, opts);
}

export function optString(
  body: Body,
  field: string,
  opts?: StringOpts,
): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) {return undefined;}
  if (typeof v !== "string") {
    throw new ApiError(400, "invalid_request", `'${field}' must be a string`);
  }
  if (v.length === 0) {return undefined;}
  return validateString(v, field, opts);
}

/** Optional BCP 47 locale tag for push metadata (rejects malformed tags). */
export function optLocale(body: Body, field: string, maxLength = 32): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) {return undefined;}
  if (typeof v !== "string") {
    throw new ApiError(400, "invalid_request", `'${field}' must be a string`);
  }
  if (v.length === 0) {return undefined;}
  if (v.length > maxLength) {
    throw new ApiError(400, "invalid_request", `'${field}' is too long`);
  }
  try {
    new Intl.Locale(v);
  } catch {
    throw new ApiError(400, "invalid_request", `'${field}' is not a valid locale tag`);
  }
  return v;
}

/** Like optString, but null or "" mean explicit clear (returns null); absent key returns undefined. */
export function optStringAllowClear(
  body: Body,
  field: string,
  opts?: StringOpts,
): string | undefined | null {
  const v = body[field];
  if (v === undefined) {return undefined;}
  if (v === null || v === "") {return null;}
  if (typeof v !== "string") {
    throw new ApiError(400, "invalid_request", `'${field}' must be a string`);
  }
  return validateString(v, field, opts);
}

export function reqEnum<T extends string>(
  body: Body,
  field: string,
  allowed: readonly T[],
): T {
  const v = body[field];
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new ApiError(
      400,
      "invalid_request",
      `'${field}' must be one of: ${allowed.join(", ")}`,
    );
  }
  return v as T;
}

export function optBool(body: Body, field: string): boolean | undefined {
  const v = body[field];
  if (v === undefined || v === null) {return undefined;}
  if (typeof v !== "boolean") {
    throw new ApiError(400, "invalid_request", `'${field}' must be a boolean`);
  }
  return v;
}

export function requireEmail(body: Body, field = "email"): string {
  return reqString(body, field, {
    trim: true,
    maxLength: 254,
    pattern: EMAIL_PATTERN,
  });
}

export function optEmail(body: Body, field = "email"): string | undefined {
  return optString(body, field, {
    trim: true,
    maxLength: 254,
    pattern: EMAIL_PATTERN,
  });
}

/** Rejects usernames that start with `admin` (case-insensitive), e.g. impersonation. */
export function assertUsernameNotAdminPrefix(username: string): void {
  if (username.trim().toLowerCase().startsWith("admin")) {
    throw new ApiError(
      400,
      "invalid_request",
      "Username must not start with 'admin'",
    );
  }
}

/** Comma-separated hostnames (no port). Default covers reference tests and local dev. */
function passwordResetRedirectAllowedHosts(): string[] {
  const raw = process.env.PASSWORD_RESET_REDIRECT_ALLOWED_HOSTS;
  const parts =
    raw && raw.trim().length > 0
      ? raw.split(",")
      : ["app.example.com", "localhost", "127.0.0.1"];
  return [...new Set(parts.map((h) => h.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Ensures password-reset `redirectUrl` uses https and points at an allowed host
 * (open-redirect mitigation). Optional field: skip when absent.
 */
export function assertPasswordResetRedirectHostAllowed(redirectUrl: string): void {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid redirectUrl");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "invalid_request", "redirectUrl must use https");
  }
  const host = url.hostname.toLowerCase();
  const allowed = passwordResetRedirectAllowedHosts();
  if (!allowed.includes(host)) {
    throw new ApiError(
      400,
      "invalid_request",
      "redirectUrl host is not allowed",
    );
  }
}

export function requireUsername(body: Body, field = "username"): string {
  const username = reqString(body, field, {
    trim: true,
    minLength: 3,
    maxLength: 32,
    pattern: USERNAME_PATTERN,
  });
  assertUsernameNotAdminPrefix(username);
  return username;
}

export function requirePassword(body: Body, field = "password"): string {
  return reqString(body, field, {
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: 256,
  });
}

export function requireNewPassword(body: Body, field = "newPassword"): string {
  return reqString(body, field, {
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: 256,
  });
}

type CursorParams = { limit: number; offset: number };

export type { CursorParams };

export function parseCursorPagination(
  query: unknown,
  defaults: { defaultLimit: number; maxLimit: number },
  options: { principalId: string },
): CursorParams {
  const q =
    query !== null && typeof query === "object" && !Array.isArray(query)
      ? (query as Record<string, unknown>)
      : {};
  const limitRaw = q.limit;
  let limit = defaults.defaultLimit;
  if (limitRaw !== undefined && limitRaw !== null && limitRaw !== "") {
    let parsed: number;
    if (typeof limitRaw === "number") {
      parsed = limitRaw;
    } else if (typeof limitRaw === "string") {
      const t = limitRaw.trim();
      if (t === "" || !/^\d+$/.test(t)) {
        throw new ApiError(400, "invalid_request", "'limit' must be a positive integer");
      }
      parsed = Number.parseInt(t, 10);
    } else {
      throw new ApiError(400, "invalid_request", "'limit' must be a positive integer");
    }
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new ApiError(400, "invalid_request", "'limit' must be >= 1");
    }
    if (parsed > defaults.maxLimit) {
      throw new ApiError(
        400,
        "invalid_request",
        `'limit' must be <= ${defaults.maxLimit}`,
      );
    }
    limit = parsed;
  }

  let offset = 0;
  const cursorRaw = q.cursor;
  if (typeof cursorRaw === "string" && cursorRaw.length > 0) {
    try {
      const decoded = Buffer.from(cursorRaw, "base64url").toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded) as unknown;
      } catch {
        throw new Error("bad cursor");
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("bad cursor");
      }
      const obj = parsed as { u?: unknown; o?: unknown };
      if (
        typeof obj.u !== "string" ||
        obj.u !== options.principalId ||
        typeof obj.o !== "number" ||
        !Number.isInteger(obj.o) ||
        obj.o < 0
      ) {
        throw new Error("bad cursor");
      }
      offset = obj.o;
    } catch (e) {
      if (e instanceof ApiError) {throw e;}
      throw new ApiError(400, "invalid_request", "'cursor' is not valid");
    }
  }

  return { limit, offset };
}

export function paginate<T>(
  items: T[],
  params: CursorParams,
  options: { principalId: string },
): CursorPage<T> {
  const { limit, offset } = params;
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  const out: CursorPage<T> = { items: slice };
  if (next < items.length) {
    out.nextCursor = Buffer.from(
      JSON.stringify({ u: options.principalId, o: next }),
      "utf8",
    ).toString("base64url");
  }
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowMs(): number {
  return Date.now();
}

export type AuthContext = {
  user: StoredUser;
  session: StoredSession;
};

function extractBearer(request: FastifyRequest): string | undefined {
  const raw = request.headers.authorization ?? request.headers.Authorization;
  if (typeof raw !== "string") {return undefined;}
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1] : undefined;
}

export function authenticate(request: FastifyRequest): AuthContext {
  const token = extractBearer(request);
  if (!token) {
    throw new ApiError(401, "unauthenticated", "Missing bearer token");
  }
  const session = store.getSessionByAccessToken(token);
  if (!session) {
    throw new ApiError(401, "unauthenticated", "Invalid access token");
  }
  if (session.accessTokenExpiresAt <= nowMs()) {
    throw new ApiError(401, "unauthenticated", "Access token has expired");
  }
  const user = store.users.get(session.userId);
  if (!user) {
    throw new ApiError(401, "unauthenticated", "Account no longer exists");
  }
  session.lastSeenAt = nowIso();
  return { user, session };
}

export function tryAuthenticate(request: FastifyRequest): AuthContext | undefined {
  try {
    return authenticate(request);
  } catch {
    return undefined;
  }
}

function presenceFor(): "online" | "away" | "busy" | "offline" {
  return "offline";
}

export function toMeProfile(user: StoredUser): MeProfile {
  const profile: MeProfile = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    presence: presenceFor(),
    accountState: {
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      mfaMethods: [...user.mfaMethods],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };
  if (user.statusMessage) {profile.statusMessage = user.statusMessage;}
  if (user.avatarAttachmentId) {profile.avatarAttachmentId = user.avatarAttachmentId;}
  return profile;
}

export function toDeviceSession(
  device: StoredDevice | undefined,
  session: StoredSession,
  currentSessionId: string | undefined,
): DeviceSession {
  const out: DeviceSession = {
    id: device?.id ?? session.id,
    sessionId: session.id,
    current: session.id === currentSessionId,
    createdAt: device?.createdAt ?? session.createdAt,
    lastSeenAt: device?.lastSeenAt ?? session.lastSeenAt,
  };
  if (session.deviceId ?? device?.id) {
    out.deviceId = device?.id ?? session.deviceId;
  }
  const ua = session.userAgent ?? device?.userAgent;
  if (ua) {out.userAgent = ua;}
  const ip = session.ipAddress ?? device?.ipAddress;
  if (ip) {out.ipAddress = ip;}
  if (device?.pushToken) {
    out.pushToken = { ...device.pushToken };
  }
  return out;
}

export function buildDeviceSessionsForUser(
  userId: string,
  currentSessionId: string | undefined,
): DeviceSession[] {
  const sessions = store
    .listSessionsForUser(userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const seenDevices = new Set<string>();
  const rows: DeviceSession[] = [];
  for (const session of sessions) {
    if (session.deviceId) {
      const device = store.getDevice(userId, session.deviceId);
      const key = `device:${session.deviceId}`;
      if (seenDevices.has(key)) {continue;}
      seenDevices.add(key);
      rows.push(toDeviceSession(device, session, currentSessionId));
    } else {
      rows.push(toDeviceSession(undefined, session, currentSessionId));
    }
  }
  for (const device of store.listDevicesForUser(userId)) {
    const key = `device:${device.id}`;
    if (seenDevices.has(key)) {continue;}
    seenDevices.add(key);
    const placeholder: StoredSession = {
      id: device.id,
      userId,
      deviceId: device.id,
      accessToken: "",
      accessTokenExpiresAt: 0,
      refreshToken: "",
      refreshTokenExpiresAt: 0,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    };
    rows.push(toDeviceSession(device, placeholder, currentSessionId));
  }
  return rows;
}

export function issueTokensForUser(
  user: StoredUser,
  opts: {
    deviceId?: string;
    userAgent?: string;
    ipAddress?: string;
  },
): { tokens: AuthTokens; session: StoredSession } {
  const now = nowMs();
  const nowIsoStr = new Date(now).toISOString();
  const session: StoredSession = {
    id: randomId("ses"),
    userId: user.id,
    deviceId: opts.deviceId,
    accessToken: randomToken(32),
    accessTokenExpiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
    refreshToken: randomToken(32),
    refreshTokenExpiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
    userAgent: opts.userAgent,
    ipAddress: opts.ipAddress,
    createdAt: nowIsoStr,
    lastSeenAt: nowIsoStr,
  };
  store.registerSession(session);
  if (opts.deviceId) {
    store.upsertDevice(user.id, opts.deviceId, {
      userAgent: opts.userAgent,
      ipAddress: opts.ipAddress,
      now: nowIsoStr,
    });
  }
  const tokens: AuthTokens = {
    tokenType: "Bearer",
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
  return { tokens, session };
}

export function buildAuthSuccess(
  user: StoredUser,
  tokens: AuthTokens,
): AuthSuccess {
  return { ...tokens, user: toMeProfile(user) };
}

export type RouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export type AuthedRouteHandler = (
  ctx: { auth: AuthContext; request: FastifyRequest; reply: FastifyReply },
) => Promise<unknown> | unknown;

function wrapHandler(handler: RouteHandler): RouteHandlerMethod {
  return async (request, reply) => {
    try {
      const result = await handler(request, reply);
      if (reply.sent) {return;}
      if (result === undefined) {
        return reply.code(204).send();
      }
      return reply.send(result);
    } catch (err) {
      if (err instanceof ApiError) {
        return reply
          .code(err.status)
          .send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  };
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export function registerRoute(
  app: FastifyInstance,
  spec: { method: HttpMethod; url: string; handler: RouteHandler },
): void {
  app.route({
    method: spec.method,
    url: spec.url,
    preHandler: async (request) => {
      logRequest(request);
    },
    handler: wrapHandler(spec.handler),
  });
}

export function registerAuthedRoute(
  app: FastifyInstance,
  spec: { method: HttpMethod; url: string; handler: AuthedRouteHandler },
): void {
  registerRoute(app, {
    method: spec.method,
    url: spec.url,
    handler: async (request, reply) => {
      const auth = authenticate(request);
      return spec.handler({ auth, request, reply });
    },
  });
}

const PUSH_PROVIDERS: readonly PushProvider[] = ["apns", "fcm", "web_push"];
const MFA_METHODS: readonly MfaMethod[] = ["totp", "sms"];

export function requirePushProvider(body: Body, field = "provider"): PushProvider {
  return reqEnum(body, field, PUSH_PROVIDERS);
}

export function requireMfaMethod(body: Body, field = "method"): MfaMethod {
  return reqEnum(body, field, MFA_METHODS);
}

export async function createPasswordHashFor(password: string): Promise<{
  hash: string;
  salt: string;
}> {
  return await hashPassword(password);
}

export function getRequestUserAgent(request: FastifyRequest): string | undefined {
  const ua = request.headers["user-agent"];
  if (typeof ua !== "string" || ua.length === 0) {return undefined;}
  return ua;
}

export function getRequestIp(request: FastifyRequest): string | undefined {
  return request.ip || undefined;
}

export type AccountStateView = AccountState;
