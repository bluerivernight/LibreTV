// Libre — seed local R2 with dummy HLS fixtures.
//
// Uploads the exact object keys that worker/tests/fixtures/seed.sql references
// (§9.1 canonical storage_key), plus a dummy .ts segment per rendition, so a
// local `wrangler dev` can serve a real master manifest.
//
// Local dev reality check: Miniflare's local R2 exposes NO S3-compatible
// endpoint — `wrangler dev` only talks to a namespaced view of the local
// bucket, and the S3 API is only reachable through the explorer UI. So the
// default (and only universally correct) local path is the wrangler CLI:
//
//   node scripts/seed-local-r2.mjs
//
// The `--endpoint` mode uses @aws-sdk/client-s3 against a REAL S3-compatible
// endpoint (Cloudflare R2, MinIO, ...). It fails fast if the SDK is missing or
// no credentials are provided. It is NOT suitable for pointing at a running
// local `wrangler dev` because that process has no S3 API.
//
//   $env:R2_ACCOUNT_ID="..."; $env:R2_ACCESS_KEY_ID="...";
//   $env:R2_SECRET_ACCESS_KEY="...";
//   node scripts/seed-local-r2.mjs --endpoint https://<account>.r2.cloudflarestorage.com

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(ROOT, "worker");
const WRANGLER_JS = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

const BUCKET = "libre-media";

const MASTER_M3U8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
480p/playlist.m3u8
`;

const MEDIA_M3U8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
seg000.ts
#EXTINF:2.0,
seg001.ts
#EXT-X-ENDLIST
`;

// Minimal dummy transport stream: 1024 bytes of 0x47 sync pattern.
const DUMMY_TS = Buffer.alloc(1024, 0x47);

// storage_key -> content. Mirrors seed.sql asset rows.
const OBJECTS = [
  { key: "media/bbb01/master.m3u8", type: "application/vnd.apple.mpegurl", body: MASTER_M3U8 },
  { key: "media/bbb01/720p/playlist.m3u8", type: "application/vnd.apple.mpegurl", body: MEDIA_M3U8 },
  { key: "media/bbb01/480p/playlist.m3u8", type: "application/vnd.apple.mpegurl", body: MEDIA_M3U8 },
  { key: "media/bbb01/720p/seg000.ts", type: "video/mp2t", body: DUMMY_TS },
  { key: "media/bbb01/480p/seg000.ts", type: "video/mp2t", body: DUMMY_TS },
  { key: "media/bbb02/master.m3u8", type: "application/vnd.apple.mpegurl", body: MASTER_M3U8 },
  { key: "media/bbb02/720p/playlist.m3u8", type: "application/vnd.apple.mpegurl", body: MEDIA_M3U8 },
  { key: "media/bbb02/720p/seg000.ts", type: "video/mp2t", body: DUMMY_TS },
  { key: "media/gated01/master.m3u8", type: "application/vnd.apple.mpegurl", body: MASTER_M3U8 },
  { key: "media/gated01/720p/playlist.m3u8", type: "application/vnd.apple.mpegurl", body: MEDIA_M3U8 },
  { key: "media/gated01/720p/seg000.ts", type: "video/mp2t", body: DUMMY_TS },
];

// -- local mode (wrangler CLI, Miniflare R2) ----------------------------------

async function uploadLocal() {
  const tmp = mkdtempSync(join(tmpdir(), "libre-r2-"));
  try {
    for (const obj of OBJECTS) {
      const file = join(tmp, obj.key.replaceAll("/", "__"));
      writeFileSync(file, obj.body);
      const res = spawnSync(
        process.execPath,
        [WRANGLER_JS, "r2", "object", "put", `${BUCKET}/${obj.key}`,
         "--file", file, "--local", "--content-type", obj.type],
        { cwd: WORKER_DIR, encoding: "utf8" },
      );
      if (res.status !== 0) {
        throw new Error(`wrangler put ${obj.key} failed:\n${res.stdout}\n${res.stderr}`);
      }
      console.log(`local r2  ${obj.key}`);
    }
    console.log(`\nBucket "${BUCKET}" seeded (local Miniflare R2, ${OBJECTS.length} objects).`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// -- endpoint mode (@aws-sdk/client-s3 against a real endpoint) ---------------

async function uploadS3(endpoint) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("--endpoint mode needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY env vars");
  }

  let S3;
  try {
    ({ S3 } = await import("@aws-sdk/client-s3"));
  } catch {
    throw new Error("npm install -D @aws-sdk/client-s3 (only needed for --endpoint mode)");
  }

  const s3 = new S3({
    endpoint,
    region: "auto",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  for (const obj of OBJECTS) {
    await s3.putObject({
      Bucket: BUCKET,
      Key: obj.key,
      Body: obj.body,
      ContentType: obj.type,
    });
    console.log(`s3 put     ${obj.key}`);
  }
  console.log(`\nBucket "${BUCKET}" seeded via ${endpoint} (${OBJECTS.length} objects).`);
}

// -- main ---------------------------------------------------------------------

const endpointArg = process.argv.indexOf("--endpoint");
const endpoint = endpointArg >= 0 ? process.argv[endpointArg + 1] : null;

if (endpoint) {
  uploadS3(endpoint).catch((err) => {
    console.error(`\nseed-local-r2: ${err.message}`);
    process.exit(1);
  });
} else {
  uploadLocal().catch((err) => {
    console.error(`\nseed-local-r2: ${err.message}`);
    process.exit(1);
  });
}