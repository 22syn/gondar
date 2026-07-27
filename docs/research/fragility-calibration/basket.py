"""Re-test the Watch arms against the target they were ACTUALLY calibrated for.

PR #82 validated the Watch rule against '>7% BASKET tops' (the Purple basket's
own index), reporting 94%/92% recall at ~39% precision across a 2023-24 /
2025-26 split-half. The 2026-07-27 study instead measured QQQ drawdowns.
Those are different targets. If the climax arm works on basket tops but not on
QQQ, the honest fix is labelling, not removal.
"""
import json
import random
from datetime import datetime, timedelta

random.seed(20260727)
rows = json.load(open('fragility.json'))
by_date = {r['scan_date']: r for r in rows}
dates = [r['scan_date'] for r in rows]
idx_of = {d: i for i, d in enumerate(dates)}

# Basket's own index level, straight from D1 (index_value column).
bval = {r['scan_date']: r['index_value'] for r in rows if r.get('index_value')}


def load(f):
    d = json.load(open(f))
    r = d['chart']['result'][0]
    closes = r['indicators']['quote'][0]['close']
    out = {}
    for t, c in zip(r['timestamp'], closes):
        if c is not None:
            out[datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')] = c
    return out


qqq = load('QQQ.json')
qkeys = sorted(qqq)


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


events = []
for i, r in enumerate(rows):
    p = rows[i - 1] if i > 0 else None
    if is_alert(r) and not (p and is_alert(p)):
        events.append((r['scan_date'], 'alert', None))
    elif watch_arm(r) and not is_alert(r) and not (p and watch_arm(p)):
        events.append((r['scan_date'], 'watch', watch_arm(r)))


def basket_dd(d, horizon):
    """Forward max drawdown of the BASKET's own index over `horizon` scan-days."""
    i = idx_of.get(d)
    if i is None or d not in bval:
        return None
    base = bval[d]
    path = [dates[j] for j in range(i + 1, min(i + horizon + 1, len(dates)))]
    vals = [bval[k] for k in path if k in bval]
    if not vals:
        return None
    return min(v / base - 1 for v in vals) * 100


def rate(day_list, fn, thresh, horizon):
    hits = 0
    tot = 0
    for d in day_list:
        dd = fn(d, horizon)
        if dd is None:
            continue
        tot += 1
        if dd <= thresh:
            hits += 1
    return hits, tot, (hits / tot * 100 if tot else float('nan'))


N = len(rows)


def perm_p(day_list, fn, thresh, horizon, nperm=20000):
    idxs = [idx_of[d] for d in day_list if d in idx_of]
    obs = rate(day_list, fn, thresh, horizon)[2]
    if not idxs or obs != obs:
        return None
    cnt = 0
    valid = 0
    for _ in range(nperm):
        off = random.randrange(N)
        sh = [dates[(i + off) % N] for i in idxs]
        _, tt, rr = rate(sh, fn, thresh, horizon)
        if tt == 0 or rr != rr:
            continue
        valid += 1
        if rr >= obs:
            cnt += 1
    return (cnt + 1) / (valid + 1)


alert_d = [d for d, t, a in events if t == 'alert']
climax_d = [d for d, t, a in events if t == 'watch' and a == 'climax']
core3_d = [d for d, t, a in events if t == 'watch' and a == 'core3']
all_d = dates

print("=" * 78)
print("I. THE ARMS vs THE BASKET'S OWN TOPS (the PR #82 target)")
print("=" * 78)
print("  Forward max drawdown of the basket index_value, from each event.")
print()
for thresh, horizon in [(-7.0, 20), (-7.0, 40), (-5.0, 20), (-3.0, 20)]:
    b = rate(all_d, basket_dd, thresh, horizon)[2]
    print(f"  --- basket drawdown <= {thresh}% within {horizon} scan-days "
          f"(base rate {b:.0f}%) ---")
    for lbl, grp in [('ALERT ', alert_d), ('climax', climax_d), ('core3 ', core3_d)]:
        h, t, r = rate(grp, basket_dd, thresh, horizon)
        lift = r / b if b else float('nan')
        p = perm_p(grp, basket_dd, thresh, horizon)
        star = "*" if p is not None and p < 0.05 else " "
        print(f"      {lbl} {h:2d}/{t:2d}={r:3.0f}%  lift={lift:5.2f}x  p={p:.4f} {star}")
    print()

print("=" * 78)
print("J. SIDE BY SIDE — same events, two targets")
print("=" * 78)


def qqq_dd(d, horizon):
    b = None
    for back in range(6):
        c = (datetime.strptime(d, '%Y-%m-%d') - timedelta(days=back)).strftime('%Y-%m-%d')
        if c in qqq:
            b = c
            break
    if b is None:
        return None
    i = qkeys.index(b)
    path = qkeys[i:i + horizon + 1]
    if len(path) < 2:
        return None
    base = qqq[b]
    return min((qqq[k] / base - 1) * 100 for k in path[1:])


print(f"  {'arm':8s} {'n':>3s} {'basket-7%/20d':>16s} {'lift':>6s} | {'QQQ-5%/20d':>13s} {'lift':>6s}")
bb = rate(all_d, basket_dd, -7.0, 20)[2]
bq = rate(all_d, qqq_dd, -5.0, 20)[2]
for lbl, grp in [('ALERT', alert_d), ('climax', climax_d), ('core3', core3_d)]:
    h1, t1, r1 = rate(grp, basket_dd, -7.0, 20)
    h2, t2, r2 = rate(grp, qqq_dd, -5.0, 20)
    print(f"  {lbl:8s} {len(grp):3d} {h1:2d}/{t1:2d}={r1:5.0f}% {r1 / bb:6.2f}x | "
          f"{h2:2d}/{t2:2d}={r2:5.0f}% {r2 / bq:6.2f}x")
print(f"  {'BASE':8s}  -  {'':9s}{bb:5.0f}%  1.00x | {'':7s}{bq:5.0f}%  1.00x")
print()
print("  NOTE: this window (252d) is a SUBSET of PR #82's calibration span")
print("  (2023-24 + 2025-26 split-half). It cannot refute that study on its")
print("  own terms - only show what the arm has done recently.")
