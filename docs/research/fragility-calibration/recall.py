"""Recall tradeoff: what basket-top coverage is LOST by dropping the climax arm?

PR #82's headline was recall ('catches 94%/92% of >7% basket tops'). Removing an
arm must lower recall. The question is how much, and what precision is bought.
"""
import json

rows = json.load(open('fragility.json'))
dates = [r['scan_date'] for r in rows]
idx_of = {d: i for i, d in enumerate(dates)}
bval = {r['scan_date']: r['index_value'] for r in rows if r.get('index_value')}


def near_high(r):
    return r.get('canary_count') is not None


def is_alert(r):
    return r.get('score') is not None and r['score'] >= 1.0 and near_high(r)


def arm(r):
    c3 = r.get('core3') is not None and r['core3'] >= 1.0
    cl = near_high(r) and r.get('climax') is not None and r['climax'] >= 1.5
    if c3 and cl:
        return 'both'
    if c3:
        return 'core3'
    if cl:
        return 'climax'
    return None


# ---- identify distinct >=7% basket top episodes -------------------------------
# A "top" starts at a local running peak that is subsequently given back by >=7%.
DROP = 7.0
tops = []
i = 0
while i < len(dates):
    d = dates[i]
    if d not in bval:
        i += 1
        continue
    peak = bval[d]
    trough = peak
    j = i + 1
    end = None
    while j < len(dates):
        v = bval.get(dates[j])
        if v is None:
            j += 1
            continue
        if v > peak:
            break
        trough = min(trough, v)
        if (trough / peak - 1) * 100 <= -DROP:
            end = j
            break
        j += 1
    if end is not None:
        tops.append((d, dates[end], (trough / peak - 1) * 100))
        # advance past this decline to avoid double counting the same episode
        i = end + 1
    else:
        i += 1

print("=" * 78)
print(f"K. RECALL TRADEOFF — distinct >={DROP}% basket top episodes in window")
print("=" * 78)
print(f"  Found {len(tops)} episodes:")
for s, e, dd in tops:
    print(f"    peak {s} -> {dd:.1f}% by {e}")
print()

LOOKBACK = 10  # trading days before the peak in which a warning counts


def fired(kinds, lo, hi):
    """Did any event of `kinds` newly fire in the window [lo, hi] (indices)?"""
    for k in range(max(0, lo), min(hi + 1, len(rows))):
        r = rows[k]
        p = rows[k - 1] if k > 0 else None
        if 'alert' in kinds and is_alert(r) and not (p and is_alert(p)):
            return True
        a = arm(r)
        if a is None or is_alert(r):
            continue
        if p is not None and arm(p) is not None:
            continue  # not a NEW crossing
        if a == 'core3' and 'core3' in kinds:
            return True
        if a == 'climax' and 'climax' in kinds:
            return True
        if a == 'both' and ('core3' in kinds or 'climax' in kinds):
            return True
    return False


configs = [
    ("current  (alert + core3 + climax)", {'alert', 'core3', 'climax'}),
    ("proposed (alert + core3)         ", {'alert', 'core3'}),
    ("alert only                       ", {'alert'}),
    ("climax only                      ", {'climax'}),
]
print(f"  Recall — warning fired within {LOOKBACK} trading days BEFORE the peak:")
for label, kinds in configs:
    hit = 0
    for s, e, dd in tops:
        i = idx_of[s]
        if fired(kinds, i - LOOKBACK, i):
            hit += 1
    pct = hit / len(tops) * 100 if tops else float('nan')
    print(f"    {label}  {hit}/{len(tops)} = {pct:3.0f}%")
print()

# ---- precision: of all firings, how many preceded a top episode? --------------
print(f"  Precision — of each rule's firings, share followed by a >={DROP}% episode")
print(f"  starting within the next {LOOKBACK} trading days:")
top_starts = {idx_of[s] for s, e, dd in tops}
for label, kinds in configs:
    fires = []
    for k, r in enumerate(rows):
        p = rows[k - 1] if k > 0 else None
        isa = is_alert(r) and not (p and is_alert(p))
        a = arm(r)
        isw = (a is not None and not is_alert(r)
               and not (p is not None and arm(p) is not None))
        if 'alert' in kinds and isa:
            fires.append(k)
        elif isw and a is not None:
            if a == 'core3' and 'core3' in kinds:
                fires.append(k)
            elif a == 'climax' and 'climax' in kinds:
                fires.append(k)
            elif a == 'both' and ('core3' in kinds or 'climax' in kinds):
                fires.append(k)
    good = sum(1 for k in fires
               if any(k <= t <= k + LOOKBACK for t in top_starts))
    pct = good / len(fires) * 100 if fires else float('nan')
    print(f"    {label}  {good}/{len(fires)} = {pct:3.0f}%")
print()
print("  Trade: dropping climax costs recall, buys precision. For an alert a human")
print("  reads, a rule that cries wolf is worse than one that misses a top - the")
print("  missed top is still visible on the chart; a false alarm erodes trust.")
