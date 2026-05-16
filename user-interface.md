# Messaging App — User and Contact Interface

## Conventions

- **Auth**: every endpoint below requires `Authorization: Bearer <accessToken>`. Missing or invalid bearer → `401`.
- **Content type**: request bodies are `application/json`. Malformed JSON → `400`.
- **List envelope**: every list response is `{ "items": T[], "nextCursor": string | null }`. `nextCursor` is omitted or `null` on the final page.
- **Pagination**: opaque `cursor` strings are produced by the server. Clients must not parse them. An unrecognized cursor → `400`.
- **Limits**: `limit` must be a positive integer within the documented range. Non-integers, decimals, zero, negatives, and out-of-range values → `400`.
- **Query string**: when a query parameter is documented as optional, omitting it is fine, but supplying it as an empty string (`?query=`) → `400`. Same rule for `presence`, `direction`, `status`.
- **Error body**: errors return `{ "error": { "code": string, "message": string } }`. `code` values are stable (see *Status code summary* below for the mapping); `message` is not.

## Startup Interface

Any compliant server implementation MUST satisfy the following startup contract.

### Executable

A script named `start-server` (no extension) at the project root, invocable as `./start-server`.

### Readiness signal

When ready to accept HTTP and WebSocket connections, the server MUST emit exactly one JSON line on **stdout**:

```json
{ "type": "server.listening", "host": "<HOST>", "port": <PORT>, "http": "<BASE_URL>" }
```

`host` and `port` are the bound listener. `http` is the base URL clients and tests use (for loopback binds, use `http://127.0.0.1:<port>`).

### Configuration

`PORT` and `HOST` environment variables MAY override the default bind address (`127.0.0.1:3000`).

### Shutdown

The server MUST handle `SIGTERM` by closing listeners and exiting cleanly.

### Stdout format

All log output MUST be NDJSON (one JSON object per line).

## Shared types

### PublicUserProfile

```
{
  "id": string,
  "username": string,
  "displayName": string | null,
  "presence": "online" | "away" | "busy" | "offline",
  "statusMessage": string | null,
  "avatarAttachmentId": string | null
}
```

This is the public view of the auth `User` returned by `GET /me` in `auth-interface.md`. Fields that exist on the auth `User` but are private to that user (`email`, `accountState`, etc.) are never included.

`presence` is server-managed and updated as a side effect of the WebSocket connection lifecycle defined in `messaging-interface.md` (`online` while at least one socket is connected, `offline` otherwise; `away`/`busy` are reserved for future client-driven hints). Users with no active connection default to `"offline"`.

Public profiles never include `email`, `password`, `passwordHash`, `refreshToken`, `accessToken`, `recoveryCodes`, `totpSecret`, `mfaTicket`, `emailVerificationToken`, or `devResetToken`.

### Contact

```
{
  "userId": string,        // the contact's user id
  "alias": string | null,  // trimmed; null if not set
  "user": PublicUserProfile,
  "createdAt": string      // ISO-8601
}
```

### Invite

```
{
  "id": string,
  "code": string,                                          // opaque, used by /invites/lookup
  "status": "pending" | "accepted" | "declined" | "expired",
  "fromUserId": string,
  "toUserId": string | null,                               // null for email-only invites until claimed
  "email": string | null,                                  // null for user-targeted invites
  "conversationId": string | null,
  "message": string | null,                                // trimmed; null if not set or empty after trim
  "createdAt": string,
  "respondedAt": string | null
}
```

## HTTP endpoints

### People, contacts, invites

