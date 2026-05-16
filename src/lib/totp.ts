import { createHmac, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 Base32 without padding (otpauth / Google Authenticator). */
export function bufferToBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buf.length; i += 1) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Stored enrollment/user TOTP seed (`randomToken(20)` → base64url). */
export function totpSecretBytes(secretBase64Url: string): Buffer {
  return Buffer.from(secretBase64Url, "base64url");
}

export function totpSecretForOtpauth(secretBase64Url: string): string {
  return bufferToBase32(totpSecretBytes(secretBase64Url));
}

function hotpCode(secret: Buffer, counter: bigint, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = 10 ** digits;
  return (bin % mod).toString().padStart(digits, "0");
}

type TotpOptions = {
  nowMs?: number;
  stepSec?: number;
  digits?: number;
};

/**
 * RFC 6238 TOTP (SHA-1, 30s step, 6 digits). `secretBase64Url` matches stored `randomToken(20)`.
 */
export function generateTotpCode(
  secretBase64Url: string,
  options?: TotpOptions,
): string | undefined {
  const secret = totpSecretBytes(secretBase64Url);
  if (secret.length < 10) {return undefined;}

  const digits = options?.digits ?? 6;
  const stepSec = options?.stepSec ?? 30;
  const nowMs = options?.nowMs ?? Date.now();
  const stepMs = stepSec * 1000;
  const t = Math.floor(nowMs / stepMs);

  return hotpCode(secret, BigInt(t), digits);
}

export function verifyTotpCode(
  secretBase64Url: string,
  code: string,
  options?: TotpOptions & { window?: number },
): boolean {
  const secret = totpSecretBytes(secretBase64Url);
  if (secret.length < 10) {return false;}

  const trimmed = code.trim().replace(/\s+/g, "");
  const digits = options?.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(trimmed)) {return false;}

  const window = options?.window ?? 1;
  const stepSec = options?.stepSec ?? 30;
  const nowMs = options?.nowMs ?? Date.now();
  const stepMs = stepSec * 1000;
  const t = Math.floor(nowMs / stepMs);

  const want = Buffer.from(trimmed, "utf8");
  for (let w = -window; w <= window; w += 1) {
    const candidate = hotpCode(secret, BigInt(t + w), digits);
    const got = Buffer.from(candidate, "utf8");
    if (got.length === want.length && timingSafeEqual(got, want)) {return true;}
  }
  return false;
}
