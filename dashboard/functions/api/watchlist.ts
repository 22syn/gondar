// dashboard/functions/api/watchlist.ts
//
// Current TradingView watchlist contents (Lean Radar - Breakouts / Near) —
// read live from results/tv-state.json on the main branch of the (public)
// smart-volume-radar repo, written by tv-sync.yml after every sync. Lets the
// dashboard show what's actually on TradingView right now without opening it
// separately. No D1 involved — this is a different app/branch's data.
const TV_STATE_URL =
  'https://raw.githubusercontent.com/22syn/smart-volume-radar/main/results/tv-state.json';

interface TvStateEntry { ticker: string; signalDate: string; exchange?: string; }
interface TvState { updatedAt: string | null; watchlists: Record<string, TvStateEntry[]>; }

/**
 * Sanitize the upstream shape. tv-state.json lives on a DIFFERENT repo's main
 * branch, so it is outside this dashboard's trust boundary — a bad or hostile
 * value there must not become the dashboard's problem. The client escapes these
 * fields at render too; this is the defense-in-depth layer that drops anything
 * malformed before it is even served.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER = /^\^?[A-Za-z0-9.\-]{1,20}$/;

function sanitizeState(raw: unknown): TvState {
  const s = (raw ?? {}) as Partial<TvState>;
  const out: TvState['watchlists'] = {};
  const lists = (s.watchlists && typeof s.watchlists === 'object') ? s.watchlists : {};
  for (const [name, entries] of Object.entries(lists)) {
    if (!Array.isArray(entries)) continue;
    out[String(name).slice(0, 60)] = entries
      .filter((e): e is TvStateEntry =>
        !!e && typeof e.ticker === 'string' && TICKER.test(e.ticker) &&
        typeof e.signalDate === 'string' && ISO_DATE.test(e.signalDate))
      .map((e) => ({
        ticker: e.ticker,
        signalDate: e.signalDate,
        ...(typeof e.exchange === 'string' ? { exchange: e.exchange.slice(0, 20) } : {}),
      }));
  }
  return { updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : null, watchlists: out };
}

export const onRequestGet: PagesFunction = async () => {
  try {
    const res = await fetch(TV_STATE_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    return Response.json(sanitizeState(await res.json()));
  } catch {
    // main branch unreachable / file missing — panel just shows "no data".
    return Response.json({ updatedAt: null, watchlists: {} } satisfies TvState);
  }
};
