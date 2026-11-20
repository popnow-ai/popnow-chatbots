/** WebCrypto helpers: random ids, PKCE, request signatures and token encryption. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let text = "";
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accepts base64 and base64url, with or without padding. */
export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const normal = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal + "=".repeat((4 - (normal.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new TypeError("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** A short quote number for buttons, about 50 bits. */
export function shortId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return out;
}

export async function sha256b64url(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  return { verifier, challenge: await sha256b64url(verifier) };
}

/** Compares two strings in time that does not depend on where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Discord signs `timestamp + body` with the application's Ed25519 key. */
export async function verifyEd25519(publicKeyHex: string, signatureHex: string, message: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromHex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, fromHex(signatureHex), encoder.encode(message));
  } catch {
    return false;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    const raw = fromB64(secret);
    if (raw.length !== 32) throw new Error("TOKEN_KEY must be 32 random bytes, base64");
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(secret, key);
  }
  return key;
}

/**
 * Encrypts with AES-GCM. `context` (the KV key) is bound in as additional data, so a sealed value
 * copied under another key does not open.
 */
export async function seal(secret: string, plain: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    await aesKey(secret),
    encoder.encode(plain),
  );
  return `v1.${b64url(iv)}.${b64url(data)}`;
}

/** Returns undefined when the value is damaged, was sealed with another key or for another context. */
export async function open(secret: string, sealed: string, context: string): Promise<string | undefined> {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) return undefined;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(iv), additionalData: encoder.encode(context) },
      await aesKey(secret),
      fromB64(data),
    );
    return decoder.decode(plain);
  } catch {
    return undefined;
  }
}
