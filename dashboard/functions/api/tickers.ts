// dashboard/functions/api/tickers.ts
//
// GET /api/tickers — every ticker that ever appeared in a scan, with its
// appearance count and last-seen date. Feeds the search box's autocomplete so
// a name that is NOT in today's scan is still typeable and findable.
//
// The universe is a few hundred names and only grows by the day's new signals,
// so this is cached for an hour rather than recomputed per keystroke.
import { buildTickerListQuery } from '../../src/query.js';

interface Env { DB: D1Database; }

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const q = buildTickerListQuery();
  const { results } = await env.DB.prepare(q.sql).all<{ ticker: string; appearances: number; last_seen: string }>();
  return Response.json(results ?? [], {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
};
