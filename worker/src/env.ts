// Libre — Worker Env bindings (Cloudflare Worker runtime).
// §5 API surface: D1 (authoritative state), R2 (media objects, presigned access),
// secrets and configuration passed via [vars] / .dev.vars / Wrangler secrets.
// §6.4 KV is NOT used for authoritative state; omitted here.
// §18 Workers Rate Limiting API: optional binding (graceful skip when absent).

import type { D1Database, DurableObjectNamespace } from "@cloudflare/workers-types";

/** §18 — Rate Limit binding shape (§18.1/llms full text: `env.LIMITER.limit({ key })`). */
interface RateLimit {
  limit(args: { key: string }): Promise<{ success: boolean; resetTime: Date }>;
}

export interface Env {
  // §8 — D1 database (authoritative relational state)
  DB: D1Database;

  // §9 — R2 media bucket (presigned access only, never public)
  MEDIA_BUCKET: {
    get(key: string): Promise<R2ObjectBody | null>;
    head(key: string): Promise<R2Object | null>;
    list(opts: { prefix: string; limit?: number }): Promise<R2Objects>;
    put(key: string, value: ReadableStream | ArrayBuffer | string, opts?: R2PutOptions): Promise<R2Object>;
  };

  // §14 — allowed browser origins (comma-separated)
  ALLOWED_ORIGINS: string;

  // §15 — R2 S3 API endpoint
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;

  // §15 — R2 S3 API secret access key. Declared here as a Secr; provisioned via
  // `wrangler secret put R2_SECRET_ACCESS_KEY` (never in [vars] or wrangler.toml).
  R2_SECRET_ACCESS_KEY?: string;

  // §9.2 — presigned URL TTL (seconds); clamped to [1, 604800]
  PLAYBACK_PRESIGN_TTL_SECONDS?: string;

  // §18 — optional rate limiting bindings (absent in tests/local without namespace)
  AUTH_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
  PLAYBACK_LIMITER?: RateLimit;

  // Watch parties: realtime room state (Durable Object, 24h rooms).
  PARTY_ROOM: DurableObjectNamespace;
}