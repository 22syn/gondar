// dashboard/functions/api/summary.ts
import { buildSummaryQuery, buildSetupSummaryQuery, buildRsSummaryQuery } from '../../src/query.js';
import { mergeSummary, type SetupSummaryRow, type RsSummaryRow } from '../../src/mergeSetup.js';

interface Env { DB: D1Database; }

interface SummaryRow {
  scan_date: string; total?: number; setup_full?: number; setup_other?: number;
  rs80?: number; rs90?: number; [k: string]: unknown;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const q = buildSummaryQuery({});
  const { results } = await env.DB.prepare(q.sql).bind(...q.params).all<SummaryRow>();
  let rows = (results ?? []) as SummaryRow[];

  // Per-date counts from the Smart pipeline's own tables. Each is queried
  // separately so a missing setup_signals table cannot also suppress the RS
  // counts — the two failed together before, which is part of why the stale
  // rs90 went unnoticed for three weeks.
  let setupSummary: SetupSummaryRow[] = [];
  let rsSummary: RsSummaryRow[] = [];

  try {
    const sq = buildSetupSummaryQuery();
    const setup = await env.DB.prepare(sq.sql).bind(...sq.params).all<SetupSummaryRow>();
    setupSummary = (setup.results ?? []) as SetupSummaryRow[];
  } catch {
    // no setup_signals yet — lean summary alone is correct for setup counts.
  }

  try {
    const rq = buildRsSummaryQuery();
    const rs = await env.DB.prepare(rq.sql).bind(...rq.params).all<RsSummaryRow>();
    rsSummary = (rs.results ?? []) as RsSummaryRow[];
  } catch {
    // no rs_daily/setup_signals yet — leave the lean rs columns as they are.
  }

  rows = mergeSummary(rows, setupSummary, rsSummary);

  return Response.json(rows);
};
