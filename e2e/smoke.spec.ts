import { test, expect } from "@playwright/test";

// Origins come from the config baseURL (default local Vite) and
// E2E_API_ORIGIN (default local wrangler dev). Point both at the deployed
// HTTPS URLs to run the same smoke against staging/production.
function envOrigins(baseURL: string | undefined): { app: string; api: string } {
  const app = baseURL ?? "http://localhost:5173";
  const api = process.env.E2E_API_ORIGIN ?? "http://localhost:8787";
  return { app, api };
}

// Smoke: authenticated SPA loads, searches the Worker→D1 catalog, clicks an
// episode result, mounts the player, and HLS.js pulls the master manifest from
// the Worker→R2. Also asserts the lbtv_session cookie set by the Worker API
// persists for the app origin (over HTTPS in staging/production). Segment and
// rendition requests are presigned (Model B) and not asserted here.
test("login → session cookie persists → search → click result → player loads HLS master", async ({
  page,
  baseURL,
}) => {
  const { app, api } = envOrigins(baseURL);
  const isHttps = api.startsWith("https://");
  const cookieDomain = new URL(api).hostname;

  // (b) login via the Worker API and capture the session token.
  // The Worker sets lbtv_session as Secure/HttpOnly/SameSite=Lax. On http://,
  // localhost is a trustworthy origin and the cookie is accepted; the token is
  // injected explicitly to keep the flow deterministic in both environments.
  const login = await page.request.post(`${api}/api/v1/auth/login`, {
    data: { email: "demo@libre.tv", password: "demo-pass-2026" },
  });
  expect(login.ok()).toBeTruthy();
  const setCookie = login.headers()["set-cookie"] ?? "";
  const match = /lbtv_session=([^;]+)/.exec(setCookie);
  expect(match).not.toBeNull();
  const token = match![1]!;

  await page.context().addCookies([
    { name: "lbtv_session", value: token, domain: cookieDomain, path: "/", httpOnly: true, sameSite: "Lax" },
  ]);

  // (a) SPA home loads.
  await page.goto(app);
  await expect(page.getByTestId("catalog-list")).toBeVisible();

  // Session cookie persisted across the boundary for the app origin's host.
  const sessionCookie = (await page.context().cookies(app)).find((c) => c.name === "lbtv_session");
  expect(sessionCookie).toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);
  if (isHttps) expect(sessionCookie?.secure).toBe(true);

  // (a2) Search lives on its own /search route (full tab, like the references).
  await page.goto(`${app}/search`);
  const searchInput = page.getByTestId("search-input");
  await expect(searchInput).toBeVisible();

  // (c) perform a search against the Worker → D1.
  await searchInput.fill("Sintel Trailer");
  await page.getByTestId("search-button").click();
  const results = page.getByTestId("result-item");
  await expect(results.first()).toBeVisible();

  // (d) attach the master-manifest watcher BEFORE clicking, then click result.
  const masterRequest = page.waitForRequest(
    (req) => req.url().includes("/api/v1/playback/") && req.method() === "GET",
  );
  await results.first().click();

  // Clicking a result opens the cinematic title page; Watch now opens the
  // dedicated watch theater (dulo-style /watch/<kind>/<id> URL).
  await expect(page.getByTestId("title-detail")).toBeVisible();
  await page.getByTestId("title-watch-now").click();
  await expect(page).toHaveURL(/\/watch\//);

  // VideoPlayer mounts.
  await expect(page.locator('video[data-testid="video-player"]')).toBeVisible();

  // HLS.js loads the master manifest from Worker→R2.
  const req = await masterRequest;
  expect(req.url()).toContain("/api/v1/playback/ast_bbb_01_master");
  const res = await req.response();
  expect(res?.status()).toBe(200);
  const body = await res!.text();
  expect(body).toContain("#EXTM3U");
  expect(body).toContain("?var=720p");
});