// Libre — minimal native-fetch router.
// §5 API surface: pure fetch handler. No framework dependencies.
// Route matching uses URLPattern (Workers runtime native) — no express/fastify/etc.

type Handler = (req: Request, env: any, ctx: ExecutionContext, match: URLPatternResult) => Promise<Response>;

interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

export function createRouter(): {
  route(method: string, path: string, handler: Handler): void;
  handle(req: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
} {
  const routes: Route[] = [];

  function route(method: string, path: string, handler: Handler): void {
    routes.push({ method: method.toUpperCase(), pattern: new URLPattern({ pathname: path }), handler });
  }

  async function handle(req: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    for (const r of routes) {
      if (r.method !== method && r.method !== "*") continue;
      const match = r.pattern.exec(url.toString());
      if (match) {
        try {
          return await r.handler(req, env, ctx, match);
        } catch (err) {
          console.error(`[router] unhandled error in ${method} ${url.pathname}:`, err);
          return new Response(JSON.stringify({ error: { code: "internal_error", message: "unhandled route error" } }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
      }
    }

    return new Response(JSON.stringify({ error: { code: "not_found", message: "route not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  return { route, handle };
}

/** Helper — extract named pattern group from match. */
export function param(match: URLPatternResult, name: string): string {
  return (match.pathname.groups[name] as string | undefined) ?? "";
}

/** Helper — extract URL search param. */
export function searchParam(req: Request, name: string): string | null {
  return new URL(req.url).searchParams.get(name);
}