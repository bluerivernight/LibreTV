// Libre — Live TV directory (free legal streams only).
// GET /api/live — channel list (official YouTube live embeds).

import type { Env } from "../env";
import { json, rateLimited } from "../util/http";

export async function handleLiveList(req: Request, env: Env): Promise<Response> {
  const limiter = env.API_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `live:${new URL(req.url).hostname}` });
    if (!success) return rateLimited();
  }

  try {
    const rows = await env.DB.prepare(
      "SELECT id, name, category, youtube_channel_id FROM live_channels ORDER BY sort, name"
    ).all<{ id: string; name: string; category: string; youtube_channel_id: string }>();
    return json(rows.results ?? []);
  } catch {
    // Pre-0004 DBs: empty directory, not 500.
    return json([]);
  }
}
