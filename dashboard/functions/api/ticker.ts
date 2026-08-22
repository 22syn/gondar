// dashboard/functions/api/ticker.ts
//
// GET /api/ticker?t=NVDA — one ticker, every scan day it ever appeared on.
//
// /api/signals answers "what fired on day X"; this answers "what happened to
// ticker T", which the dashboard could not ask before: its search box only
// filtered the day already on screen, so finding the last time a name fired
// meant clicking back through the calendar day by day.
import {
  buildTickerLeanQuery,
  buildTickerSetupQuery,
  buildTickerRsQuery,
  buildTickerLatestPriceQuery,
  buildTickerMatchQuery,
  buildAllScanDatesQuery,
} from '../../src/query.js';
import { mergeSetupRows, type SetupRowD1, type RsDailyRow } from '../../src/mergeSetup.js';
import { buildTickerHistory, normalizeTicker, type TickerRow } from '../../src/tickerHistory.js';

interface Env { DB: D1Database; }

interface MatchRow { ticker: string; appearances: number; last_seen: string }

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const ticker = normalizeTicker(url.searchParams.get('t') ?? '');
  if (!ticker) {
    return Response.json({ error: 'bad_ticker' }, { status: 400 });
  }

  const dq = buildAllScanDatesQuery();
  const dates = await env.DB.prepare(dq.sql).all<{ scan_date: string }>();
  const datesDesc = (dates.results ?? []).map((d) => d.scan_date);

  // Same wr14 guard as /api/signals: the column arrives with the first ingest,
  // so a deploy can land before it exists and SQLite fails the whole SELECT.
  let rows: TickerRow[];
  try {
    const lq = buildTickerLeanQuery(ticker);
    const lean = await env.DB.prepare(lq.sql).bind(...lq.params).all<TickerRow>();
    rows = (lean.results ?? []) as TickerRow[];
  } catch {
    const lq = buildTickerLeanQuery(ticker, false);
    const lean = await env.DB.prepare(lq.sql).bind(...lq.params).all<TickerRow>();
    rows = (lean.results ?? []) as TickerRow[];
  }

  // Same read-time merge /api/signals does — setup and RS live in their own
  // tables and may not exist yet. Treat a failure as "lean rows only".
  try {
    const sq = buildTickerSetupQuery(ticker);
    const setup = await env.DB.prepare(sq.sql).bind(...sq.params).all<SetupRowD1>();
    const rq = buildTickerRsQuery(ticker);
    const rs = await env.DB.prepare(rq.sql).bind(...rq.params).all<RsDailyRow>();
    rows = mergeSetupRows(rows, (setup.results ?? []) as SetupRowD1[], (rs.results ?? []) as RsDailyRow[]);
  } catch {
    // setup tables absent — the lean history is still correct on its own.
  }

  const history = buildTickerHistory(ticker, rows, datesDesc);

  // Nothing under that exact name: offer prefix matches so a partial or
  // mistyped query ("nvd", "teva" for TEVA.TA) still lands somewhere.
  let suggestions: MatchRow[] = [];
  if (history.total === 0) {
    const mq = buildTickerMatchQuery(ticker);
    const m = await env.DB.prepare(mq.sql).bind(...mq.params).all<MatchRow>();
    suggestions = (m.results ?? []).filter((r) => r.ticker !== ticker);
  }

  // Current price for the "since this signal" comparison. Its own query rather
  // than part of the merge above — see buildTickerLatestPriceQuery. Wrapped
  // because rs_daily.price only exists from 2026-08-17: on a database that has
  // not ingested since, the column is absent and this throws, which must not
  // take the whole history panel down with it.
  let latest_price: number | null = null;
  let latest_price_date: string | null = null;
  try {
    const pq = buildTickerLatestPriceQuery(ticker);
    const p = await env.DB.prepare(pq.sql).bind(...pq.params)
      .first<{ scan_date: string; price: number }>();
    if (p) {
      latest_price = p.price;
      latest_price_date = p.scan_date;
    }
  } catch {
    // Column not there yet — the panel shows "no current price" and the rest
    // of the history stays correct.
  }

  return Response.json({ ...history, latest_price, latest_price_date, suggestions });
};
