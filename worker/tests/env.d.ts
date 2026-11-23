import type { Env as LibreEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    // Augment the (otherwise empty) `Cloudflare.Env` interface so the bindings
    // exposed by the Workers Vitest integration (`cloudflare:test` env) are typed
    // as the real Libre `Env`. This mirrors what `wrangler types` would generate.
    interface Env extends LibreEnv {}
  }
}

export {};