// Libre — AWS SigV4 presigner via WebCrypto (HMAC-SHA256).
// §9.2: presigned URLs for R2 S3 API domain only (`<account_id>.r2.cloudflarestorage.com`).
// §9.2: 1 s – 7 d (604800 s) expiry; caller must set TTL.
// Region is "auto" (Cloudflare R2 convention). Service is "s3".
// "AWS SDK v3 or equivalent" — this IS the equivalent: same SigV4 algorithm, pure WebCrypto.

const REGION = "auto";
const SERVICE = "s3";
const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SIGNED_HEADERS = "host";
const DATE_TPL = /^\d{8}T\d{6}Z$/;

// -- low-level WebCrypto HMAC helpers -------------------------------------------

async function hmac(key: CryptoKey | ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = key instanceof CryptoKey
    ? key
    : await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}

async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

function toBase64url(buf: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// -- signing key derivation -----------------------------------------------------

async function deriveSigningKey(secretAccessKey: string, dateStamp: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const kDate    = await hmac(enc.encode("AWS4" + secretAccessKey), dateStamp);
  const kRegion  = await hmac(new Uint8Array(kDate), REGION);
  const kService = await hmac(new Uint8Array(kRegion), SERVICE);
  const kSigning = await hmac(new Uint8Array(kService), "aws4_request");
  return crypto.subtle.importKey("raw", kSigning, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

// -- public API -----------------------------------------------------------------

export interface PresignResult {
  url: string;
  expiresAt: Date;
}

/**
 * §9.2 — Generate a presigned GET or HEAD URL for an R2 object.
 * @param opts.bucketKey  the R2 storage_key (e.g. "media/<assetId>/playlist.m3u8")
 * @param opts.accountId  Cloudflare account id
 * @param opts.accessKeyId  R2 S3 API access key id
 * @param opts.secretAccessKey  R2 S3 API secret access key
 * @param opts.method  "GET" (default) or "HEAD"
 * @param opts.ttlSeconds  URL lifetime (1 – 604800 s)
 * @param opts.expiresAt  optional override Date (otherwise computed as now + ttl)
 */
export async function presignGet(opts: {
  bucketKey: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  method?: "GET" | "HEAD";
  ttlSeconds: number;
  expiresAt?: Date;
}): Promise<PresignResult> {
  const method = opts.method ?? "GET";
  const ttl   = Math.max(1, Math.min(opts.ttlSeconds, 604_800)); // clamp to §9.2
  const now   = opts.expiresAt ? new Date(opts.expiresAt.getTime() - ttl * 1000) : new Date();
  const expires = opts.expiresAt ?? new Date(now.getTime() + ttl * 1000);

  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const endpoint = `https://${opts.accountId}.r2.cloudflarestorage.com`;
  const host     = new URL(endpoint).host;

  // Canonical request (§3 presign URL format: resource = "/<key>")
  const canonicalUri = "/" + opts.bucketKey.split("/").map(encodeURIComponent).join("/");

  // Query string params
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const queryParams = new URLSearchParams({
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${opts.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(ttl),
    "X-Amz-SignedHeaders": SIGNED_HEADERS,
  });

  // Canonical query string — must be sorted by param name
  const sortedParams = [...queryParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalQuery = sortedParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

  const canonicalHeaders = `host:${host}`;
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, SIGNED_HEADERS, EMPTY_PAYLOAD_HASH].join("\n");

  const canonicalRequestHash = await sha256hex(canonicalRequest);
  const stringToSign = [ALGORITHM, amzDate, credentialScope, canonicalRequestHash].join("\n");

  const signingKey = await deriveSigningKey(opts.secretAccessKey, dateStamp);
  const signatureBuf = await crypto.subtle.sign("HMAC", signingKey, new TextEncoder().encode(stringToSign));
  const signature = hex(signatureBuf);

  const url = `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  return { url, expiresAt: expires };
}