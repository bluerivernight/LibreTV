// Test helpers — D1/R2 seeding and an API client that drives the real Worker
// fetch handler (routing, CORS, auth, rate-limit degradation all exercised).
//
// Storage is isolated per test file, so each integration file seeds its own DB
// and R2 fixtures in `beforeAll`.

import { env as testEnv, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src";
import { parseSessionCookie } from "../src/util/sessions";
import migrationSql from "../migrations/0001_init.sql?raw";
import migration2Sql from "../migrations/0002_titles.sql?raw";
import migration3Sql from "../migrations/0003_review_urls.sql?raw";
import migration4Sql from "../migrations/0004_live.sql?raw";
import seedSql from "./fixtures/seed.sql?raw";
import { HLS_MASTER, HLS_MEDIA } from "./fixtures/hls";

/** Apply the D1 schema (§8) and load the demo/seed catalog. */
export async function seedDatabase(): Promise<void> {
  for (const stmt of splitSql(migrationSql)) await testEnv.DB.prepare(stmt).run();
  for (const stmt of splitSql(migration2Sql)) await testEnv.DB.prepare(stmt).run();
  // ALTER TABLE has no IF NOT EXISTS: tolerate replays on a shared test DB.
  for (const stmt of splitSql(migration3Sql)) {
    try {
      await testEnv.DB.prepare(stmt).run();
    } catch (err) {
      if (!String((err as Error)?.message ?? err).includes("duplicate column name")) throw err;
    }
  }
  for (const stmt of splitSql(migration4Sql)) await testEnv.DB.prepare(stmt).run();
  for (const stmt of splitSql(seedSql)) await testEnv.DB.prepare(stmt).run();
}

// workerd's D1 `exec` runs input line-by-line (each line = one-or-more complete
// statements) and has no comment handling, so multi-line statements and inline
// `--` comments both break. Instead we strip comments and split into individual
// statements ourselves, then run each via `prepare().run()`. The splitter is
// string-literal aware and keeps trigger bodies (`BEGIN ... ; ... END;`) intact.
function removeSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'") {
      out += c;
      i++;
      while (i < sql.length) {
        out += sql[i]!;
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1]!;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function wordAt(sql: string, i: number, word: string): boolean {
  if (sql.slice(i, i + word.length).toUpperCase() !== word) return false;
  const before = i === 0 ? " " : sql[i - 1]!;
  const after = sql[i + word.length] ?? " ";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

export function splitSql(sql: string): string[] {
  const s = removeSqlComments(sql);
  const stmts: string[] = [];
  let buf = "";
  let i = 0;
  let inStr = false;
  let triggerDepth = 0;
  const isTrigger = () => /^\s*CREATE\s+TRIGGER/i.test(buf);
  while (i < s.length) {
    const c = s[i]!;
    if (inStr) {
      buf += c;
      if (c === "'") {
        if (s[i + 1] === "'") {
          buf += s[i + 1]!;
          i += 2;
          continue;
        }
        inStr = false;
      }
      i++;
      continue;
    }
    if (c === "'") {
      inStr = true;
      buf += c;
      i++;
      continue;
    }
    if (isTrigger()) {
      if (wordAt(s, i, "BEGIN")) {
        triggerDepth++;
        buf += s.slice(i, i + 5);
        i += 5;
        continue;
      }
      if (wordAt(s, i, "END")) {
        if (triggerDepth > 0) triggerDepth--;
        buf += s.slice(i, i + 3);
        i += 3;
        continue;
      }
    }
    if (c === ";") {
      buf += c;
      if (!(isTrigger() && triggerDepth > 0)) {
        if (buf.trim()) stmts.push(buf.trim());
        buf = "";
      }
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) stmts.push(buf.trim());
  return stmts;
}

/** Create the R2 objects (§9.1) referenced by the seeded asset rows. */
export async function seedR2(): Promise<void> {
  const objects: Array<[string, string]> = [
    ["media/bbb01/master.m3u8", HLS_MASTER],
    ["media/bbb01/720p/playlist.m3u8", HLS_MEDIA],
    ["media/bbb01/480p/playlist.m3u8", HLS_MEDIA],
    ["media/bbb02/master.m3u8", HLS_MASTER],
    ["media/bbb02/720p/playlist.m3u8", HLS_MEDIA],
  ];
  for (const [key, body] of objects) await testEnv.MEDIA_BUCKET.put(key, body);
}

export interface ApiOptions {
  cookie?: string;
  origin?: string;
  body?: unknown;
  headers?: Record<string, string>;
  baseUrl?: string;
}

/** Issue a request through the Worker's real fetch handler. */
export async function api(method: string, path: string, opts: ApiOptions = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (opts.origin) headers.set("Origin", opts.origin);
  if (opts.cookie) headers.set("Cookie", opts.cookie);

  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(opts.body);
  }

  const req = new Request(`${opts.baseUrl ?? "http://test.local"}${path}`, init);
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Login as the demo user and return a Cookie header value (`lbtv_session=<token>`). */
export async function demoSessionToken(): Promise<string> {
  const login = await api("POST", "/api/auth/login", {
    body: { email: "demo@libre.tv", password: "demo-pass-2026" },
  });
  if (login.status !== 200) throw new Error(`demo login failed (${login.status})`);
  const setCookie = login.headers.get("Set-Cookie");
  if (!setCookie) throw new Error("demo login returned no Set-Cookie header");
  const token = parseSessionCookie(setCookie);
  if (!token) throw new Error("demo login cookie did not contain a session token");
  return `lbtv_session=${token}`;
}