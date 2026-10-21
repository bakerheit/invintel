import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * A webhook's signing secret has to be recoverable (the server needs it to sign each delivery), so it can't be hashed
 * like an API key. What it can be is encrypted at rest: with WEBHOOK_SECRET_KEY set, secrets are stored as AES-256-GCM
 * ("v1:iv:tag:data"), so a copy of the database alone doesn't reveal them. The key lives in the server's environment,
 * kept off the database host. Without a key they are stored as they are (fine for a demo, and the README says so).
 *
 * A stored value that doesn't start with "v1:" is a plain secret ("whsec_..."), so rows made before encryption was
 * switched on keep working and are encrypted the next time they are used.
 */
const SEALED = "v1:";
const keyFrom = (secret: string) => createHash("sha256").update(`invintel-webhook-secrets:${secret}`).digest();

export const webhookSecretKey = () => process.env.WEBHOOK_SECRET_KEY || undefined;
export const isSealed = (stored: string) => stored.startsWith(SEALED);

export function sealWebhookSecret(plain: string, key = webhookSecretKey()): string {
  if (!key) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(key), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [SEALED.slice(0, 2), iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export class SecretUnavailableError extends Error {}

export function openWebhookSecret(stored: string, key = webhookSecretKey()): string {
  if (!isSealed(stored)) return stored;
  if (!key) throw new SecretUnavailableError("This webhook's secret is encrypted, but WEBHOOK_SECRET_KEY isn't set on the server.");
  try {
    const [, iv, tag, data] = stored.split(":") as [string, string, string, string];
    const d = createDecipheriv("aes-256-gcm", keyFrom(key), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new SecretUnavailableError("This webhook's secret can't be decrypted with the WEBHOOK_SECRET_KEY the server has. It was encrypted with a different key.");
  }
}
