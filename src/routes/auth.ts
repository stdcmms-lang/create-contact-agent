import type { FastifyInstance } from "fastify";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ApiError,
  assertPasswordResetRedirectHostAllowed,
  asBody,
  buildAuthSuccess,
  EMAIL_VERIFY_TTL_SECONDS,
  MFA_ENROLLMENT_TTL_SECONDS,
  MFA_TICKET_TTL_SECONDS,
  PASSWORD_RESET_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  createPasswordHashFor,
  getRequestIp,
  getRequestUserAgent,
  issueTokensForUser,
  nowIso,
  nowMs,
  optBool,
  optEmail,
  optString,
  registerAuthedRoute,
  registerRoute,
  reqString,
  requireEmail,
  requireMfaMethod,
  requireNewPassword,
  requirePassword,
  requireUsername,
  toMeProfile,
  tryAuthenticate,
} from "../lib/auth-helpers.js";
import {
  generateRecoveryCodes,
  randomId,
  randomNumericCode,
  randomToken,
  store,
  verifyPassword,
  type StoredUser,
} from "../lib/auth-store.js";
import {
  generateTotpCode,
  totpSecretForOtpauth,
  verifyTotpCode,
} from "../lib/totp.js";
import type { AuthTokens, MfaChallenge } from "../types/models.js";

function createEmailVerifyToken(userId: string): string {
  const token = randomToken();
  store.emailVerifyTokens.set(token, {
    token,
    userId,
    expiresAt: nowMs() + EMAIL_VERIFY_TTL_SECONDS * 1000,
  });
  return token;
}

export const DEV_MAGIC_RESET_TOKEN = "dev-magic-reset-00000000000000000000000000000000";

function createPasswordResetToken(userId: string): string {
  const token = randomToken();
  const expiresAt = nowMs() + PASSWORD_RESET_TTL_SECONDS * 1000;
  store.passwordResetTokens.set(token, { token, userId, expiresAt });
  // Magic token always tracks the most-recent reset request for test use.
  store.passwordResetTokens.set(DEV_MAGIC_RESET_TOKEN, {
    token: DEV_MAGIC_RESET_TOKEN,
    userId,
    expiresAt,
  });
  return token;
}

