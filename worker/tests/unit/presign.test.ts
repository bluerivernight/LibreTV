import { describe, it, expect } from "vitest";
import { presignGet } from "../../src/util/presign";

const BASE = {
  accountId: "abc123",
  accessKeyId: "akid",
  secretAccessKey: "secret",
  bucketKey: "media/xyz01/master.m3u8",
  ttlSeconds: 1800,
};

/** Fixed clock so signatures are deterministic across runs. */
const FIXED = new Date("2026-01-02T03:04:05.000Z");

describe("presignGet (§9.2 SigV4 presigned GET)", () => {
  it("builds an R2 S3-domain URL with the signed query params", async () => {
    const { url, expiresAt } = await presignGet({ ...BASE, expiresAt: FIXED });
    const u = new URL(url);
    expect(u.protocol).toBe("https:");
    expect(u.host).toBe("abc123.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/media/xyz01/master.m3u8");

    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Credential")).toBe("akid/20260102/auto/s3/aws4_request");
    expect(u.searchParams.get("X-Amz-Date")).toBe("20260102T023405Z"); // FIXED − 1800 s TTL
    expect(u.searchParams.get("X-Amz-Expires")).toBe("1800");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    expect(expiresAt.toISOString()).toBe(FIXED.toISOString());
  });

  it("clamps X-Amz-Expires to the §9.2 range [1, 604800]", async () => {
    const huge = await presignGet({ ...BASE, ttlSeconds: 999_999_999, expiresAt: FIXED });
    const tiny = await presignGet({ ...BASE, ttlSeconds: 0, expiresAt: FIXED });
    expect(new URL(huge.url).searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(new URL(tiny.url).searchParams.get("X-Amz-Expires")).toBe("1");
  });

  it("is deterministic for identical inputs", async () => {
    const a = await presignGet({ ...BASE, expiresAt: FIXED });
    const b = await presignGet({ ...BASE, expiresAt: FIXED });
    expect(a.url).toBe(b.url);
  });

  it("changes the signature when the secret, key, or ttl changes", async () => {
    const base = (await presignGet({ ...BASE, expiresAt: FIXED })).url;
    const sig = (u: string) => new URL(u).searchParams.get("X-Amz-Signature");
    const otherSecret = await presignGet({ ...BASE, secretAccessKey: "other-secret", expiresAt: FIXED });
    const otherKey = await presignGet({ ...BASE, accessKeyId: "other-key", expiresAt: FIXED });
    const otherTtl = await presignGet({ ...BASE, ttlSeconds: 600, expiresAt: FIXED });
    expect(sig(otherSecret.url)).not.toBe(sig(base));
    expect(sig(otherKey.url)).not.toBe(sig(base));
    expect(sig(otherTtl.url)).not.toBe(sig(base));
  });

  it("signs per-method URLs (GET vs HEAD differ in the canonical request)", async () => {
    const get = await presignGet({ ...BASE, method: "GET", expiresAt: FIXED });
    const head = await presignGet({ ...BASE, method: "HEAD", expiresAt: FIXED });
    expect(new URL(get.url).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(head.url).searchParams.get("X-Amz-Signature"),
    );
  });

  it("URI-encodes each key segment", async () => {
    const { url } = await presignGet({ ...BASE, bucketKey: "a b/c.d/seg 1.ts", expiresAt: FIXED });
    expect(new URL(url).pathname).toBe("/a%20b/c.d/seg%201.ts");
  });
});