#!/usr/bin/env python3
"""Overhead-supply test (2026-10-06, branch claude/avwap-anchor-psychology-07f845).

Anchor-free version of the AVWAP "underwater holders" thesis: what share of the last 252 sessions' volume
traded ABOVE today's close? High overhead supply = many holders still underwater = (thesis) resistance.
Replaces the arbitrary anchor choice (Fromhertz's critique) with a continuous, parameter-light state.

PRE-REGISTERED SPEC (fixed before any outcome was inspected)
  Metric    OS_t = sum_i vol_i * share_of_bar_i_above(close_t) / sum_i vol_i over sessions t-251..t.
            Primary allocation: each bar's volume spread uniformly over [low, high]
            (share above = clip((high-close_t)/(high-low),0,1); zero-range bar: 1 if high>close_t else 0).
            Robustness only (no separate inference): all volume at typical price (h+l+c)/3.
  Data      replay-4y.sqlite, same QA rule as the AVWAP study (drop tickers with a day >+300% or <-80%).
  Controls  rank-pct per date of: RS = 126d return, DIST = close/max(high, 252) - 1, VOL = std of daily
            returns over 63 sessions. (OS is mechanically tied to nearness to the high and to volatility.)
  Primary   Fama-MacBeth, per date (>=100 stocks): rank(fwd63) ~ 1 + rank(OS) + rank(RS) + rank(DIST) + rank(VOL).
            Coefficient on rank(OS), Newey-West t (lag 63). Thesis sign: NEGATIVE.
            Counts as found only if |t| >= 3.0 (this is look ~50 across the whole AVWAP programme) AND
            same sign in >= 3 of the calendar years present.
  Secondary quintiles of OS within (date, RS tercile); per quintile mean/median fwd and excess vs the same
            date-and-tercile mean; Q5-Q1 spread (mean and median variants), month-cluster 95% CI;
            +50% / -30% outcome rates at 63d. Horizons 21d and 63d.
  Also      univariate Spearman IC per date. By-year coefficient table.
"""
import json
import sqlite3
import sys

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

DB = "/Users/kobihazout/dev/smart-volume-radar-engine/results/research/replay-4y.sqlite"
OUT = sys.argv[1] if len(sys.argv) > 1 else "overhead-supply.json"
WIN, VOL_WIN, MIN_XS, NW_LAG = 252, 63, 100, 63
HORIZONS = (21, 63)
RNG = np.random.default_rng(7)


def overhead(h, lo, c, v, mode):
    """OS for t = WIN-1..n-1 (vector of length n-WIN+1)."""
    hw, lw, vw = (sliding_window_view(x, WIN) for x in (h, lo, v))
    cc = c[WIN - 1:, None]
    if mode == "range":
        span = hw - lw
        with np.errstate(divide="ignore", invalid="ignore"):
            share = np.where(span > 0, np.clip((hw - cc) / np.where(span > 0, span, 1), 0, 1), (hw > cc).astype(float))
    else:
        share = (((hw + lw + sliding_window_view(c, WIN)) / 3) > cc).astype(float)
    tot = vw.sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(tot > 0, (share * vw).sum(axis=1) / tot, np.nan)


def process(ticker, g):
    g = g.sort_values("date")
    o_, h, lo, c, v = (g[k].values.astype(float) for k in ("open", "high", "low", "close", "volume"))
    n = len(c)
    if n < WIN + 70:
        return None
    v = np.clip(np.nan_to_num(v), 0, None)
    out = {k: np.full(n, np.nan) for k in ("os", "os_tp", "dist", "vol", "ret126", "fwd21", "fwd63")}
    out["os"][WIN - 1:] = overhead(h, lo, c, v, "range")
    out["os_tp"][WIN - 1:] = overhead(h, lo, c, v, "tp")
    out["dist"][WIN - 1:] = c[WIN - 1:] / sliding_window_view(h, WIN).max(axis=1) - 1
    r = np.diff(c) / c[:-1]
    rv = sliding_window_view(r, VOL_WIN).std(axis=1)
    out["vol"][VOL_WIN:] = rv
    out["ret126"][126:] = c[126:] / c[:-126] - 1
    for hz in HORIZONS:
        out[f"fwd{hz}"][:-hz] = c[hz:] / c[:-hz] - 1
    return pd.DataFrame({"ticker": ticker, "date": g.date.values, **out})


def nw_t(x, lags):
    x = np.asarray(x, float)
    x = x[~np.isnan(x)]
    t_ = len(x)
    if t_ < lags + 5:
        return float("nan"), float("nan"), t_
    d = x - x.mean()
    var = (d @ d) / t_
    for k in range(1, lags + 1):
        var += 2 * (1 - k / (lags + 1)) * (d[k:] @ d[:-k]) / t_
    se = np.sqrt(var / t_)
    return float(x.mean()), float(x.mean() / se), t_


