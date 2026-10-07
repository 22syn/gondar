#!/usr/bin/env python3
"""Catch-rate check for a candidate GONDAR "AVWAP" signal (2026-10-06, branch claude/avwap-anchor-psychology-07f845).

Question (Kobi): can an AVWAP signal go into GONDAR, and does it CATCH several good cases (SPCX among them)?
Earlier studies (see docs/research/avwap-reclaim-and-overhead-supply-2026-10-06.md) found no typical-trade
edge, so this measures what a *watch-tag* would actually do: recall of monster runs, precision, SPCX.

PRE-REGISTERED SPEC (frozen before the 4y run; no iteration after seeing results)
  Anchor    ATH = highest HIGH in the trailing min(252, available) sessions; AVWAP = sum(typ*vol)/sum(vol) from it.
            Panel tickers: first 251 sessions are burn-in (as in the earlier studies). SPCX: valid from its IPO.
  S1        reclaim: >=60 consecutive closes below AVWAP, then a close >= AVWAP, RVOL >= 2        (spec "V1")
  S2        confirmed reclaim: S1's cross, then first close >= 1.05*AVWAP within 10 sessions, RVOL >= 2 ("V3")
  S4        base-on-the-level breakout (designed AFTER studying SPCX, so SPCX is a design example, not evidence;
            round numbers, one shot): >=75% of the previous 30 closes within [0.93, 1.07] x AVWAP, AND close >=
            1.05 x AVWAP AND close > max(previous 30 closes) AND RVOL >= 1.5.
  RVOL      vol / mean(prior 63 sessions), as the engine.   Cooldown: 21 sessions per ticker per signal.
  Good case "monster episode": a day with fwd63 >= +50%; consecutive such days per ticker (gap <= 21) form one
            episode starting at its first day. Caught = a signal within [start-10, start+21] sessions.
  Metrics   n, tickers; precision = share of signals with fwd63 >= +50% (base = all ticker-days, and same-date
            same-RS-decile peers); median / mean fwd63; recall of episodes vs the recall a random placement with
            the same daily fire-rate would get, 1-(1-p)^32. SPCX evaluated on its own 79 sessions.
  Data      replay-4y.sqlite, same QA rule (drop tickers with a day > +300% or < -80%).
"""
import json
import sqlite3
import sys

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

DB = "/Users/kobihazout/dev/smart-volume-radar-engine/results/research/replay-4y.sqlite"
SPCX = sys.argv[2] if len(sys.argv) > 2 else None
OUT = sys.argv[1] if len(sys.argv) > 1 else "avwap-catch-rate.json"
WIN, RVOL_WIN, COOLDOWN, MONSTER = 252, 63, 21, 0.5
EP_GAP, PRE, POST = 21, 10, 21
SIGNALS = ("S1", "S2", "S4")


def ratio_series(h, lo, c, v, min_hist):
    n = len(c)
    tp = (h + lo + c) / 3
    cpv = np.concatenate([[0], np.cumsum(tp * v)])
    cv = np.concatenate([[0], np.cumsum(v)])
    ratio = np.full(n, np.nan)
    for t in range(min_hist - 1, n):
        s = max(0, t - WIN + 1)
        a = s + int(np.argmax(h[s:t + 1]))
        den = cv[t + 1] - cv[a]
        if den > 0:
            ratio[t] = c[t] / ((cpv[t + 1] - cpv[a]) / den)
    return ratio


def rvol_series(v):
    n = len(v)
    cv = np.concatenate([[0], np.cumsum(v)])
    out = np.full(n, np.nan)
    m = (cv[RVOL_WIN:n] - cv[0:n - RVOL_WIN]) / RVOL_WIN
    out[RVOL_WIN:] = np.where(m > 0, v[RVOL_WIN:] / np.where(m > 0, m, 1), np.nan)
    return out


def cooldown(flags):
    keep = np.zeros(len(flags), dtype=bool)
    last = -10**9
    for i in np.where(flags)[0]:
        if i - last >= COOLDOWN:
            keep[i] = True
            last = i
    return keep


def signals_for(h, lo, c, v, min_hist):
    n = len(c)
    ratio = ratio_series(h, lo, c, v, min_hist)
    rv = rvol_series(v)
    valid = ~np.isnan(ratio)
    below = valid & (ratio < 1)
    nb = np.zeros(n, dtype=int)
    for i in range(n):
        nb[i] = nb[i - 1] + 1 if (below[i] and i) else (1 if below[i] else 0)
    nb_prev = np.concatenate([[0], nb[:-1]])
    cross = valid & (ratio >= 1) & (nb_prev >= 60)
    s1 = cross & (rv >= 2)
    s2 = np.zeros(n, dtype=bool)
    for c0 in np.where(cross)[0]:
        for t in range(c0, min(c0 + 10, n - 1) + 1):
            if ratio[t] >= 1.05:
                s2[t] = rv[t] >= 2
                break
    inband = (valid & (ratio >= 0.93) & (ratio <= 1.07)).astype(float)
    cs = np.concatenate([[0], np.cumsum(inband)])
    frac = np.full(n, np.nan)
    frac[30:] = (cs[30:n] - cs[0:n - 30]) / 30
    prev_max = np.full(n, np.nan)
    prev_max[30:] = sliding_window_view(c, 30).max(axis=1)[:n - 30]
    s4 = valid & (frac >= 0.75) & (ratio >= 1.05) & (c > prev_max) & (rv >= 1.5)
    return {"S1": cooldown(s1), "S2": cooldown(s2), "S4": cooldown(s4)}, ratio, rv


