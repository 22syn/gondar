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

export const onRequestGet: PagesFunction = async () => {
  try {
    const res = await fetch(TV_STATE_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const state = (await res.json()) as TvState;
    return Response.json(state);
  } catch {
    // main branch unreachable / file missing — panel just shows "no data".
    return Response.json({ updatedAt: null, watchlists: {} } satisfies TvState);
  }
};
