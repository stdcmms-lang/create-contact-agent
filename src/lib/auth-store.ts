import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { MfaMethod, PushProvider } from "../types/models.js";

const SCRYPT_KEY_LEN = 64;

export type StoredUser = {
  id: string;
  email: string;
  emailNormalized: string;
  username: string;
  usernameNormalized: string;
  displayName: string;
  avatarAttachmentId?: string;
  statusMessage?: string;
  passwordHash: string;
  passwordSalt: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaMethods: MfaMethod[];
  totpSecret?: string;
  smsPhone?: string;
  recoveryCodes: string[];
  createdAt: string;
  updatedAt: string;
};

export type StoredPushToken = {
  provider: PushProvider;
  token: string;
  appVersion?: string;
  locale?: string;
  updatedAt: string;
};

export type StoredDevice = {
  id: string;
  userId: string;
  userAgent?: string;
  ipAddress?: string;
  pushToken?: StoredPushToken;
  createdAt: string;
  lastSeenAt: string;
};

export type StoredSession = {
  id: string;
  userId: string;
  deviceId?: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  userAgent?: string;
  ipAddress?: string;
  createdAt: string;
  lastSeenAt: string;
};

export type StoredEmailVerifyToken = {
  token: string;
  userId: string;
  expiresAt: number;
};

export type StoredPasswordResetToken = {
  token: string;
  userId: string;
  expiresAt: number;
};

export type StoredMfaEnrollment = {
  id: string;
  userId: string;
  method: MfaMethod;
  secret: string;
  phone?: string;
  expiresAt: number;
};

export type StoredMfaTicket = {
  ticket: string;
  userId: string;
  code: string;
  methods: MfaMethod[];
  expiresAt: number;
};

export type StoredBlock = {
  userId: string;
  reason?: string;
  blockedAt: string;
};

class AuthStore {
  users = new Map<string, StoredUser>();
  devices = new Map<string, StoredDevice>();
  sessions = new Map<string, StoredSession>();
  /** access token -> session id */
  accessTokenIndex = new Map<string, string>();
  /** refresh token -> session id */
  refreshTokenIndex = new Map<string, string>();
  emailVerifyTokens = new Map<string, StoredEmailVerifyToken>();
  passwordResetTokens = new Map<string, StoredPasswordResetToken>();
  mfaEnrollments = new Map<string, StoredMfaEnrollment>();
  mfaTickets = new Map<string, StoredMfaTicket>();
  /** owner user id -> blocked entries (most recent first) */
  blocks = new Map<string, StoredBlock[]>();
  /** attachment ids the user may set on their profile (e.g. avatar) */
  userProfileAttachments = new Map<string, Set<string>>();

  registerDefaultProfileAttachments(userId: string): void {
    const set = new Set<string>(["att_placeholder"]);
    this.userProfileAttachments.set(userId, set);
  }

  userHasProfileAttachment(userId: string, attachmentId: string): boolean {
    return this.userProfileAttachments.get(userId)?.has(attachmentId) ?? false;
  }

