import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Hermetic test config: in-memory miniflare D1 (§8) + R2 (§9), fixed vars,
      // and a known test-only secret for the §9.2 presigner. Does not depend on
      // wrangler.toml placeholders (tests run before any deployment).
      miniflare: {
        compatibilityDate: "2026-09-11",
        main: "./src/index.ts",
        d1Databases: {
          DB: "libre-db",
        },
        r2Buckets: {
          MEDIA_BUCKET: "libre-media",
        },
        bindings: {
          ALLOWED_ORIGINS: "https://libre.tv,http://localhost:5173",
          R2_ACCOUNT_ID: "test-account-id",
          R2_ACCESS_KEY_ID: "test-access-key-id",
          R2_SECRET_ACCESS_KEY: "test-secret-access-key",
          PLAYBACK_PRESIGN_TTL_SECONDS: "1800",
        },
      },
    }),
  ],
});