// dashboard/functions/api/signals.ts
import {
  buildSignalsQuery,
  buildRecentDatesQuery,
  buildHistoryRowsQuery,
  buildSetupRowsQuery,
  buildRsDailyQuery,
} from '../../src/query.js';
import { enrichRows, type HistoryRow } from '../../src/enrich.js';
import { mergeSetupRows, type SetupRowD1, type RsDailyRow } from '../../src/mergeSetup.js';

interface Env { DB: D1Database; }

interface DayRow { scan_date: string; ticker: string; score: number; signal: string; signals: string; signal_count: number; rs?: number | null; [k: string]: unknown; }

/** Accept only YYYY-MM-DD; anything else is treated as absent. */
const isIsoDate = (s: string | null): s is string => s != null && /^\d{4}-\d{2}-\d{2}$/.test(s);

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  // Validate the range at the boundary. Params are already bound (no SQL
  // injection), but an unvalidated, unbounded span like from=0000-01-01&
  // to=9999-12-31 would dump the whole table and enrich it — a one-request
  // CPU/D1 amplifier, and *.pages.dev bypasses Cloudflare Access. A malformed,
  // inverted, or too-wide range falls back to the default latest-day view; the
  // only real caller ever requests from===to (a single day).
  const rawFrom = url.searchParams.get('from');
  const rawTo = url.searchParams.get('to');
  let from: string | undefined;
  let to: string | undefined;
  if (isIsoDate(rawFrom) && isIsoDate(rawTo) && rawFrom <= rawTo) {
    const span = (Date.parse(rawTo) - Date.parse(rawFrom)) / 86_400_000;
    if (span <= 400) { from = rawFrom; to = rawTo; }
  }
  // wr14 may not exist yet — ensureSchema() adds it during ingest, so a deploy
  // can precede the column. Fall back to the legacy column list rather than
  // 500ing the whole signals table.
  let dayRows: DayRow[];
  try {
    const q = buildSignalsQuery({ from, to });
    const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<DayRow>();
    dayRows = (results ?? []) as DayRow[];
  } catch {
    const q = buildSignalsQuery({ from, to }, false);
    const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<DayRow>();
    dayRows = (results ?? []) as DayRow[];
  }

  // Read-time merge of the Smart pipeline's setup_signals + rs_daily tables.
  // They may not exist until the first Smart ingest runs — treat errors as empty.
  try {
    const sq = buildSetupRowsQuery({ from, to });
    const setup = await env.DB.prepare(sq.sql).bind(...sq.params).all<SetupRowD1>();
    const rq = buildRsDailyQuery({ from, to });
    const rs = await env.DB.prepare(rq.sql).bind(...rq.params).all<RsDailyRow>();
    dayRows = mergeSetupRows(dayRows, (setup.results ?? []) as SetupRowD1[], (rs.results ?? []) as RsDailyRow[]);
  } catch {
    // setup tables absent or query failed — lean rows alone are still correct.
  }

  if (dayRows.length === 0) return Response.json([]);

  try {
    // The dashboard's displayed rows are a single day; enrich against that day.
    const targetDate = dayRows.reduce((m, r) => (r.scan_date > m ? r.scan_date : m), dayRows[0].scan_date);

    const dq = buildRecentDatesQuery(targetDate, 12);
    const dates = await env.DB.prepare(dq.sql).bind(...dq.params).all<{ scan_date: string }>();
    const dateSeq = (dates.results ?? []).map((d) => d.scan_date);

    const hq = buildHistoryRowsQuery(dateSeq);
    const hist = await env.DB.prepare(hq.sql).bind(...hq.params).all<HistoryRow>();
    const historyRows = (hist.results ?? []) as HistoryRow[];

    return Response.json(enrichRows(dayRows, historyRows, dateSeq));
  } catch {
    // Resilient fallback: return un-enriched day rows if enrichment fails.
    return Response.json(dayRows);
  }
};
