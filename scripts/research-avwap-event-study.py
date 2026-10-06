#!/usr/bin/env python3
"""AVWAP reclaim event study (2026-10-06, branch claude/avwap-anchor-psychology-07f845).

Question: does price reclaiming an anchored VWAP after a long stretch below it carry forward
information (the "breakeven supply absorbed" thesis)? Tested as an EVENT, not a state — the
earlier above/below study (albert-criteria-study.json `above_AVWAP_from_peak`) was a state test.

PRE-REGISTERED SPEC (fixed before any outcome was inspected)
  Data      replay-4y.sqlite (598 tickers, 2022-08-08..2026-08-07). QA rule: drop any ticker with a
            single-day move > +300% or < -80% (agorot/scale breaks, e.g. *.TA on 2026-05-18).
  Anchors   ATH = day of the highest HIGH in the trailing 252 sessions (52w-high proxy; data is 4y only)
            YTD = first session of the calendar year (2023+ only; 2022 has no Jan bars)
            GAP = engine's detectEarningsGap (open > prevHigh*1.03, lookback 60, most recent gap)
  AVWAP     sum(typical*vol)/sum(vol) from anchor..t inclusive, typical=(h+l+c)/3 (= calculateAVWAP).
  Below     close < AVWAP(t) using each day's own anchor; N consecutive sessions: ATH 60, YTD 60,
            GAP 20 (60 is impossible inside a 60-session gap window — declared deviation).
  Cross     first close >= AVWAP after >= N below  (V0)
  V1        cross day with RVOL >= 2   (RVOL = vol / mean(prior 63 sessions), as the engine)
  V2        first close >= 1.05*AVWAP within 10 sessions after a qualifying cross (confirmation)
  V3        V2 trigger day with RVOL >= 2
  Outcome   close(t+21)/close(t)-1 and close(t+63)/close(t)-1; entry at the event-day close.
  Control A same date, same RS decile (126d-return percentile across the universe), event ticker excluded.
  Control B V0/V1: same date, stocks in the same long-below state that did NOT cross.
            V2/V3: same date, stocks crossed within 10 sessions and not (yet) confirmed.
  Stats     win%, median, mean excess vs control, 95% CI via month-cluster bootstrap (2000 resamples).
  Primary   ATH x {V1, V3}. Everything else is exploratory (12 cells x 2 horizons = 24 looks).
  Placebo   ATH with unweighted (TWAP) average instead of VWAP: tests whether volume weighting matters.
  Rule      n < 100 events => no conclusion.

PRE-REGISTERED ADDENDUM — ATL anchor (written 2026-10-06 before the ATL run; `python3 ... out.json atl`)
  Anchor    ATL = day of the lowest LOW in the trailing 252 sessions (52w-low proxy).
  Mirror    state = close >= AVWAP for >= 60 consecutive sessions ("everyone since the low is in profit");
            event = first close < AVWAP (breakdown). Bearish thesis: negative excess expected.
  V0..V3    as above, mirrored: V1 breakdown day with RVOL >= 2; V2 first close <= 0.95*AVWAP within 10
            sessions after a qualifying breakdown; V3 = V2 with RVOL >= 2.
  Controls  A as above. B: V0/V1 = same-date stocks still above after >= 60 sessions above (did not break);
            V2/V3 = broke within 10 sessions and not (yet) confirmed.
  Primary   ATL(breakdown) x VWAP x {V1, V3}. Exploratory: ATL reclaim (below >= 60 then cross up) and the
            unweighted-average placebo of the breakdown. 24 looks in this run.
  Extra     Reported for the primary cells: median excess, 90%-trimmed mean, top-5 share of total excess,
            by-year excess, left-tail rate (fwd63 <= -30%) vs base.
"""
import json
import sqlite3
import sys

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

DB = "/Users/kobihazout/dev/smart-volume-radar-engine/results/research/replay-4y.sqlite"
OUT = sys.argv[1] if len(sys.argv) > 1 else "avwap-event-study.json"
MODE = sys.argv[2] if len(sys.argv) > 2 else "ath"
ATH_WIN, RVOL_WIN, GAP_LB, GAP_PCT = 252, 63, 60, 3.0
N_BELOW = {"ATH": 60, "YTD": 60, "GAP": 20, "ATL": 60}
CONFIRM, CONF_WIN, RVOL_MIN = 1.05, 10, 2.0
HORIZONS = (21, 63)
# (anchor, weighting, direction): "up" = long below then reclaim; "dn" = long above then breakdown (mirror)
CELLS_ATH = [("ATH", "vw", "up"), ("YTD", "vw", "up"), ("GAP", "vw", "up"), ("ATH", "tw", "up")]
CELLS_ATL = [("ATL", "vw", "dn"), ("ATL", "vw", "up"), ("ATL", "tw", "dn")]
CELLS = CELLS_ATL if MODE == "atl" else CELLS_ATH
PRIMARY = ("ATL", "vw", "dn") if MODE == "atl" else ("ATH", "vw", "up")
RNG = np.random.default_rng(7)


