import { defineConfig } from "@playwright/test";

// Libre smoke tests.
//
// Local mode (default): boots wrangler dev (Worker API, 8787) + Vite (SPA, 5173)
// as webServers. Requires worker/.wrangler state first (migrate + seed +
// seed-local-r2.mjs).
//
// Staging/production mode: point the env vars at the deployed URLs; webServers
// are then skipped and the same spec runs against real HTTPS infrastructure.
//   $env:E2E_APP_ORIGIN="https://libre.tv"; $env:E2E_API_ORIGIN="https://libre.tv"
//   npx playwright test
const LOCAL_APP = "http://localhost:5173";
const LOCAL_API = "http://localhost:8787";

const APP_ORIGIN = process.env.E2E_APP_ORIGIN ?? LOCAL_APP;
const API_ORIGIN = process.env.E2E_API_ORIGIN ?? LOCAL_API;
const LOCAL_MODE = APP_ORIGIN === LOCAL_APP && API_ORIGIN === LOCAL_API;

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: APP_ORIGIN,
    trace: "retain-on-failure",
  },
  webServer: LOCAL_MODE
    ? [
        {
          command: "npm run dev",
          cwd: `${__dirname}/../worker`,
          url: `${LOCAL_API}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "npm run dev",
          cwd: `${__dirname}/../libretv-web`,
          url: LOCAL_APP,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ]
    : [],
});