def month_ci(series, reps=2000):
    s = series.dropna()
    if len(s) < 20:
        return [float("nan")] * 3
    m = s.groupby(s.index.str[:7]).agg(["sum", "count"])
    boots = np.empty(reps)
    for i in range(reps):
        pick = RNG.integers(0, len(m), len(m))
        boots[i] = m["sum"].values[pick].sum() / m["count"].values[pick].sum()
    return [float(s.mean()), *np.percentile(boots, [2.5, 97.5]).tolist()]


def fama_macbeth(P, osc, hz):
    cols = [osc, "ret126", "dist", "vol"]
    need = cols + [f"fwd{hz}"]
    Q = P.dropna(subset=need)
    coefs, ics = {}, {}
    for d, g in Q.groupby("date"):
        if len(g) < MIN_XS:
            continue
        rk = g[need].rank(pct=True).values
        X = np.column_stack([np.ones(len(g)), rk[:, :4]])
        b = np.linalg.lstsq(X, rk[:, 4], rcond=None)[0]
        coefs[d] = b[1]
        ics[d] = np.corrcoef(rk[:, 0], rk[:, 4])[0, 1]
    return pd.Series(coefs).sort_index(), pd.Series(ics).sort_index()


def quintiles(P, hz):
    Q = P.dropna(subset=["os", "ret126", f"fwd{hz}"]).copy()
    Q = Q[Q.groupby("date").ticker.transform("count") >= MIN_XS]
    Q["rs3"] = (Q.groupby("date").ret126.rank(pct=True) * 3).clip(upper=2.999).astype(int)
    Q["q"] = (Q.groupby(["date", "rs3"]).os.rank(pct=True) * 5).clip(upper=4.999).astype(int)
    f = f"fwd{hz}"
    Q["ex"] = Q[f] - Q.groupby(["date", "rs3"])[f].transform("mean")
    Q["exmed"] = Q[f] - Q.groupby(["date", "rs3"])[f].transform("median")
    rows = []
    for q in range(5):
        s = Q[Q.q == q]
        rows.append({"q": q + 1, "n": int(len(s)), "mean": float(s[f].mean() * 100), "median": float(s[f].median() * 100),
                     "win": float((s[f] > 0).mean() * 100), "excMean": float(s.ex.mean() * 100),
                     "excMedian": float(s.exmed.median() * 100), "p50up": float((s[f] >= 0.5).mean() * 100),
                     "m30dn": float((s[f] <= -0.3).mean() * 100), "os_mean": float(s.os.mean() * 100)})
    per = Q.groupby(["date", "q"]).ex.mean().unstack()
    spread = (per[4] - per[0]).dropna()
    permed = Q.groupby(["date", "q"]).exmed.median().unstack()
    spread_med = (permed[4] - permed[0]).dropna()
    return rows, spread, spread_med


def main():
    con = sqlite3.connect("file:" + DB + "?mode=ro", uri=True)
    df = pd.read_sql("select ticker,date,open,high,low,close,volume from bars order by ticker,date", con)
    ret = df.groupby("ticker").close.pct_change()
    bad = set(df.ticker[(ret > 3.0) | (ret < -0.8)])
    df = df[~df.ticker.isin(bad)]
    P = pd.concat([r for t, g in df.groupby("ticker") if (r := process(t, g)) is not None], ignore_index=True)
    print(f"QA dropped {len(bad)}; panel {len(P):,} rows, {P.ticker.nunique()} tickers; OS valid rows {P.os.notna().sum():,}")
    res = {"fm": {}, "quint": {}, "os_desc": P.os.describe().to_dict()}
    for hz in HORIZONS:
        for osc in ("os", "os_tp"):
            b, ic = fama_macbeth(P, osc, hz)
            m, t_, nd = nw_t(b.values, NW_LAG if hz == 63 else 21)
            mi, ti, _ = nw_t(ic.values, NW_LAG if hz == 63 else 21)
            yr = b.groupby(b.index.str[:4]).agg(["mean", "count"])
            res["fm"][f"{osc}_{hz}"] = {"coef": m, "t": t_, "n_dates": nd, "ic": mi, "ic_t": ti,
                                        "by_year": {y: [float(r["mean"]), int(r["count"])] for y, r in yr.iterrows()}}
        rows, spread, spread_med = quintiles(P, hz)
        res["quint"][str(hz)] = {"rows": rows, "spread_mean": month_ci(spread * 100), "spread_median": month_ci(spread_med * 100),
                                 "spread_mean_nw": nw_t(spread.values, NW_LAG if hz == 63 else 21)[:2]}
    json.dump(res, open(OUT, "w"), indent=1)
    P.to_pickle(OUT.replace(".json", "-panel.pkl"))
    print("saved", OUT)


if __name__ == "__main__":
    main()