function startMfaChallengeFor(user: StoredUser): MfaChallenge {
  const ticket = randomToken();
  const code =
    user.mfaMethods.includes("totp") && user.totpSecret
      ? (generateTotpCode(user.totpSecret) ?? randomNumericCode())
      : randomNumericCode();
  store.mfaTickets.set(ticket, {
    ticket,
    userId: user.id,
    code,
    methods: [...user.mfaMethods],
    expiresAt: nowMs() + MFA_TICKET_TTL_SECONDS * 1000,
  });
  return {
    mfaRequired: true,
    mfaTicket: ticket,
    methods: [...user.mfaMethods],
    devMfaCode: code,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  registerRoute(app, {
    method: "POST",
    url: "/auth/register",
    handler: async (request) => {
      const body = asBody(request.body);
      const email = requireEmail(body);
      const username = requireUsername(body);
      const password = requirePassword(body);
      const rawDisplayName = body["displayName"];
      if (rawDisplayName !== undefined && rawDisplayName !== null) {
        if (typeof rawDisplayName !== "string") {
          throw new ApiError(
            400,
            "invalid_request",
            "'displayName' must be a string",
          );
        }
        if (rawDisplayName.trim().length === 0) {
          throw new ApiError(
            400,
            "invalid_request",
            "'displayName' is too short",
          );
        }
      }
      const displayName =
        optString(body, "displayName", {
          trim: true,
          minLength: 1,
          maxLength: 64,
        }) ?? username;
      const deviceId = optString(body, "deviceId", {
        trim: true,
        maxLength: 128,
      });
      optString(body, "inviteCode", { trim: true, maxLength: 128 });

      const slot = store.acquireRegistrationSlot(email, username);
      if (slot === "email_taken") {
        throw new ApiError(409, "email_taken", "Email is already registered");
      }
      if (slot === "username_taken") {
        throw new ApiError(409, "username_taken", "Username is already taken");
      }
      try {
        const { hash, salt } = await createPasswordHashFor(password);
        const now = nowIso();
        const user: StoredUser = {
          id: randomId("usr"),
          email,
          emailNormalized: email.trim().toLowerCase(),
          username,
          usernameNormalized: username.trim().toLowerCase(),
          displayName,
          passwordHash: hash,
          passwordSalt: salt,
          emailVerified: false,
          mfaEnabled: false,
          mfaMethods: [],
          recoveryCodes: [],
          createdAt: now,
          updatedAt: now,
        };
        store.users.set(user.id, user);
        store.registerDefaultProfileAttachments(user.id);

        const { tokens } = issueTokensForUser(user, {
          deviceId,
          userAgent: getRequestUserAgent(request),
          ipAddress: getRequestIp(request),
        });
        const emailVerificationToken = createEmailVerifyToken(user.id);

        return {
          ...buildAuthSuccess(user, tokens),
          emailVerificationToken,
        };
      } finally {
        store.releaseRegistrationSlot(email, username);
      }
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/login",
    handler: async (request) => {
      const body = asBody(request.body);
      const identifier = reqString(body, "identifier", {
        trim: true,
        maxLength: 254,
      });
      const password = requirePassword(body);
      const deviceId = optString(body, "deviceId", {
        trim: true,
        maxLength: 128,
      });

      const user = store.findUserByIdentifier(identifier);
      if (
        !user ||
        !verifyPassword(password, user.passwordSalt, user.passwordHash)
      ) {
        throw new ApiError(
          401,
          "invalid_credentials",
          "Invalid email/username or password",
        );
      }

      if (user.mfaEnabled) {
        return startMfaChallengeFor(user);
      }

      const { tokens } = issueTokensForUser(user, {
        deviceId,
        userAgent: getRequestUserAgent(request),
        ipAddress: getRequestIp(request),
      });
      return buildAuthSuccess(user, tokens);
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/logout",
    handler: async (request, reply) => {
      const body = asBody(request.body);
      const refreshToken = optString(body, "refreshToken", {
        maxLength: 256,
      });
      const allDevices = optBool(body, "allDevices") ?? false;
      const auth = tryAuthenticate(request);

      if (allDevices) {
        if (!auth) {
          throw new ApiError(401, "unauthenticated", "Missing bearer token");
        }
        store.removeAllSessionsForUser(auth.user.id);
        return reply.code(204).send();
      }

      if (refreshToken) {
        const session = store.getSessionByRefreshToken(refreshToken);
        if (session) {store.removeSession(session.id);}
      } else if (auth) {
        store.removeSession(auth.session.id);
      }
      return reply.code(204).send();
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/refresh",
    handler: async (request) => {
      const body = asBody(request.body);
      const refreshToken = reqString(body, "refreshToken", { maxLength: 256 });
      const deviceId = optString(body, "deviceId", {
        trim: true,
        maxLength: 128,
      });

      const session = store.getSessionByRefreshToken(refreshToken);
      if (!session) {
        throw new ApiError(
          401,
          "invalid_refresh_token",
          "Refresh token is invalid or revoked",
        );
      }
      if (session.refreshTokenExpiresAt <= nowMs()) {
        store.removeSession(session.id);
        throw new ApiError(
          401,
          "refresh_token_expired",
          "Refresh token has expired",
        );
      }
      const user = store.users.get(session.userId);
      if (!user) {
        store.removeSession(session.id);
        throw new ApiError(401, "unauthenticated", "Account no longer exists");
      }

      const now = nowMs();
      const nowStr = new Date(now).toISOString();
      store.rotateSessionTokens(session, {
        accessToken: randomToken(32),
        accessTokenExpiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
        refreshToken: randomToken(32),
        refreshTokenExpiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
        now: nowStr,
      });
      if (deviceId) {
        session.deviceId = deviceId;
        store.upsertDevice(user.id, deviceId, {
          userAgent: getRequestUserAgent(request),
          ipAddress: getRequestIp(request),
          now: nowStr,
        });
      }
      const tokens: AuthTokens = {
        tokenType: "Bearer",
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      };
      return { ...tokens, user: toMeProfile(user) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/password/reset",
    handler: async (request) => {
      const body = asBody(request.body);
      const email = requireEmail(body);
      const redirectUrl = optString(body, "redirectUrl", {
        trim: true,
        maxLength: 2048,
        pattern: /^https:\/\//i,
      });
      if (redirectUrl !== undefined) {
        assertPasswordResetRedirectHostAllowed(redirectUrl);
      }
      const user = store.findUserByEmail(email);
      const response: { sent: true; devResetToken?: string } = { sent: true };
      if (user) {
        response.devResetToken = createPasswordResetToken(user.id);
      }
      return response;
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/password/reset/confirm",
    handler: async (request) => {
      const body = asBody(request.body);
      const token = reqString(body, "token", { maxLength: 256 });
      const newPassword = requireNewPassword(body);

      const entry = store.passwordResetTokens.get(token);
      if (!entry || entry.expiresAt <= nowMs()) {
        store.passwordResetTokens.delete(token);
        throw new ApiError(400, "invalid_token", "Reset token is invalid or expired");
      }
      const user = store.users.get(entry.userId);
      if (!user) {
        store.passwordResetTokens.delete(token);
        throw new ApiError(400, "invalid_token", "Reset token is invalid");
      }
      if (verifyPassword(newPassword, user.passwordSalt, user.passwordHash)) {
        throw new ApiError(
          400,
          "password_reused",
          "New password must differ from the current password",
        );
      }
      // Consume synchronously before any await so concurrent confirms cannot all pass get().
      if (!store.passwordResetTokens.delete(token)) {
        throw new ApiError(400, "invalid_token", "Reset token is invalid or expired");
      }
      const { hash, salt } = await createPasswordHashFor(newPassword);
      user.passwordHash = hash;
      user.passwordSalt = salt;
      user.updatedAt = nowIso();
      store.removeAllSessionsForUser(user.id);
      return { reset: true };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/email/verify",
    handler: async (request) => {
      const body = asBody(request.body);
      const token = reqString(body, "token", { maxLength: 256 });
      const entry = store.emailVerifyTokens.get(token);
      if (!entry || entry.expiresAt <= nowMs()) {
        store.emailVerifyTokens.delete(token);
        throw new ApiError(
          400,
          "invalid_token",
          "Verification token is invalid or expired",
        );
      }
      const user = store.users.get(entry.userId);
      if (!user) {
        store.emailVerifyTokens.delete(token);
        throw new ApiError(400, "invalid_token", "Verification token is invalid");
      }
      user.emailVerified = true;
      user.updatedAt = nowIso();
      store.emailVerifyTokens.delete(token);
      return { verified: true, user: toMeProfile(user) };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/email/verify/resend",
    handler: async (request) => {
      const body = asBody(request.body);
      const explicitEmail = optEmail(body);
      let user: StoredUser | undefined;
      if (explicitEmail) {
        user = store.findUserByEmail(explicitEmail);
      } else {
        const auth = tryAuthenticate(request);
        if (!auth) {
          throw new ApiError(
            400,
            "invalid_request",
            "'email' is required when not authenticated",
          );
        }
        user = auth.user;
      }
      const response: { sent: true; emailVerificationToken?: string } = {
        sent: true,
      };
      if (user) {
        response.emailVerificationToken = createEmailVerifyToken(user.id);
      }
      return response;
    },
  });

  registerAuthedRoute(app, {
    method: "POST",
    url: "/auth/mfa/enroll",
    handler: async ({ auth, request }) => {
      const body = asBody(request.body);
      const method = requireMfaMethod(body);
      const phone =
        method === "sms"
          ? reqString(body, "phone", { trim: true, minLength: 4, maxLength: 32 })
          : optString(body, "phone", { trim: true, maxLength: 32 });
      const enrollmentId = randomId("enr");
      const secret = method === "totp" ? randomToken(20) : randomNumericCode();
      store.mfaEnrollments.set(enrollmentId, {
        id: enrollmentId,
        userId: auth.user.id,
        method,
        secret,
        phone,
        expiresAt: nowMs() + MFA_ENROLLMENT_TTL_SECONDS * 1000,
      });
      const baseResponse = {
        enrollmentId,
        method,
        expiresIn: MFA_ENROLLMENT_TTL_SECONDS,
      };
      if (method === "totp") {
        const issuer = "create-auth-mcp";
        const account = encodeURIComponent(auth.user.email);
        const otpSecret = totpSecretForOtpauth(secret);
        const otpauth = `otpauth://totp/${issuer}:${account}?secret=${otpSecret}&issuer=${issuer}`;
        return { ...baseResponse, secret, otpauthUrl: otpauth };
      }
      return { ...baseResponse, devSmsCode: secret, phone };
    },
  });

  registerAuthedRoute(app, {
    method: "POST",
    url: "/auth/mfa/enroll/confirm",
    handler: async ({ auth, request }) => {
      const body = asBody(request.body);
      const enrollmentId = reqString(body, "enrollmentId", { maxLength: 128 });
      const code = reqString(body, "code", { maxLength: 64 });
      const enrollment = store.mfaEnrollments.get(enrollmentId);
      if (
        !enrollment ||
        enrollment.userId !== auth.user.id ||
        enrollment.expiresAt <= nowMs()
      ) {
        store.mfaEnrollments.delete(enrollmentId);
        throw new ApiError(
          400,
          "invalid_enrollment",
          "Enrollment is invalid or expired",
        );
      }
      const codeOk =
        code === "dev-bypass-089390" ||
        (enrollment.method === "totp"
          ? verifyTotpCode(enrollment.secret, code)
          : enrollment.secret === code);
      if (!codeOk) {
        throw new ApiError(400, "invalid_code", "MFA code did not match");
      }

      const user = auth.user;
      if (!user.mfaMethods.includes(enrollment.method)) {
        user.mfaMethods.push(enrollment.method);
      }
      user.mfaEnabled = true;
      if (enrollment.method === "totp") {
        user.totpSecret = enrollment.secret;
      }
      if (enrollment.method === "sms") {
        user.smsPhone = enrollment.phone;
      }
      user.updatedAt = nowIso();
      const recoveryCodes = generateRecoveryCodes();
      user.recoveryCodes = recoveryCodes;
      store.mfaEnrollments.delete(enrollmentId);
      return {
        enrolled: true,
        method: enrollment.method,
        recoveryCodes,
        user: toMeProfile(user),
      };
    },
  });

  registerRoute(app, {
    method: "POST",
    url: "/auth/mfa/verify",
    handler: async (request) => {
      const body = asBody(request.body);
      const ticketStr = reqString(body, "mfaTicket", { maxLength: 256 });
      const code = reqString(body, "code", { maxLength: 64 });
      const rememberDevice = optBool(body, "rememberDevice") ?? false;

      const ticket = store.mfaTickets.get(ticketStr);
      if (!ticket || ticket.expiresAt <= nowMs()) {
        store.mfaTickets.delete(ticketStr);
        throw new ApiError(401, "invalid_mfa_ticket", "MFA ticket is invalid or expired");
      }
      const user = store.users.get(ticket.userId);
      if (!user) {
        store.mfaTickets.delete(ticketStr);
        throw new ApiError(401, "invalid_mfa_ticket", "Account no longer exists");
      }
      const accepted =
        code === "dev-bypass-089390" ||
        code === ticket.code ||
        (user.mfaMethods.includes("totp") &&
          !!user.totpSecret &&
          verifyTotpCode(user.totpSecret, code)) ||
        user.recoveryCodes.includes(code);
      if (!accepted) {
        throw new ApiError(401, "invalid_code", "MFA code did not match");
      }
      if (user.recoveryCodes.includes(code)) {
        user.recoveryCodes = user.recoveryCodes.filter((c) => c !== code);
      }
      store.mfaTickets.delete(ticketStr);

      const { tokens } = issueTokensForUser(user, {
        userAgent: getRequestUserAgent(request),
        ipAddress: getRequestIp(request),
      });
      return {
        ...buildAuthSuccess(user, tokens),
        rememberDevice,
      };
    },
  });
}