  findUserByEmail(email: string): StoredUser | undefined {
    const norm = email.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.emailNormalized === norm) {return u;}
    }
    return undefined;
  }

  findUserByUsername(username: string): StoredUser | undefined {
    const norm = username.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.usernameNormalized === norm) {return u;}
    }
    return undefined;
  }

  findUserByIdentifier(identifier: string): StoredUser | undefined {
    const norm = identifier.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.emailNormalized === norm || u.usernameNormalized === norm) {return u;}
    }
    return undefined;
  }

  /**
   * Reserves email/username for an in-flight register so concurrent requests
   * cannot both pass uniqueness checks before async password hashing completes.
   */
  private registrationEmailSlots = new Set<string>();
  private registrationUsernameSlots = new Set<string>();

  acquireRegistrationSlot(
    email: string,
    username: string,
  ): "ok" | "email_taken" | "username_taken" {
    const emailNorm = email.trim().toLowerCase();
    const usernameNorm = username.trim().toLowerCase();
    if (this.findUserByEmail(email)) {return "email_taken";}
    if (this.findUserByUsername(username)) {return "username_taken";}
    if (this.registrationEmailSlots.has(emailNorm)) {return "email_taken";}
    if (this.registrationUsernameSlots.has(usernameNorm)) {return "username_taken";}
    this.registrationEmailSlots.add(emailNorm);
    this.registrationUsernameSlots.add(usernameNorm);
    return "ok";
  }

  releaseRegistrationSlot(email: string, username: string): void {
    const emailNorm = email.trim().toLowerCase();
    const usernameNorm = username.trim().toLowerCase();
    this.registrationEmailSlots.delete(emailNorm);
    this.registrationUsernameSlots.delete(usernameNorm);
  }

  deviceKey(userId: string, deviceId: string): string {
    return `${userId}:${deviceId}`;
  }

  getDevice(userId: string, deviceId: string): StoredDevice | undefined {
    return this.devices.get(this.deviceKey(userId, deviceId));
  }

  upsertDevice(
    userId: string,
    deviceId: string,
    fields: { userAgent?: string; ipAddress?: string; now: string },
  ): StoredDevice {
    const key = this.deviceKey(userId, deviceId);
    const existing = this.devices.get(key);
    if (existing) {
      existing.lastSeenAt = fields.now;
      if (fields.userAgent) {existing.userAgent = fields.userAgent;}
      if (fields.ipAddress) {existing.ipAddress = fields.ipAddress;}
      return existing;
    }
    const device: StoredDevice = {
      id: deviceId,
      userId,
      userAgent: fields.userAgent,
      ipAddress: fields.ipAddress,
      createdAt: fields.now,
      lastSeenAt: fields.now,
    };
    this.devices.set(key, device);
    return device;
  }

  listDevicesForUser(userId: string): StoredDevice[] {
    const out: StoredDevice[] = [];
    for (const d of this.devices.values()) {
      if (d.userId === userId) {out.push(d);}
    }
    return out;
  }

  removeDevice(userId: string, deviceId: string): boolean {
    return this.devices.delete(this.deviceKey(userId, deviceId));
  }

  listSessionsForUser(userId: string): StoredSession[] {
    const out: StoredSession[] = [];
    for (const s of this.sessions.values()) {
      if (s.userId === userId) {out.push(s);}
    }
    return out;
  }

  removeSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) {return;}
    this.sessions.delete(sessionId);
    this.accessTokenIndex.delete(s.accessToken);
    this.refreshTokenIndex.delete(s.refreshToken);
  }

  removeAllSessionsForUser(userId: string): number {
    const ids = this.listSessionsForUser(userId).map((s) => s.id);
    for (const id of ids) {this.removeSession(id);}
    return ids.length;
  }

  removeSessionsForDevice(userId: string, deviceId: string): number {
    const ids = this.listSessionsForUser(userId)
      .filter((s) => s.deviceId === deviceId)
      .map((s) => s.id);
    for (const id of ids) {this.removeSession(id);}
    return ids.length;
  }

  getSessionByAccessToken(token: string): StoredSession | undefined {
    const id = this.accessTokenIndex.get(token);
    return id ? this.sessions.get(id) : undefined;
  }

  getSessionByRefreshToken(token: string): StoredSession | undefined {
    const id = this.refreshTokenIndex.get(token);
    return id ? this.sessions.get(id) : undefined;
  }

  rotateSessionTokens(
    session: StoredSession,
    next: {
      accessToken: string;
      accessTokenExpiresAt: number;
      refreshToken: string;
      refreshTokenExpiresAt: number;
      now: string;
    },
  ): void {
    this.accessTokenIndex.delete(session.accessToken);
    this.refreshTokenIndex.delete(session.refreshToken);
    session.accessToken = next.accessToken;
    session.accessTokenExpiresAt = next.accessTokenExpiresAt;
    session.refreshToken = next.refreshToken;
    session.refreshTokenExpiresAt = next.refreshTokenExpiresAt;
    session.lastSeenAt = next.now;
    this.accessTokenIndex.set(session.accessToken, session.id);
    this.refreshTokenIndex.set(session.refreshToken, session.id);
  }

  registerSession(session: StoredSession): void {
    this.sessions.set(session.id, session);
    this.accessTokenIndex.set(session.accessToken, session.id);
    this.refreshTokenIndex.set(session.refreshToken, session.id);
  }

  pruneExpired(now: number): void {
    for (const [token, entry] of this.emailVerifyTokens) {
      if (entry.expiresAt <= now) {this.emailVerifyTokens.delete(token);}
    }
    for (const [token, entry] of this.passwordResetTokens) {
      if (entry.expiresAt <= now) {this.passwordResetTokens.delete(token);}
    }
    for (const [id, entry] of this.mfaEnrollments) {
      if (entry.expiresAt <= now) {this.mfaEnrollments.delete(id);}
    }
    for (const [ticket, entry] of this.mfaTickets) {
      if (entry.expiresAt <= now) {this.mfaTickets.delete(ticket);}
    }
    for (const [id, session] of this.sessions) {
      if (session.refreshTokenExpiresAt <= now) {this.removeSession(id);}
    }
  }
}

export const store = new AuthStore();

export async function hashPassword(password: string): Promise<{
  hash: string;
  salt: string;
}> {
  const salt = randomBytes(16).toString("hex");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LEN, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(key as Buffer);
    });
  });
  const hash = derived.toString("hex");
  return { hash, salt };
}

export function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): boolean {
  const test = scryptSync(password, salt, SCRYPT_KEY_LEN);
  const stored = Buffer.from(expectedHash, "hex");
  if (stored.length !== test.length) {return false;}
  return timingSafeEqual(test, stored);
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomId(prefix: string, bytes = 9): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function randomNumericCode(digits = 6): string {
  const max = 10 ** digits;
  const buf = randomBytes(4).readUInt32BE(0) % max;
  return buf.toString().padStart(digits, "0");
}

export function generateRecoveryCodes(count = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = randomBytes(3).toString("hex");
    const b = randomBytes(3).toString("hex");
    out.push(`${a}-${b}`);
  }
  return out;
}
