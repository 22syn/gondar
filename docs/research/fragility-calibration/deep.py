"""Deep validation of the Purple Fragility -> market pullback relationship.

Addresses the four open caveats from the 2026-07-27 first-pass study:
  A. Circularity       - is the basket just a proxy for the index?
  B. State confound    - Alert requires nearHigh, Watch (via core3) does not.
                         Comparing both to one unconditional base rate is invalid.
  C. Significance      - clustered events; needs a test respecting autocorrelation.
  D. Incremental value - does `score` add anything beyond current drawdown state?
"""
import json
import math
import random
from datetime import datetime, timedelta

random.seed(20260727)

rows = json.load(open('fragility.json'))


def load(f):
    d = json.load(open(f))
    r = d['chart']['result'][0]
    closes = r['indicators']['quote'][0]['close']
    out = {}
    for t, c in zip(r['timestamp'], closes):
        if c is None:
            continue
        out[datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')] = c
    return out


series = {
    'QQQ': load('QQQ.json'),
    'SPY': load('SPY.json'),
    '^IXIC': load('idx_IXIC.json'),
    '^GSPC': load('idx_GSPC.json'),
    'IWM': load('IWM.json'),
}
keys = {n: sorted(v) for n, v in series.items()}


# ---- rule reconstruction (verified against src/services/purpleFragility.ts) ----
# redFires: indexNearHigh AND score >= 1.0
# watch:    core3 >= 1.0  OR  (indexNearHigh AND climax >= 1.5)
#           ^ core3 arm has NO nearHigh gate -> the state confound.
def near_high(r):
    return r.get('canary_count') is not None


def is_alert(r):
    return r.get('score') is not None and r['score'] >= 1.0 and near_high(r)


def watch_arm(r):
    c3 = r.get('core3') is not None and r['core3'] >= 1.0
    cl = near_high(r) and r.get('climax') is not None and r['climax'] >= 1.5
    if c3 and cl:
        return 'both'
    if c3:
        return 'core3'
    if cl:
        return 'climax'
    return None


def is_watch(r):
    return watch_arm(r) is not None


events = []
for i, r in enumerate(rows):
    p = rows[i - 1] if i > 0 else None
    if is_alert(r) and not (p and is_alert(p)):
        events.append((r['scan_date'], 'alert', None))
    elif is_watch(r) and not is_alert(r) and not (p and is_watch(p)):
        events.append((r['scan_date'], 'watch', watch_arm(r)))

by_date = {r['scan_date']: r for r in rows}


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if sx == 0 or sy == 0:
        return None
    return cov / (sx * sy)


def bkey(bd, d):
    for b in range(6):
        c = (datetime.strptime(d, '%Y-%m-%d') - timedelta(days=b)).strftime('%Y-%m-%d')
        if c in bd:
            return c
    return None


def maxdd(name, d, horizon):
    bd = series[name]
    ks = keys[name]
    bk = bkey(bd, d)
    if bk is None:
        return None
    bi = ks.index(bk)
    path = ks[bi:bi + horizon + 1]
    if len(path) < 2:
        return None
    base = bd[bk]
    return min((bd[k] / base - 1) * 100 for k in path[1:])


def rate(day_list, name, thresh, horizon):
    hits = 0
    tot = 0
    for d in day_list:
        dd = maxdd(name, d, horizon)
        if dd is None:
            continue
        tot += 1
        if dd <= thresh:
            hits += 1
    pct = (hits / tot * 100) if tot else float('nan')
    return hits, tot, pct


def mean(v):
    return sum(v) / len(v) if v else float('nan')


print("=" * 78)
print("A. CIRCULARITY - is the Purple basket just a repackaged index?")
print("=" * 78)
print("Basket: SMTC AMKR CRDO IFX.DE MRVL MU ONTO SEDG SNDK TSM")
print("Nasdaq-100 members among them: MU, MRVL only (2/10, both small QQQ weights).")
print("Empirical check - daily return correlation, basket index_value vs benchmark:")
print()
bas_dates = [r['scan_date'] for r in rows]
bas_val = {r['scan_date']: r['index_value'] for r in rows if r.get('index_value')}
for n in series:
    xs = []
    ys = []
    for i in range(1, len(bas_dates)):
        d0 = bas_dates[i - 1]
        d1 = bas_dates[i]
        if d0 not in bas_val or d1 not in bas_val:
            continue
        k0 = bkey(series[n], d0)
        k1 = bkey(series[n], d1)
        if not k0 or not k1 or k0 == k1:
            continue
        xs.append(bas_val[d1] / bas_val[d0] - 1)
        ys.append(series[n][k1] / series[n][k0] - 1)
    r = pearson(xs, ys)
    print(f"  basket vs {n:7s}  r = {r:.3f}   r^2 = {r * r:.2f}   (n={len(xs)})")
print()
print("  r^2 = share of basket variance explained by the index.")
print("  Low/moderate r^2 => basket carries independent info; not definitional.")
print()

print("=" * 78)
print("B. STATE CONFOUND - Alert requires nearHigh; Watch(core3) does not")
print("=" * 78)
nh_days = [r for r in rows if near_high(r)]
non_nh = [r for r in rows if not near_high(r)]
print(f"  nearHigh days: {len(nh_days)}/{len(rows)} ({len(nh_days) / len(rows) * 100:.0f}%)")
print(f"  mean drawdown_pct | nearHigh     = {mean([r['drawdown_pct'] for r in nh_days]):.2f}%")
print(f"  mean drawdown_pct | NOT nearHigh = {mean([r['drawdown_pct'] for r in non_nh]):.2f}%")
arm_counts = {}
for d, t, a in events:
    if t == 'watch':
        arm_counts[a] = arm_counts.get(a, 0) + 1
n_watch = sum(1 for _, t, _ in events if t == 'watch')
n_alert = sum(1 for _, t, _ in events if t == 'alert')
nh_at_watch = sum(1 for d, t, a in events if t == 'watch' and near_high(by_date[d]))
print()
print(f"  Watch events by arm: {arm_counts}")
print(f"  Watch events firing while nearHigh: {nh_at_watch}/{n_watch}")
print(f"  Alert events (nearHigh by construction): {n_alert}/{n_alert}")
print()

print("=" * 78)
print("C. STATE-MATCHED LIFT - each tier vs its OWN eligible-day base rate")
print("=" * 78)
print("  Alert base = nearHigh days only (the only days an Alert could fire)")
print("  Watch base = all days (core3 arm unconditional), plus a state split")
print()

alert_days = [d for d, t, a in events if t == 'alert']
watch_days = [d for d, t, a in events if t == 'watch']
watch_nh = [d for d, t, a in events if t == 'watch' and near_high(by_date[d])]
watch_nonh = [d for d, t, a in events if t == 'watch' and not near_high(by_date[d])]
nh_all = [r['scan_date'] for r in nh_days]
notnh_all = [r['scan_date'] for r in non_nh]
all_days = [r['scan_date'] for r in rows]

for thresh, horizon in [(-3.0, 20), (-5.0, 20)]:
    print(f"  --- threshold {thresh}% / {horizon}d ---")
    hdr = (f"  {'Index':7s} {'baseALL':>8s} {'baseNH':>7s} {'ALERT':>10s} "
           f"{'liftvsNH':>9s} {'WATCH':>10s} {'liftvsALL':>10s}")
    print(hdr)
    for n in series:
        bA = rate(all_days, n, thresh, horizon)[2]
        bN = rate(nh_all, n, thresh, horizon)[2]
        ah, at, aR = rate(alert_days, n, thresh, horizon)
        wh, wt, wR = rate(watch_days, n, thresh, horizon)
        lA = aR / bN if bN else float('nan')
        lW = wR / bA if bA else float('nan')
        print(f"  {n:7s} {bA:7.0f}% {bN:6.0f}% {ah:2d}/{at:2d}={aR:3.0f}% "
              f"{lA:8.2f}x {wh:2d}/{wt:2d}={wR:3.0f}% {lW:9.2f}x")
    print()

print("  Watch decomposed by state (threshold -3%/20d):")
print(f"  {'Index':7s} {'W|nearHigh':>16s} {'W|NOTnearHigh':>18s} {'base|NH':>9s} {'base|notNH':>11s}")
for n in series:
    h1, t1, r1 = rate(watch_nh, n, -3.0, 20)
    h2, t2, r2 = rate(watch_nonh, n, -3.0, 20)
    bN = rate(nh_all, n, -3.0, 20)[2]
    bX = rate(notnh_all, n, -3.0, 20)[2]
    print(f"  {n:7s} {h1:2d}/{t1:2d}={r1:5.0f}%      {h2:2d}/{t2:2d}={r2:5.0f}%       "
          f"{bN:7.0f}%  {bX:10.0f}%")
print()

print("=" * 78)
print("D. SIGNIFICANCE - circular-shift permutation (preserves event clustering)")
print("=" * 78)
print("  Shift the WHOLE event sequence by a random offset. Relative spacing")
print("  (clustering) preserved exactly; only alignment with history randomized.")
print("  p = P(shifted rate >= observed rate).")
print()

date_idx = {r['scan_date']: i for i, r in enumerate(rows)}
N = len(rows)
NPERM = 20000


def perm_test(day_list, name, thresh, horizon):
    idxs = [date_idx[d] for d in day_list if d in date_idx]
    if not idxs:
        return None
    obs = rate(day_list, name, thresh, horizon)[2]
    if obs != obs:
        return None
    cnt = 0
    valid = 0
    for _ in range(NPERM):
        off = random.randrange(N)
        shifted = [rows[(i + off) % N]['scan_date'] for i in idxs]
        _, tt, rr = rate(shifted, name, thresh, horizon)
        if tt == 0 or rr != rr:
            continue
        valid += 1
        if rr >= obs:
            cnt += 1
    return obs, (cnt + 1) / (valid + 1)


for thresh, horizon in [(-3.0, 20), (-5.0, 20)]:
    print(f"  --- {thresh}% / {horizon}d ---")
    for n in series:
        ra = perm_test(alert_days, n, thresh, horizon)
        rw = perm_test(watch_days, n, thresh, horizon)
        sa = f"obs={ra[0]:3.0f}% p={ra[1]:.4f}" if ra else "n/a"
        sw = f"obs={rw[0]:3.0f}% p={rw[1]:.4f}" if rw else "n/a"
        star = "*" if ra and ra[1] < 0.05 else " "
        print(f"  {n:7s} ALERT {sa} {star}   WATCH {sw}")
    print()

print("=" * 78)
print("E. INCREMENTAL VALUE - does `score` beat simply knowing drawdown state?")
print("=" * 78)
print("  If `score` only proxies 'how far from the high are we', it adds nothing")
print("  beyond drawdown_pct, which is free.")
print()
for n in ['QQQ', '^IXIC']:
    for h in [10, 20]:
        xs_s = []
        xs_d = []
        ys = []
        for r in rows:
            d = r['scan_date']
            if r.get('score') is None or r.get('drawdown_pct') is None:
                continue
            bk = bkey(series[n], d)
            if not bk:
                continue
            ks = keys[n]
            bi = ks.index(bk)
            if bi + h >= len(ks):
                continue
            ys.append((series[n][ks[bi + h]] / series[n][bk] - 1) * 100)
            xs_s.append(r['score'])
            xs_d.append(r['drawdown_pct'])
        rs = pearson(xs_s, ys)
        rd = pearson(xs_d, ys)
        rsd = pearson(xs_s, xs_d)
        if None not in (rs, rd, rsd) and abs(rsd) < 0.999:
            part = (rs - rd * rsd) / math.sqrt((1 - rd ** 2) * (1 - rsd ** 2))
        else:
            part = float('nan')
        print(f"  {n:7s} h={h:2d}d  corr(score,fwd)={rs:+.3f}  corr(dd,fwd)={rd:+.3f}  "
              f"corr(score,dd)={rsd:+.3f}  partial(score|dd)={part:+.3f}")
print()
