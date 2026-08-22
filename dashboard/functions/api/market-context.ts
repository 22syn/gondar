// dashboard/functions/api/market-context.ts
//
// The market_context series — six market-wide gauges plus Williams %R for SPY
// and QQQ, written once per trading day by the Lean pipeline
// (src/utils/marketContextD1Ingest.ts on `stable`).
//
// Read-only and parameterless: there is no user input to inject with. The table
// may not exist until the first ingest, so any error degrades to an empty
// series and the panel simply stays hidden — same contract as /api/fragility.
import { buildMarketContextQuery } from '../../src/query.js';
import { enrichMarketContext, type MarketContextRow } from '../../src/marketContext.js';

interface Env { DB: D1Database; }

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    const q = buildMarketContextQuery({});
    const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<MarketContextRow>();
    const rows = results ?? [];
    if (rows.length === 0) return Response.json(rows);
    return Response.json(enrichMarketContext(rows));
  } catch {
    // market_context not created yet — the panel stays hidden.
    return Response.json([]);
  }
};
