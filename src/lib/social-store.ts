/**
 * In-memory storage for contacts and invites.
 * Mirrors the surface documented in user-interface.md.
 */

export type InviteStatus = "pending" | "accepted" | "declined" | "expired";

export type StoredContact = {
  ownerId: string;
  userId: string;
  alias: string | null;
  createdAt: string;
};

export type StoredInvite = {
  id: string;
  code: string;
  status: InviteStatus;
  fromUserId: string;
  toUserId: string | null;
  email: string | null;
  emailNormalized: string | null;
  conversationId: string | null;
  message: string | null;
  createdAt: string;
  respondedAt: string | null;
};

class SocialStore {
  /** ownerId -> Map<targetUserId, StoredContact> */
  private contactsByOwner = new Map<string, Map<string, StoredContact>>();
  /** id -> invite */
  invites = new Map<string, StoredInvite>();
  /** code -> id */
  private invitesByCode = new Map<string, string>();

  getContact(ownerId: string, userId: string): StoredContact | undefined {
    return this.contactsByOwner.get(ownerId)?.get(userId);
  }

  /**
   * Adds a contact row. Idempotent: if a row already exists, the existing row
   * is returned. The alias on an existing row is preserved once set — a re-add
   * with a different alias does not overwrite it. However, if the existing row
   * has no alias yet, a re-add may set it for the first time.
   */
  addContactIfAbsent(c: StoredContact): {
    contact: StoredContact;
    created: boolean;
  } {
    let bucket = this.contactsByOwner.get(c.ownerId);
    if (!bucket) {
      bucket = new Map<string, StoredContact>();
      this.contactsByOwner.set(c.ownerId, bucket);
    }
    const existing = bucket.get(c.userId);
    if (existing) {
      if (existing.alias === null && c.alias !== null) {
        existing.alias = c.alias;
      }
      return { contact: existing, created: false };
    }
    bucket.set(c.userId, c);
    return { contact: c, created: true };
  }

  removeContact(ownerId: string, userId: string): boolean {
    const bucket = this.contactsByOwner.get(ownerId);
    if (!bucket) {return false;}
    return bucket.delete(userId);
  }

  listContacts(ownerId: string): StoredContact[] {
    const bucket = this.contactsByOwner.get(ownerId);
    if (!bucket) {return [];}
    return Array.from(bucket.values());
  }

  addInvite(invite: StoredInvite): void {
    this.invites.set(invite.id, invite);
    this.invitesByCode.set(invite.code, invite.id);
  }

  getInvite(id: string): StoredInvite | undefined {
    return this.invites.get(id);
  }

  getInviteByCode(code: string): StoredInvite | undefined {
    const id = this.invitesByCode.get(code);
    return id ? this.invites.get(id) : undefined;
  }

  listInvitesInvolving(userId: string, emailNormalized?: string): StoredInvite[] {
    const out: StoredInvite[] = [];
    for (const inv of this.invites.values()) {
      if (
        inv.fromUserId === userId ||
        inv.toUserId === userId ||
        (emailNormalized && inv.emailNormalized === emailNormalized)
      ) {
        out.push(inv);
      }
    }
    return out;
  }
}

export const socialStore = new SocialStore();
