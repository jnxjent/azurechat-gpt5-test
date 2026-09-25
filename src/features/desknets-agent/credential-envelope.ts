import "server-only";
import { createCipheriv, randomBytes } from "node:crypto";

/** Encrypts a user's application login before it crosses the private VM API link. */
export function sealDeskNetsCredentials(
  userId: string,
  username: string,
  password: string,
  configuredKey = process.env.DESKNETS_CREDENTIAL_TRANSPORT_KEY,
) {
  if (!configuredKey || !/^[A-Za-z0-9_-]{43}$/.test(configuredKey)) {
    throw new Error("DeskNet's credential transport key is not configured.");
  }
  const key = Buffer.from(configuredKey, "base64url");
  if (key.length !== 32) throw new Error("DeskNet's credential transport key is invalid.");
  const nonce = randomBytes(12);
  const issuedAt = Date.now();
  const plaintext = Buffer.from(JSON.stringify({ username, password }), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(`v1:${userId}:${issuedAt}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      version: 1 as const,
      issuedAt,
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}