def cell_key(X, kind, dirn):
    return f"{X}{'dn' if dirn == 'dn' else ''}_{kind}_"


def runlen(b):
    r = np.zeros(len(b), dtype=int)
    cnt = 0
    for i, x in enumerate(b):
        cnt = cnt + 1 if x else 0
        r[i] = cnt
    return r


def anchors(date, o, h, lo):
    n = len(h)
    a_ath = np.full(n, -1)
    a_atl = np.full(n, -1)
    if n >= ATH_WIN:
        win = sliding_window_view(h, ATH_WIN).argmax(axis=1)
        a_ath[ATH_WIN - 1:] = win + np.arange(n - ATH_WIN + 1)
        win_lo = sliding_window_view(lo, ATH_WIN).argmin(axis=1)
        a_atl[ATH_WIN - 1:] = win_lo + np.arange(n - ATH_WIN + 1)
    years = np.array([d[:4] for d in date])
    a_ytd = np.full(n, -1)
    for y in np.unique(years):
        first = int(np.argmax(years == y))
        if date[first][5:7] == "01" and int(date[first][8:10]) <= 6:
            a_ytd[years == y] = first
    gap = np.zeros(n, dtype=bool)
    gap[1:] = (h[:-1] > 0) & (o[1:] > h[:-1] * (1 + GAP_PCT / 100))
    last = np.maximum.accumulate(np.where(gap, np.arange(n), -1))
    a_gap = np.where((last >= 0) & (np.arange(n) - last < GAP_LB), last, -1)
    return {"ATH": a_ath, "ATL": a_atl, "YTD": a_ytd, "GAP": a_gap}


def process(ticker, g):
    g = g.sort_values("date")
    date = g.date.values
    o, h, lo, c, v = (g[k].values.astype(float) for k in ("open", "high", "low", "close", "volume"))
    n = len(c)
    if n < ATH_WIN + RVOL_WIN + 5:
        return None
    v = np.clip(np.nan_to_num(v), 0, None)
    tp = (h + lo + c) / 3
    cpv = np.concatenate([[0], np.cumsum(tp * v)])
    cv = np.concatenate([[0], np.cumsum(v)])
    ctp = np.concatenate([[0], np.cumsum(tp)])
    idx = np.arange(n)
    rvol = np.full(n, np.nan)
    m = (cv[RVOL_WIN:n] - cv[0:n - RVOL_WIN]) / RVOL_WIN
    rvol[RVOL_WIN:] = np.where(m > 0, v[RVOL_WIN:] / np.where(m > 0, m, 1), np.nan)
    out = {"ticker": np.full(n, ticker), "date": date, "c": c, "rvol": rvol}
    for hz in HORIZONS:
        f = np.full(n, np.nan)
        f[:-hz] = c[hz:] / c[:-hz] - 1
        out[f"fwd{hz}"] = f
    r126 = np.full(n, np.nan)
    r126[126:] = c[126:] / c[:-126] - 1
    out["ret126"] = r126
    out["maxjump"] = np.full(n, np.nanmax(np.abs(np.diff(c) / c[:-1])))
    anc = anchors(date, o, h, lo)
    for X, kind, dirn in CELLS:
        a = anc[X]
        ok = a >= 0
        aa = np.where(ok, a, 0)
        if kind == "vw":
            num, den = cpv[idx + 1] - cpv[aa], cv[idx + 1] - cv[aa]
        else:
            num, den = ctp[idx + 1] - ctp[aa], (idx - aa + 1).astype(float)
        with np.errstate(divide="ignore", invalid="ignore"):
            av = np.where(ok & (den > 0), num / den, np.nan)
        ratio = c / av
        valid = ~np.isnan(ratio)
        in_state = valid & (ratio < 1) if dirn == "up" else valid & (ratio >= 1)
        nb = runlen(in_state)
        nb_prev = np.concatenate([[0], nb[:-1]])
        N = N_BELOW[X]
        cross = valid & ~in_state & (nb_prev >= N)
        coh_b = in_state & (nb_prev >= N)
        conf = np.zeros(n, dtype=bool)
        coh_q = np.zeros(n, dtype=bool)
        for c0 in np.where(cross)[0]:
            for t in range(c0, min(c0 + CONF_WIN, n - 1) + 1):
                if (ratio[t] >= CONFIRM) if dirn == "up" else (ratio[t] <= 2 - CONFIRM):
                    conf[t] = True
                    break
                coh_q[t] = True
        hi = rvol >= RVOL_MIN
        p = cell_key(X, kind, dirn)
        out[p + "V0"], out[p + "V1"] = cross, cross & hi
        out[p + "V2"], out[p + "V3"] = conf, conf & hi
        out[p + "cohB"], out[p + "cohQ"] = coh_b, coh_q
    return pd.DataFrame(out)


