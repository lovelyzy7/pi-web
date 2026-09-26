import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/**
 * Encrypts the TOTP seed at rest.
 *
 * The key lives in its own 0600 file beside the database instead of in a row:
 * that way a copy of `pi-web.db` alone — the thing an operator is most likely to
 * back up or paste into a bug report — cannot be turned back into valid
 * two-factor codes.
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const PREFIX = "v1";

export function getDefaultSecretKeyPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pi-web", "secret.key");
}

export function readOrCreateSecretKey(keyPath: string = getDefaultSecretKeyPath()): Buffer {
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8").trim();
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length !== KEY_BYTES) {
      throw new Error(`Invalid Pi Web secret key at ${keyPath}: expected ${KEY_BYTES} bytes`);
    }
    return decoded;
  }

  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(keyPath), { recursive: true });
  writePrivateFileAtomicSync(keyPath, `${key.toString("base64")}\n`);
  return key;
}

/** Returns `v1.<nonce>.<ciphertext>.<tag>`, all base64url. */
export function sealSecret(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    PREFIX,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

/** Throws when the value was written with a different key or is malformed. */
export function openSecret(sealed: string, key: Buffer): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("Unsupported sealed secret format");
  const nonce = Buffer.from(parts[1], "base64url");
  const ciphertext = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== 16) throw new Error("Malformed sealed secret");

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
