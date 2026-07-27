import json
import math
from datetime import datetime, timedelta

with open('fragility.json') as f:
    rows = json.load(f)

def load_series(fname):
    d = json.load(open(fname))
    result = d['chart']['result'][0]
    ts = result['timestamp']
    closes = result['indicators']['quote'][0]['close']
    by_date = {}
    for t, c in zip(ts, closes):
        if c is None:
            continue
        date = datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')
        by_date[date] = c
    return by_date

series = {
    'QQQ': load_series('QQQ.json'),
    'SPY': load_series('SPY.json'),
    '^IXIC': load_series('idx_IXIC.json'),
    '^GSPC': load_series('idx_GSPC.json'),
    'IWM': load_series('IWM.json'),
}

dates = [r['scan_date'] for r in rows]

# --- reconstruct the exact alert/watch rule from dashboard/public/app.js ---
def near_high(r):
    return r.get('canary_count') is not None

def is_alert(r):
    return r.get('score') is not None and r['score'] >= 1.0 and near_high(r)

def is_watch(r):
    core3_hit = r.get('core3') is not None and r['core3'] >= 1.0
    climax_hit = r.get('climax') is not None and r['climax'] >= 1.5 and near_high(r)
    return core3_hit or climax_hit

markers = []
for i, r in enumerate(rows):
    prev = rows[i-1] if i > 0 else None
    if is_alert(r) and not (prev and is_alert(prev)):
        markers.append((r['scan_date'], 'alert'))
    elif is_watch(r) and not is_alert(r) and not (prev and is_watch(prev)):
        markers.append((r['scan_date'], 'watch'))

print(f"Total rows: {len(rows)} ({dates[0]} to {dates[-1]})")
print(f"Newly-fired crossings: {len(markers)}")
for d, tier in markers:
    print(f"  {d}  {tier}")

# --- helper: nearest close on/before a date, for each index ---
def close_on_or_before(by_date, date_str, max_lookback=5):
    d = datetime.strptime(date_str, '%Y-%m-%d')
    for back in range(max_lookback):
        cand = (d - timedelta(days=back)).strftime('%Y-%m-%d')
        if cand in by_date:
            return by_date[cand]
    return None

def close_n_trading_rows_ahead(by_date, sorted_keys, date_str, n):
    # find index of date_str (or nearest before) in sorted_keys, then step n ahead
    if date_str not in by_date:
        base = close_on_or_before(by_date, date_str)
        if base is None:
            return None
        # find the actual key matching that close near date_str
        for back in range(6):
            cand = (datetime.strptime(date_str, '%Y-%m-%d') - timedelta(days=back)).strftime('%Y-%m-%d')
            if cand in sorted_keys:
                date_str = cand
                break
    try:
        idx = sorted_keys.index(date_str)
    except ValueError:
        return None
    j = idx + n
    if j >= len(sorted_keys):
        return None
    return by_date[sorted_keys[j]]

sorted_keys = {name: sorted(by_date.keys()) for name, by_date in series.items()}

HORIZONS = [5, 10, 20]
PULLBACK_THRESHOLD = -3.0  # percent, defines a "pullback" for hit-rate purposes

print("\n=== Event study: forward drawdown after each newly-fired crossing ===")
event_results = []
for d, tier in markers:
    row_result = {'date': d, 'tier': tier}
    for name, by_date in series.items():
        base = close_on_or_before(by_date, d)
        if base is None:
            row_result[name] = None
            continue
        min_ret = None
        end_rets = {}
        keys = sorted_keys[name]
        # walk forward day by day up to max horizon, track min (max drawdown) along the path
        try:
            base_idx = keys.index(next(k for k in keys if by_date[k] == base and k <= d))
        except StopIteration:
            base_idx = None
        # simpler: locate index of the matched base date directly
        base_date_key = None
        for back in range(6):
            cand = (datetime.strptime(d, '%Y-%m-%d') - timedelta(days=back)).strftime('%Y-%m-%d')
            if cand in by_date:
                base_date_key = cand
                break
        if base_date_key is None or base_date_key not in keys:
            row_result[name] = None
            continue
        bi = keys.index(base_date_key)
        path = keys[bi: bi + max(HORIZONS) + 1]
        rets = [(by_date[k] / base - 1) * 100 for k in path]
        min_ret = min(rets[1:]) if len(rets) > 1 else None
        for h in HORIZONS:
            end_rets[h] = rets[h] if len(rets) > h else None
        row_result[name] = {'min_dd_pct': round(min_ret, 2) if min_ret is not None else None,
                             'ret_by_horizon': {h: (round(v, 2) if v is not None else None) for h, v in end_rets.items()}}
    event_results.append(row_result)
    print(json.dumps(row_result, indent=None))

# --- hit-rate summary per index: did a >=3% pullback occur within 20 trading days? ---
print("\n=== Hit-rate summary (>= 3% drawdown within 20 trading days of a crossing) ===")
for name in series:
    hits = 0
    total = 0
    for ev in event_results:
        info = ev.get(name)
        if info is None or info['min_dd_pct'] is None:
            continue
        total += 1
        if info['min_dd_pct'] <= PULLBACK_THRESHOLD:
            hits += 1
    rate = (hits / total * 100) if total else None
    print(f"  {name}: {hits}/{total} = {rate:.0f}%" if rate is not None else f"  {name}: no data")

# --- correlation: fragility score vs forward N-day return, whole series ---
print("\n=== Correlation: fragility score level vs forward N-day return (whole series, all 252 days) ===")
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

for name, by_date in series.items():
    keys = sorted_keys[name]
    for h in HORIZONS:
        xs, ys = [], []
        for r in rows:
            d = r['scan_date']
            score = r.get('score')
            if score is None:
                continue
            base_date_key = None
            for back in range(6):
                cand = (datetime.strptime(d, '%Y-%m-%d') - timedelta(days=back)).strftime('%Y-%m-%d')
                if cand in by_date:
                    base_date_key = cand
                    break
            if base_date_key is None or base_date_key not in keys:
                continue
            bi = keys.index(base_date_key)
            if bi + h >= len(keys):
                continue
            fwd_ret = (by_date[keys[bi + h]] / by_date[base_date_key] - 1) * 100
            xs.append(score)
            ys.append(fwd_ret)
        r_val = pearson(xs, ys)
        print(f"  {name:7s} h={h:2d}d  n={len(xs):3d}  corr(score, fwd_ret) = {r_val:.3f}" if r_val is not None else f"  {name} h={h}d: n/a")