def load():
    con = sqlite3.connect("file:" + DB + "?mode=ro", uri=True)
    df = pd.read_sql("select ticker,date,open,high,low,close,volume from bars order by ticker,date", con)
    ret = df.groupby("ticker").close.pct_change()
    bad = set(df.ticker[(ret > 3.0) | (ret < -0.8)])
    print(f"QA: dropping {len(bad)} tickers with scale/agorot breaks: {sorted(bad)[:12]}...")
    return df[~df.ticker.isin(bad)], len(bad)


def month_boot(vals, months, reps=2000):
    ok = ~np.isnan(vals)
    vals, months = vals[ok], months[ok]
    if len(vals) < 5:
        return np.nan, np.nan, np.nan, len(vals)
    u, inv = np.unique(months, return_inverse=True)
    s = np.bincount(inv, weights=vals)
    k = np.bincount(inv)
    boots = np.empty(reps)
    for i in range(reps):
        pick = RNG.integers(0, len(u), len(u))
        boots[i] = s[pick].sum() / k[pick].sum()
    return vals.mean(), *np.percentile(boots, [2.5, 97.5]), len(vals)


def main():
    df, ndrop = load()
    parts = []
    for t, g in df.groupby("ticker"):
        r = process(t, g)
        if r is not None:
            parts.append(r)
    P = pd.concat(parts, ignore_index=True)
    print(f"panel {len(P):,} rows, {P.ticker.nunique()} tickers")
    P["month"] = P.date.str[:7]
    P["rsdec"] = (P.groupby("date").ret126.rank(pct=True) * 10).clip(upper=9.999).fillna(-1).astype(int)
    res = {"n_tickers": int(P.ticker.nunique()), "dropped": ndrop, "cells": [], "base": {}}
    for hz in HORIZONS:
        f = P[f"fwd{hz}"].dropna()
        res["base"][hz] = {"n": int(len(f)), "win": float((f > 0).mean() * 100), "mean": float(f.mean() * 100),
                           "median": float(f.median() * 100)}
    for hz in HORIZONS:
        col = f"fwd{hz}"
        g = P.groupby(["date", "rsdec"])[col]
        P[f"sA{hz}"], P[f"nA{hz}"] = g.transform("sum"), g.transform("count")
    for X, kind, dirn in CELLS:
        for var in ("V0", "V1", "V2", "V3"):
            key = cell_key(X, kind, dirn)
            ev = P[P[f"{key}{var}"]]
            coh = key + ("cohB" if var in ("V0", "V1") else "cohQ")
            cohmean = {hz: P[P[coh]].groupby("date")[f"fwd{hz}"].agg(["mean", "count"]) for hz in HORIZONS}
            row = {"anchor": X, "kind": kind, "dir": dirn, "variant": var, "n_events": int(len(ev)),
                   "n_tickers": int(ev.ticker.nunique()), "by_year": {}}
            for hz in HORIZONS:
                col = f"fwd{hz}"
                own = ev[col]
                ctrlA = np.where(ev[f"nA{hz}"] > 1, (ev[f"sA{hz}"] - own.fillna(0)) / (ev[f"nA{hz}"] - own.notna()), np.nan)
                cm = cohmean[hz].reindex(ev.date)
                ctrlB = np.where(cm["count"].values >= 3, cm["mean"].values, np.nan)
                exA, exB = own.values - ctrlA, own.values - ctrlB
                mA = month_boot(exA, ev.month.values)
                mB = month_boot(exB, ev.month.values)
                w = own.dropna()
                row[str(hz)] = {
                    "n": int(len(w)), "win": float((w > 0).mean() * 100) if len(w) else None,
                    "down": float((w < 0).mean() * 100) if len(w) else None,
                    "median": float(w.median() * 100) if len(w) else None,
                    "mean": float(w.mean() * 100) if len(w) else None,
                    "excA": [None if np.isnan(x) else float(x * 100) for x in mA[:3]], "nA": int(mA[3]),
                    "excB": [None if np.isnan(x) else float(x * 100) for x in mB[:3]], "nB": int(mB[3]),
                }
                if var in ("V1", "V3") and (X, kind, dirn) == PRIMARY:
                    yy = pd.Series(exA, index=ev.index).groupby(ev.date.str[:4]).agg(["mean", "count"])
                    row["by_year"][str(hz)] = {y: [float(r["mean"] * 100), int(r["count"])] for y, r in yy.iterrows()
                                               if r["count"] > 0 and not np.isnan(r["mean"])}
            res["cells"].append(row)
    json.dump(res, open(OUT, "w"), indent=1)
    flag_cols = [c for c in P.columns if c.rsplit("_", 1)[-1] in ("V0", "V1", "V2", "V3")]
    P.loc[P[flag_cols].any(axis=1)].to_pickle(OUT.replace(".json", "-events.pkl"))
    print("saved", OUT)


if __name__ == "__main__":
    main()