| Method | Endpoint | Parameters | Description |
|--------|----------|------------|-------------|
| GET | `/users/{userId}` | Path: `userId: string` | Returns a [PublicUserProfile](#publicuserprofile) for the given user. `404` if unknown. |
| GET | `/users` | Query: `query?: string(1-100)`, `presence?: online \| away \| busy \| offline`, `limit?: integer(1-50, default 20)`, `cursor?: string` | Searches discoverable users. Matches `username` and `displayName` substrings, case-insensitive. `presence` filters results to that presence only. Excludes the authenticated user. Returns `{ items: PublicUserProfile[], nextCursor }`. |
| GET | `/contacts` | Query: `query?: string(1-100)`, `presence?: online \| away \| busy \| offline`, `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists the authenticated user's saved contacts. `query` matches the contact's `alias`, `username`, or `displayName`. Returns `{ items: Contact[], nextCursor }`. |
| POST | `/contacts` | Body: `userId: string (required, non-empty)`, `alias?: string(1-50)` | Adds a user to the authenticated user's contacts. `alias` is trimmed; empty after trim is rejected with `400`. Returns the created [Contact](#contact). Adding self → `400`. Unknown `userId` → `404`. Adding an existing contact is idempotent: returns `200` with the existing row (alias is **not** updated by a re-add). |
| DELETE | `/contacts/{userId}` | Path: `userId: string` | Removes a user from the authenticated user's contacts. `204` on success. Removing a contact that isn't in the list → `404`. |
| POST | `/invites` | Body: **exactly one of** `targetUserId: string` **or** `email: string`; plus `conversationId?: string`, `message?: string(0-500)` | Creates an invite. Supplying both `targetUserId` and `email`, or neither, → `400`. `message` is trimmed; whitespace-only becomes `null`. Self-invite (`targetUserId == auth user`) → `400`. Unknown `targetUserId` → `404`. Unknown `conversationId` → `404`. Returns the created [Invite](#invite) with `status: "pending"`. |
| GET | `/invites` | Query: `direction?: sent \| received`, `status?: pending \| accepted \| declined \| expired`, `limit?: integer(1-100, default 50)`, `cursor?: string` | Lists invites involving the authenticated user. Omitting `direction` returns both sent and received. Returns `{ items: Invite[], nextCursor }`. |
| POST | `/invites/{inviteId}/accept` | Path: `inviteId: string`; Body: `{}` | Accepts a pending invite. Only the recipient (`toUserId == auth user`, or claimant of an email invite) may accept. Sender or unrelated user → `403`. Already-resolved invite (accepted/declined/expired) → `409`. Unknown invite → `404`. On success returns the updated [Invite](#invite) with `status: "accepted"`. **Side effect**: for user-to-user invites, both users are added to each other's contacts (idempotent if a contact row already exists; alias unset). When the invite has a non-null `conversationId`, accepting also adds the recipient to that conversation (idempotent if already a member; subject to the conversation's visibility — unknown or no-longer-visible conversation → `404 not_found`). |
| POST | `/invites/{inviteId}/decline` | Path: `inviteId: string`; Body: `{ reason?: string(0-500) }` | Declines a pending invite. Same auth rules as accept. `reason` is trimmed; whitespace-only becomes `null`. Already-resolved → `409`. Unknown → `404`. Returns the updated [Invite](#invite) with `status: "declined"`. No contact side effect. |
| GET | `/invites/lookup` | Query: `code: string (required, non-empty)` | Resolves an invite `code` to its [Invite](#invite) metadata when the caller is the sender, the target user (`toUserId`), or (for email-only pending invites) the authenticated user whose normalized email matches the invite. Does not change status. Missing or empty `code` → `400`. Unknown code, or a code the caller is not allowed to view → `404` (same response in both cases). Requires bearer (`401` without). |

## Status code summary

| Code | `error.code` | Meaning in this surface |
|------|--------------|-------------------------|
| 200  | —            | Success with a body |
| 204  | —            | Success with no body (DELETE /contacts) |
| 400  | `invalid_request` | Malformed request: missing/invalid params, bad JSON, empty `query`, invalid enum, out-of-range `limit`, mutually exclusive fields violated, self-targeting |
| 401  | `unauthenticated` | Missing or invalid bearer |
| 403  | `forbidden`  | Authenticated but not allowed (e.g., sender accepting own invite, stranger acting on someone else's invite) |
| 404  | `not_found`  | Target resource does not exist (user, contact row, invite, conversation, lookup code) |
| 409  | `conflict`   | State conflict (acting on an already-resolved invite) |
| 415  | `unsupported_media_type` | Body present but not `application/json` |
