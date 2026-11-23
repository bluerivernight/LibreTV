// Libre — password hashing via WebCrypto PBKDF2-SHA256.
// §7.1: no JWT. Password verification is the only crypto-sensitive operation.
// Format: "pbkdf2$sha256$<iterations>$<salt-base64url>$<dk-base64url>"
// Iterations: 210000 (OWASP 2023 recommendation; Workers 512 MB budget, one-shot compute fine).

const ALG = "PBKDF2";
const HASH = "SHA-256";
const ITERATIONS = 210_000;
const SALT_LEN = 16;   // bytes
const DK_LEN   = 32;   // bytes → 256 bits

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function splitHash(stored: string): { iterations: number; salt: Uint8Array; dk: Uint8Array } | null {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return null;
  const iterations = parseInt(parts[2]!, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return null;
  try {
    return { iterations, salt: base64urlToBytes(parts[3]!), dk: base64urlToBytes(parts[4]!) };
  } catch {
    return null;
  }
}

/** Hash a plaintext password. Returns the stored format string. */
export async function hashPassword(plaintext: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(plaintext), ALG, false, ["deriveBits"]);
  const dk = await crypto.subtle.deriveBits({ name: ALG, salt, iterations: ITERATIONS, hash: HASH }, keyMaterial, DK_LEN * 8);
  return `pbkdf2$sha256$${ITERATIONS}$${base64url(salt)}$${base64url(dk)}`;
}

/** Verify a plaintext password against a stored hash (timing-safe comparison). */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parsed = splitHash(stored);
  if (!parsed) return false;

  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(plaintext), ALG, false, ["deriveBits"]);
  const dk = await crypto.subtle.deriveBits(
    { name: ALG, salt: parsed.salt, iterations: parsed.iterations, hash: HASH },
    keyMaterial,
    parsed.dk.length * 8,
  );
  const computed = new Uint8Array(dk);

  // Timing-safe comparison
  if (computed.length !== parsed.dk.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= (computed[i] ?? 0) ^ (parsed.dk[i] ?? 0);
  return diff === 0;
}

/** Exported constants for tests (not used by runtime). */
export const _TEST = { ITERATIONS, SALT_LEN, DK_LEN, splitHash } as const;