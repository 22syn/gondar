"""Arm-level and threshold-sweep analysis to inform the design decision."""
import json
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
        if c is not None:
            out[datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')] = c
    return out


series = {'QQQ': load('QQQ.json'), '^IXIC': load('idx_IXIC.json'), 'IWM': load('IWM.json')}
keys = {n: sorted(v) for n, v in series.items()}
by_date = {r['scan_date']: r for r in rows}


def near_high(r):
    return r.get('canary_count') is not None


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
    return hits, tot, (hits / tot * 100 if tot else float('nan'))


date_idx = {r['scan_date']: i for i, r in enumerate(rows)}
N = len(rows)


def perm_p(day_list, name, thresh, horizon, nperm=20000):
    idxs = [date_idx[d] for d in day_list if d in date_idx]
    obs = rate(day_list, name, thresh, horizon)[2]
    if not idxs or obs != obs:
        return None
    cnt = 0
    valid = 0
    for _ in range(nperm):
        off = random.randrange(N)
        sh = [rows[(i + off) % N]['scan_date'] for i in idxs]
        _, tt, rr = rate(sh, name, thresh, horizon)
        if tt == 0 or rr != rr:
            continue
        valid += 1
        if rr >= obs:
            cnt += 1
    return (cnt + 1) / (valid + 1)


# ---------- rebuild events with arm labels ----------
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


def is_alert(r):
    return r.get('score') is not None and r['score'] >= 1.0 and near_high(r)


events = []
for i, r in enumerate(rows):
    p = rows[i - 1] if i > 0 else None
    if is_alert(r) and not (p and is_alert(p)):
        events.append((r['scan_date'], 'alert', None))
    elif watch_arm(r) and not is_alert(r) and not (p and watch_arm(p)):
        events.append((r['scan_date'], 'watch', watch_arm(r)))

all_days = [r['scan_date'] for r in rows]
nh_all = [r['scan_date'] for r in rows if near_high(r)]

print("=" * 78)
print("F. WATCH BY ARM - is one arm carrying the failure?")
print("=" * 78)
for arm in ['core3', 'climax', 'both']:
    days = [d for d, t, a in events if t == 'watch' and a == arm]
    if not days:
        print(f"  arm={arm}: no events")
        continue
    print(f"  arm={arm}  n={len(days)}   dates: {', '.join(days[:8])}"
          + (" ..." if len(days) > 8 else ""))
    for n in series:
        for th, hz in [(-3.0, 20), (-5.0, 20)]:
            h, t, r = rate(days, n, th, hz)
            b = rate(all_days, n, th, hz)[2]
            lift = r / b if b else float('nan')
            print(f"      {n:6s} {th:+.0f}%/{hz}d  {h}/{t}={r:3.0f}%  base={b:3.0f}%  lift={lift:.2f}x")
    print()

print("=" * 78)
print("G. ALERT SCORE THRESHOLD SWEEP - is 1.0 the right cut?")
print("=" * 78)
print("  Recompute 'newly fires' at each candidate score threshold (nearHigh still required).")
print("  Reported vs QQQ at -5%/20d (the informative cell: base rate 21%, not a coin flip).")
print()
print(f"  {'thresh':>7s} {'nEvents':>8s} {'hit':>9s} {'lift':>7s} {'perm_p':>8s}")
base_q = rate(all_days, 'QQQ', -5.0, 20)[2]
for cut in [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5]:
    ev = []
    for i, r in enumerate(rows):
        p = rows[i - 1] if i > 0 else None

        def fires(x):
            return x.get('score') is not None and x['score'] >= cut and near_high(x)
        if fires(r) and not (p and fires(p)):
            ev.append(r['scan_date'])
    if len(ev) < 3:
        print(f"  {cut:7.1f} {len(ev):8d}   (too few events)")
        continue
    h, t, rr = rate(ev, 'QQQ', -5.0, 20)
    pv = perm_p(ev, 'QQQ', -5.0, 20)
    lift = rr / base_q if base_q else float('nan')
    print(f"  {cut:7.1f} {len(ev):8d} {h:2d}/{t:2d}={rr:3.0f}% {lift:6.2f}x {pv:8.4f}")
print()

print("=" * 78)
print("H. THE MISSES - which alerts had no pullback, and what did they look like?")
print("=" * 78)
alert_days = [d for d, t, a in events if t == 'alert']
print(f"  {'date':12s} {'score':>6s} {'core3':>6s} {'climax':>7s} {'dd%':>6s} "
      f"{'QQQ_dd20':>9s} {'IXIC_dd20':>10s}")
for d in alert_days:
    r = by_date[d]
    q = maxdd('QQQ', d, 20)
    x = maxdd('^IXIC', d, 20)
    flag = "  <-- MISS(QQQ -5%)" if (q is not None and q > -5.0) else ""
    print(f"  {d:12s} {r['score']:6.2f} {r['core3']:6.2f} {r['climax']:7.2f} "
          f"{r['drawdown_pct']:6.1f} {q:9.2f} {x:10.2f}{flag}")
print()