def process(ticker, g):
    g = g.sort_values("date")
    h, lo, c, v = (g[k].values.astype(float) for k in ("high", "low", "close", "volume"))
    n = len(c)
    if n < WIN + RVOL_WIN + 5:
        return None
    v = np.clip(np.nan_to_num(v), 0, None)
    sig, ratio, _ = signals_for(h, lo, c, v, WIN)
    fwd = np.full(n, np.nan)
    fwd[:-63] = c[63:] / c[:-63] - 1
    r126 = np.full(n, np.nan)
    r126[126:] = c[126:] / c[:-126] - 1
    return pd.DataFrame({"ticker": ticker, "date": g.date.values, "i": np.arange(n), "fwd63": fwd, "ret126": r126,
                         "valid": ~np.isnan(ratio), **sig})


def episodes(P):
    rows = []
    for t, g in P[P.fwd63 >= MONSTER].groupby("ticker"):
        idx = g.i.values
        starts = idx[np.concatenate([[True], np.diff(idx) > EP_GAP])]
        rows += [(t, int(s)) for s in starts]
    return rows


def evaluate(P):
    P["rsdec"] = (P.groupby("date").ret126.rank(pct=True) * 10).clip(upper=9.999).fillna(-1).astype(int)
    P["mon"] = (P.fwd63 >= MONSTER).astype(float).where(P.fwd63.notna())
    g = P.groupby(["date", "rsdec"]).mon
    P["peer_s"], P["peer_n"] = g.transform("sum"), g.transform("count")
    base = float(P.mon.mean() * 100)
    eps = episodes(P)
    by_t = {t: g for t, g in P.groupby("ticker")}
    res = {"base_monster_pct": base, "n_episodes": len(eps), "signals": {}}
    for s in SIGNALS:
        ev = P[P[s] & P.fwd63.notna()]
        peer = np.where(ev.peer_n > 1, (ev.peer_s - ev.mon) / (ev.peer_n - 1), np.nan)
        p_fire = P[s].sum() / max(1, P.valid.sum())
        caught, names = 0, []
        for t, st in eps:
            g_t = by_t[t]
            hit = g_t[(g_t.i >= st - PRE) & (g_t.i <= st + POST) & g_t[s]]
            if len(hit):
                caught += 1
                names.append((t, g_t[g_t.i == st].date.iloc[0], float(g_t[g_t.i == st].fwd63.iloc[0] * 100)))
        rand = 1 - (1 - p_fire) ** (PRE + POST + 1)
        res["signals"][s] = {
            "n": int(P[s].sum()), "n_with_fwd": int(len(ev)), "tickers": int(P[P[s]].ticker.nunique()),
            "precision_pct": float(ev.mon.mean() * 100) if len(ev) else None,
            "peer_precision_pct": float(np.nanmean(peer) * 100) if len(ev) else None,
            "median_fwd63": float(ev.fwd63.median() * 100) if len(ev) else None,
            "mean_fwd63": float(ev.fwd63.mean() * 100) if len(ev) else None,
            "recall_pct": 100 * caught / max(1, len(eps)), "random_recall_pct": 100 * rand,
            "caught_top": sorted(names, key=lambda x: -x[2])[:12],
        }
    return res


def spcx_check(path):
    d = json.load(open(path))
    h, lo, c, v = (np.array([b[k] for b in d], float) for k in ("h", "l", "c", "v"))
    dates = [b["d"] for b in d]
    sig, ratio, rv = signals_for(h, lo, c, v, 1)  # ratio is valid from the IPO; only RVOL needs 63 sessions
    out = {s: [dates[i] for i in np.where(sig[s])[0]] for s in SIGNALS}
    out["ratio_last10"] = [(dates[i], round(float(ratio[i]), 3), round(float(rv[i]), 2)) for i in range(len(d) - 10, len(d))]
    return out


def main():
    con = sqlite3.connect("file:" + DB + "?mode=ro", uri=True)
    df = pd.read_sql("select ticker,date,open,high,low,close,volume from bars order by ticker,date", con)
    ret = df.groupby("ticker").close.pct_change()
    df = df[~df.ticker.isin(set(df.ticker[(ret > 3.0) | (ret < -0.8)]))]
    P = pd.concat([r for t, g in df.groupby("ticker") if (r := process(t, g)) is not None], ignore_index=True)
    res = evaluate(P)
    if SPCX:
        res["spcx"] = spcx_check(SPCX)
    json.dump(res, open(OUT, "w"), indent=1, default=str)
    P.to_pickle(OUT.replace(".json", "-panel.pkl"))
    print("saved", OUT)


if __name__ == "__main__":
    main()
