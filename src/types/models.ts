/** Core data models — aligned with auth-interface.md */

export type Presence = "online" | "away" | "busy" | "offline";

export type User = {
  id: string;
  displayName: string;
  username: string;
  avatarUrl?: string;
  presence: Presence;
  lastSeenAt?: string;
};

export type MfaMethod = "totp" | "sms";

export type PushProvider = "apns" | "fcm" | "web_push";

export type AccountState = {
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaMethods: MfaMethod[];
  createdAt: string;
  updatedAt: string;
};

export type MeProfile = User & {
  email: string;
  statusMessage?: string;
  avatarAttachmentId?: string;
  accountState: AccountState;
};

export type PushTokenInfo = {
  provider: PushProvider;
  token: string;
  appVersion?: string;
  locale?: string;
  updatedAt: string;
};

export type DeviceSession = {
  id: string;
  deviceId?: string;
  sessionId: string;
  userAgent?: string;
  ipAddress?: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  pushToken?: PushTokenInfo;
};

export type BlockedUserEntry = {
  userId: string;
  reason?: string;
  blockedAt: string;
};

export type AuthTokens = {
  tokenType: "Bearer";
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type AuthSuccess = AuthTokens & {
  user: MeProfile;
};

export type MfaChallenge = {
  mfaRequired: true;
  mfaTicket: string;
  methods: MfaMethod[];
  /** Dev-only convenience: code accepted by `/auth/mfa/verify`. */
  devMfaCode: string;
};

export type CursorPage<T> = {
  items: T[];
  nextCursor?: string | null;
};

/** Types used by conversation-store.ts (aligned with messaging-server). */

export type MessageStatus = "sent" | "deleted";

export type ConversationType = "direct" | "group" | "channel";

export type ConversationPrivacy = "public" | "private";

export type ConversationRole = "owner" | "admin" | "member";

export type Reaction = {
  emoji: string;
  skinTone: string | null;
  userId: string;
  createdAt: string;
};

/** API shape returned by `/conversations` routes. */
export type Conversation = {
  id: string;
  type: ConversationType;
  title: string | null;
  topic: string | null;
  privacy: ConversationPrivacy;
  avatarAttachmentId: string | null;
  memberIds: string[];
  memberPreviewTruncated: boolean;
  unreadCount: number;
  mentionCount: number;
  muted: boolean;
  mutedUntil: string | null;
  archived: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};
