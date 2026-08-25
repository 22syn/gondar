"""Does the 🔴 Alert `indexNearHigh` gate (drawdown <= 2% off the running
250d peak) deserve loosening? Prompted by 2026-08-25: Kobi read a Watch-tier
(white) marker during the Aug 17/18 bounce off the July low and expected Alert
(red) instead.

Step 0 checks the premise directly: does `score` (mean6, Alert's own
condition) even reach 1.0 on those days, independent of the gate?

Step 1/2 sweep the gate from 2% (current) to unlimited (score-only) against
the basket's own >=7%/>=8% top episodes — same methodology as basket.py, but
over the FULL live 4.4y engine history (`fragility-full.json`, 1130 aligned
days, 2022-01-27..2026-08-21) rather than the 252-day D1 snapshot, so this
generalises further than the 2026-07-27 study could.

Run: python3 nearhigh.py (stdlib only)
"""
import json
import random

random.seed(20260825)
rows = json.load(open('fragility-full.json'))
dates = [r['date'] for r in rows]
idx_of = {d: i for i, d in enumerate(dates)}
N = len(rows)

print("=" * 78)
print("STEP 0 — the actual Aug 17/18 case")
print("=" * 78)
for d in ['2026-08-13', '2026-08-14', '2026-08-17', '2026-08-18',
          '2026-08-19', '2026-08-20', '2026-08-21']:
    r = rows[idx_of[d]]
    print(f"  {d}  score={r['score']:.2f}  core3={r['core3']:.2f}  "
          f"dd={r['drawdownPct']:.1f}%  nearHigh={r['indexNearHigh']}")
print("\n  score (mean6, Alert's own condition) never reaches 1.0 -- only core3")
print("  (the Watch condition) does. The gate is not what's blocking Alert here.\n")

print("=" * 78)
print("STEP 1 — population: score>=1.0 while nearHigh(2%) is false")
print("=" * 78)
pop = [r for r in rows if r['score'] is not None and r['score'] >= 1.0 and not r['indexNearHigh']]
print(f"  {len(pop)} days out of {N} scored days -- this is the entire population")
print("  a relaxed gate could newly touch:")
for r in pop:
    print(f"    {r['date']}  score={r['score']:.2f}  dd={r['drawdownPct']:.1f}%")
print()


def basket_dd(d, horizon):
    """Forward max drawdown of the basket's own index_value over `horizon` scan-days."""
    i = idx_of.get(d)
    if i is None:
        return None
    base = rows[i]['indexValue']
    path = rows[i + 1: i + horizon + 1]
    vals = [p['indexValue'] for p in path if p.get('indexValue') is not None]
    if not vals:
        return None
    return min(v / base - 1 for v in vals) * 100


def rate(day_list, thresh, horizon):
    hits = tot = 0
    for d in day_list:
        dd = basket_dd(d, horizon)
        if dd is None:
            continue
        tot += 1
        if dd <= thresh:
            hits += 1
    return hits, tot, (hits / tot * 100 if tot else float('nan'))


def perm_p(day_list, thresh, horizon, nperm=20000):
    idxs = [idx_of[d] for d in day_list if d in idx_of]
    obs = rate(day_list, thresh, horizon)[2]
    if not idxs or obs != obs:
        return None
    cnt = valid = 0
    for _ in range(nperm):
        off = random.randrange(N)
        sh = [dates[(i + off) % N] for i in idxs]
        _, tt, rr = rate(sh, thresh, horizon)
        if tt == 0 or rr != rr:
            continue
        valid += 1
        if rr >= obs:
            cnt += 1
    return (cnt + 1) / (valid + 1) if valid else None


def near_high_at(pct):
    return lambda r: r['drawdownPct'] >= -pct


def alert_events(near_high_fn):
    ev = []
    for i, r in enumerate(rows):
        p = rows[i - 1] if i > 0 else None
        fires = r['score'] is not None and r['score'] >= 1.0 and near_high_fn(r)
        pfires = p is not None and p['score'] is not None and p['score'] >= 1.0 and near_high_fn(p)
        if fires and not pfires:
            ev.append(r['date'])
    return ev


print("=" * 78)
print("STEP 2 — relax the nearHigh gate: 2% (current) -> 4/6/8/10/15/20/off")
print("=" * 78)
all_days = [r['date'] for r in rows if r['score'] is not None]
current_events = None
for label, pct in [('2% (current)', 2), ('4%', 4), ('6%', 6), ('8%', 8), ('10%', 10),
                    ('15%', 15), ('20%', 20), ('off (score-only)', 10 ** 9)]:
    fn = near_high_at(pct)
    ev = alert_events(fn)
    if current_events is None:
        current_events = ev
    print(f"\n  --- gate={label}  n_alert_events={len(ev)} ---")
    for thresh, horizon in [(-7.0, 20), (-8.0, 20), (-8.0, 40)]:
        b = rate(all_days, thresh, horizon)[2]
        h, t, r = rate(ev, thresh, horizon)
        p = perm_p(ev, thresh, horizon)
        lift = r / b if b else float('nan')
        star = "*" if p is not None and p < 0.05 else " "
        p_str = f"{p:.4f}" if p is not None else "  n/a"
        print(f"      basket<={thresh:.0f}%/{horizon}d  base={b:4.1f}%  "
              f"{h:3d}/{t:3d}={r:5.1f}%  lift={lift:5.2f}x  p={p_str} {star}")
    new_days = [d for d in ev if d not in current_events]
    if new_days:
        print(f"      NEW days vs current: {new_days}")

print()
print("=" * 78)
print("CONCLUSION")
print("=" * 78)
print("""  Every relaxation degrades precision, lift and significance monotonically
  (80% hit / 2.5x lift / p~0.05 at 2% down to 40% hit / 1.3x / p~0.5 with no
  gate at all). The 2% gate is not an arbitrary restriction -- it is carrying
  the signal. Do not loosen it.
""")
