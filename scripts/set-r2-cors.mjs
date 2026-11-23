// ── Libre — R2 bucket CORS bootstrap ──────────────────────────────────────────
//
// WHAT IT DOES
//   The frontend fetches presigned R2 URLs directly from the browser. R2 enforces
//   CORS by the browser for cross-origin requests, so the media bucket needs a
//   CORS policy matching the app origin or video segments are silently blocked
//   even when the presigned URL is valid (ARCHITECTURE.md §14). This script reads
//   the policy from ../r2-cors.json and applies it to the R2 media bucket via the
//   S3 PutBucketCors API. Credentials and bucket name come from environment
//   variables only — nothing is hardcoded, nothing is committed.
//
// REQUIRED ENVIRONMENT VARIABLES
//   R2_ACCOUNT_ID               Cloudflare account id (same value as
//                               wrangler.toml [vars].R2_ACCOUNT_ID /
//                               worker/.dev.vars.example).
//   R2_ACCESS_KEY_ID            R2 S3 API token access key id
//                               (dashboard → R2 → Manage R2 API Tokens).
//   R2_SECRET_ACCESS_KEY        Matching secret access key (the token secret).
//   R2_BUCKET_NAME              Bucket to apply the policy to. Defaults to
//                               "libre-media", which MUST match the
//                               [[r2_buckets]].bucket_name in worker/wrangler.toml.
//
// SETUP (one time, from repo root)
//   npm install --save-dev @aws-sdk/client-s3
//
// RUN
//   # PowerShell
//   $env:R2_ACCOUNT_ID="..."; $env:R2_ACCESS_KEY_ID="..."; $env:R2_SECRET_ACCESS_KEY="..."
//   node scripts/set-r2-cors.mjs
//
//   # bash
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//     node scripts/set-r2-cors.mjs
//
// EXPECTED OUTPUT
//   [set-r2-cors] CORS policy applied to bucket "libre-media" (1 rule(s)) —
//   methods GET/HEAD from [https://libre.tv, http://localhost:5173].
//
// NOTES
//   - CORS rule propagation can take up to 30s (ARCHITECTURE.md §14.1).
//   - Only performs a single bucket-CORS write; it never touches objects or data.
//   - Remove http://localhost:5173 from r2-cors.json for production.
// ───────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutBucketCorsCommand } from "@aws-sdk/client-s3";

const HERE = dirname(fileURLToPath(import.meta.url));
// Default policy is the dev catalog (includes http://localhost:5173). For
// production, run with R2_CORS_FILE=r2-cors.production.json (no localhost).
const CORS_FILE = process.env.R2_CORS_FILE || resolve(HERE, "../r2-cors.json");

function fail(message) {
  console.error(`[set-r2-cors] error: ${message}`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (!value) fail(`missing environment variable ${name}`);
  return value;
}

async function main() {
  const accountId = required("R2_ACCOUNT_ID");
  const accessKeyId = required("R2_ACCESS_KEY_ID");
  const secretAccessKey = required("R2_SECRET_ACCESS_KEY");
  const bucketName = process.env.R2_BUCKET_NAME || "libre-media";

  let rules;
  try {
    rules = JSON.parse(readFileSync(CORS_FILE, "utf8"));
  } catch (err) {
    fail(`failed to parse ${CORS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(rules) || rules.length === 0) {
    fail(`${CORS_FILE} must contain a non-empty array of CORS rules`);
  }

  const client = new S3Client({
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    credentials: { accessKeyId, secretAccessKey },
  });

  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: { CORSRules: rules },
    }),
  );

  const origins = [...new Set(rules.flatMap((rule) => rule.AllowedOrigins ?? []))];
  const methods = [...new Set(rules.flatMap((rule) => rule.AllowedMethods ?? []))];
  console.log(
    `[set-r2-cors] CORS policy applied to bucket "${bucketName}" (${rules.length} rule(s)) — ` +
      `methods ${methods.join("/")} from [${origins.join(", ")}].`,
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));