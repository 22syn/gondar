/**
 * GONDAR Dashboard — app.js
 * Vanilla JS, no framework. RTL Hebrew UI, XSHEVA design system.
 * Depends on: Chart.js (CDN), styles.css
 */

'use strict';

/* ─── Constants ──────────────────────────────────────────────────────────── */

/**
 * Signal display metadata.
 *
 * `cls` encodes BACKTESTED QUALITY, not signal category — see
 * docs/plans/dashboard-color-semantics-audit.md (2026-08-03). Breakout is
 * documented in the explainer tab itself as negative-edge, so it's 'weak',
 * not the 'strong' green it used to share with Stage 2 Full.
 *
 * `icon` is a Material Symbols Outlined ligature — the XSHEVA system bans
 * emoji and unicode-as-icon, so every marker resolves through the icon
 * webfont instead. Rendered via `iconHTML()`. The icon carries the signal's
 * *category*; the tier colour carries its *quality*.
 *
 * NOTE: these render as HTML only. Chart.js tooltips are canvas-drawn, so
 * ligatures would show as literal words there — those use plain text.
 */
const SIGNAL_META = {
  breakout:      { label: 'Breakout',     icon: 'trending_up',     cls: 'weak' },
  highVolume:    { label: 'High Volume',  icon: 'bolt',            cls: 'moderate' },
  pullback:      { label: 'Pullback',     icon: 'trending_down',   cls: 'strong' },
  creep:         { label: 'Stairstep',    icon: 'stairs',          cls: 'strong' },
  nearBreakout:  { label: 'Near Break',   icon: 'hourglass_empty', cls: 'low' },
  nearHighVol:   { label: 'Near HiVol',   icon: 'hourglass_empty', cls: 'low' },
  nearPullback:  { label: 'Near Pull',    icon: 'hourglass_empty', cls: 'low' },
  // Smart-Setup tiers (momentum-gated package, backfilled 2026-07-09)
  setupFull:     { label: 'Stage 2 Full',   icon: 'gps_fixed',       cls: 'strong' },
  setupClose:    { label: 'Stage 2 Close',  icon: 'visibility',      cls: 'strong' },
  setupRecovery: { label: 'Recovery',     icon: 'rocket_launch',   cls: 'strong' },
};

/**
 * Render a Material Symbols Outlined icon.
 * @param {string} name - ligature name, e.g. 'trending_up'
 * @param {string} [extraCls]
 * @returns {string}
 */
function iconHTML(name, extraCls) {
  const cls = extraCls ? `material-symbols-outlined ${extraCls}` : 'material-symbols-outlined';
  return `<span class="${cls}" aria-hidden="true">${name}</span>`;
}

/**
 * TradingView exchange tag → SVR ticker suffix. Used to resolve a watchlist
 * entry (exchange-stripped, e.g. {ticker:'NICE', exchange:'TASE'}) back to the
 * D1 ticker ('NICE.TA') — a plain base match alone would confuse the TASE NICE
 * with the US NICE. EURONEXT is deliberately absent: it maps to both .PA and
 * .AS, so those fall through to the suffix-agnostic fallback.
 */
const EXCHANGE_SUFFIX = {
  TASE: '.TA', XETR: '.DE', SIX: '.SW', LSE: '.L', MIL: '.MI',
  VIE: '.VI', TWSE: '.TW', KRX: '.KS', BMFBOVESPA: '.SA', BME: '.MC',
};

/** Table column definitions: [key, hebrewLabel, cssClass] */
const COLS = [
  ['ticker',    'טיקר',      'col-ticker'],
  ['region',    'אזור',      'col-region'],
  ['sector',    'סקטור',     'col-sector'],
  ['signals',   'סיגנלים',   'col-signals'],
  ['rvol',      'RVOL',      'col-mono'],
  ['ath_pct',   'ATH%',      'col-mono'],
  ['day_pct',   'יום%',      'col-mono'],
  ['stage2',    'S2',        'col-mono'],
  ['rs',        'RS',        'col-mono'],
  ['score',     'Score',     'col-score'],
  ['price',     'מחיר',      'col-mono'],
];

const SCORE_BUCKETS = [-Infinity, 40, 55, 70, 85, Infinity];
const SCORE_LABELS  = ['<40', '40-55', '55-70', '70-85', '85+'];

/** Weekday labels, Sunday-first, Hebrew abbreviated */
const WEEKDAY_LABELS = ['אח', 'שנ', 'של', 'רב', 'חמ', 'שש', 'שב'];

/* ─── State ──────────────────────────────────────────────────────────────── */

/** @type {Array<object>} */
let allRows = [];
/** @type {Array<object>} */
let summaryDays = [];
/** @type {string|null} */
let selectedDate = null;
// Default sort is RS, not Score. Over the 2-year study RS spans 67.9%→75.1%
// win and +8.3%→+17.9% median while Score is nearly flat (67.5%→70.9%), and
// the 2026-08-03 forward-return study found Score carries no information once
// RS is known (rho flips sign at random inside RS bands; RS still splits the
// populated Score bands by 14-24pp). Rows with no RS sort last — the
// comparator already pushes nulls to the bottom regardless of direction.
let sortKey = 'rs';
let sortDir = -1; // -1 = descending
/** @type {Chart|null} */
let chart = null;
let fragChart = null;
/** @type {Chart|null} Modal (expanded-view) instance of the fragility chart. */
let fragChartModal = null;
/** Last-loaded fragility rows, kept so the expanded modal can re-render the same data. */
let fragilityRows = [];
/** Calendar view state: which month/year the popover is currently showing */
let calViewYear  = 0;
let calViewMonth = 0; // 0-11
/** Whether to include near-* rows (silent watchlist). Off by default. */
let showNear = false;

/* ─── DOM helpers ─────────────────────────────────────────────────────────── */

/**
 * @param {string} sel
 * @returns {HTMLElement}
 */
const $ = (sel) => document.querySelector(sel);

/**
 * @param {string} sel
 * @returns {NodeList}
 */
const $$ = (sel) => document.querySelectorAll(sel);

function showState(msg) {
  const el = $('#state-msg');
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/* ─── Signal badge helpers ────────────────────────────────────────────────── */

/**
 * Human-readable label for a signal key.
 * @param {string} name
 * @returns {string}
 */
function readableSignal(name) {
  return (SIGNAL_META[name] && SIGNAL_META[name].label) || name;
}

/**
 * Build badge HTML for a single signal name.
 * @param {string} name - signal key
 * @param {boolean} primary - true if this is the primary signal
 * @returns {string}
 */
function badgeHTML(name, primary) {
  const meta = SIGNAL_META[name] || { label: name, icon: 'circle', cls: 'near' };
  const cls = primary ? `badge badge--${meta.cls} badge--primary` : `badge badge--${meta.cls}`;
  return `<span class="${cls}" title="${meta.label}">${iconHTML(meta.icon)}${meta.label}</span>`;
}

/**
 * Render the full badge group for a row.
 * Includes graduation badge, streak chip, and ×N tooltip.
 * @param {object} row
 * @returns {string}
 */
function signalBadgesHTML(row) {
  const primary = (row.signal || '').trim();
  const allSigs = row.signals
    ? row.signals.split(',').map((s) => s.trim()).filter(Boolean)
    : (primary ? [primary] : []);

  // De-duplicate: primary first, then extras
  const extras = allSigs.filter((s) => s !== primary);
  const count = row.signal_count || allSigs.length;

  let html = '<span class="badges">';

  // Graduation badge first — highest priority
  if (row.graduated_from) {
    const fromLabel = readableSignal(row.graduated_from);
    html += `<span class="badge badge--grad" title="Graduated from ${fromLabel}">${iconHTML('school')}← ${fromLabel}</span>`;
  }

  if (primary) html += badgeHTML(primary, true);
  for (const s of extras) html += badgeHTML(s, false);

  // ×N confluence tag with full signal list in title
  if (count > 1) {
    const sigList = allSigs.map(readableSignal).join(' · ');
    html += `<span class="conf-tag" title="${sigList}">×${count}</span>`;
  }

  // Streak chip (streak > 1 only)
  if (row.streak && row.streak > 1) {
    html += `<span class="streak-chip" title="${row.streak} ימים ברצף">${iconHTML('calendar_month')}${row.streak}d</span>`;
  }

  html += '</span>';
  return html;
}

/* ─── Score delta ─────────────────────────────────────────────────────────── */

/**
 * Render score delta indicator HTML.
 * @param {number|null|undefined} delta
 * @returns {string}
 */
function scoreDeltaHTML(delta) {
  if (delta === null || delta === undefined) {
    return `<span class="delta-new" title="סיגנל חדש היום">${iconHTML('fiber_new')}</span>`;
  }
  if (delta > 0)  return `<span class="delta-up" title="עלייה ב-${delta} נק׳">▲${delta}</span>`;
  if (delta < 0)  return `<span class="delta-down" title="ירידה ב-${Math.abs(delta)} נק׳">▼${Math.abs(delta)}</span>`;
  return '';
}

/* ─── Score color ─────────────────────────────────────────────────────────── */

/**
 * Read a design token off :root so styles.css stays the single source of
 * truth for the palette. Memoised — this is called once per rendered cell,
 * and getComputedStyle forces a style recalc every time.
 * @param {string} name - custom property name, e.g. '--score-b3'
 * @returns {string}
 */
const TOKEN_CACHE = new Map();
function token(name) {
  let v = TOKEN_CACHE.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    TOKEN_CACHE.set(name, v);
  }
  return v;
}

/**
 * Returns a background-color CSS value for a score.
 * Single-hue accent ramp — the score is sequential, not categorical.
 * @param {number|null} s
 * @returns {string}
 */
function scoreBg(s) {
  if (s == null) return 'transparent';
  if (s >= 85)  return token('--score-b4');
  if (s >= 70)  return token('--score-b3');
  if (s >= 55)  return token('--score-b2');
  return token('--score-b1');
}

/**
 * Returns a foreground color for a score badge (used in card list), where the
 * background tint is too faint to carry the ramp on its own.
 * @param {number|null} s
 * @returns {string}
 */
function scoreColor(s) {
  if (s == null) return token('--xsh-fg-3');
  if (s >= 70)  return token('--xsh-primary');
  if (s >= 55)  return token('--xsh-fg-2');
  return token('--xsh-fg-4');
}

/* ─── Number formatting ───────────────────────────────────────────────────── */

/** @returns {string} */
function fmtPct(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

/** @returns {string} */
function fmtPctClass(v) {
  if (v == null) return 'num-neu';
  const n = Number(v);
  if (n > 0)  return 'num-up';
  if (n < 0)  return 'num-down';
  return 'num-neu';
}

/** @returns {string} */
function fmtRvol(v) {
  if (v == null) return '—';
  return Number(v).toFixed(1) + 'x';
}

/** @returns {string} */
function fmtPrice(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/* ─── Calendar popover ────────────────────────────────────────────────────── */

/**
 * Build a Set of dates that have data, and a Map of date → summary row.
 * Populated once summaryDays is loaded.
 * @type {Map<string, object>}
 */
let summaryByDate = new Map();

function buildSummaryIndex() {
  summaryByDate = new Map();
  for (const d of summaryDays) {
    summaryByDate.set(d.scan_date, d);
  }
}

/**
 * Render the calendar grid for calViewYear / calViewMonth.
 */
function renderCalendar() {
  const popover = $('#cal-popover');
  const grid    = $('#cal-grid');
  const label   = $('#cal-month-label');

  const monthNames = [
    'ינואר','פברואר','מרץ','אפריל','מאי','יוני',
    'יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר',
  ];
  label.textContent = `${monthNames[calViewMonth]} ${calViewYear}`;

  // Render weekday header if not yet done (idempotent)
  const wdRow = popover.querySelector('.cal-weekdays');
  if (wdRow && !wdRow.children.length) {
    wdRow.innerHTML = WEEKDAY_LABELS.map(
      (d) => `<span class="cal-wd">${d}</span>`
    ).join('');
  }

  // First day of month (0=Sun)
  const firstDow = new Date(calViewYear, calViewMonth, 1).getDay();
  // Total days in month
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();

  let html = '';

  // Leading empty cells
  for (let i = 0; i < firstDow; i++) {
    html += '<div class="cal-day cal-day--empty" aria-hidden="true"></div>';
  }

  // Day cells
  for (let d = 1; d <= daysInMonth; d++) {
    const mm   = String(calViewMonth + 1).padStart(2, '0');
    const dd   = String(d).padStart(2, '0');
    const iso  = `${calViewYear}-${mm}-${dd}`;
    const summ = summaryByDate.get(iso);
    const hasData  = !!summ;
    const selected = iso === selectedDate;
    const has70    = hasData && (summ.score70 || 0) > 0;

    if (hasData) {
      html += `
        <div
          class="cal-day"
          data-has-data="true"
          data-date="${iso}"
          data-selected="${selected}"
          role="gridcell"
          tabindex="${selected ? '0' : '-1'}"
          aria-label="${iso}, ${summ.total} סיגנלים${has70 ? `, Score≥70: ${summ.score70}` : ''}"
          aria-pressed="${selected}"
        >
          <span>${d}</span>
          <span class="cal-day-count">${summ.total}</span>
          ${has70 ? '<span class="cal-day-dot" aria-hidden="true"></span>' : ''}
        </div>`;
    } else {
      html += `
        <div
          class="cal-day"
          data-has-data="false"
          aria-hidden="true"
          aria-label="${iso} — אין נתונים"
        ><span>${d}</span></div>`;
    }
  }

  grid.innerHTML = html;

  // Attach click handlers
  grid.querySelectorAll('.cal-day[data-has-data="true"]').forEach((cell) => {
    cell.addEventListener('click', () => {
      closeCalPopover();
      selectDay(cell.dataset.date);
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        closeCalPopover();
        selectDay(cell.dataset.date);
      }
    });
  });
}

function openCalPopover() {
  const popover = $('#cal-popover');
  const btn     = $('#btn-date-picker');
  popover.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  // Ensure we're viewing the month of the selected date
  if (selectedDate) {
    const parts = selectedDate.split('-');
    calViewYear  = parseInt(parts[0], 10);
    calViewMonth = parseInt(parts[1], 10) - 1;
  }
  renderCalendar();
  // Focus the selected day or first data day in view
  const selected = popover.querySelector('.cal-day[data-selected="true"]');
  if (selected) selected.focus();
}

function closeCalPopover() {
  const popover = $('#cal-popover');
  const btn     = $('#btn-date-picker');
  popover.hidden = true;
  btn.setAttribute('aria-expanded', 'false');
}

function toggleCalPopover() {
  const popover = $('#cal-popover');
  if (popover.hidden) {
    openCalPopover();
  } else {
    closeCalPopover();
  }
}

/**
 * Move to the adjacent data-day (offset = -1 for prev, +1 for next).
 * @param {number} offset
 */
function stepDay(offset) {
  if (!summaryDays.length) return;
  // summaryDays is newest-first per API contract
  const idx = summaryDays.findIndex((d) => d.scan_date === selectedDate);
  if (idx === -1) return;
  const next = idx - offset; // newest-first means subtract to go forward
  if (next < 0 || next >= summaryDays.length) return;
  selectDay(summaryDays[next].scan_date);
}

function updateNavButtons() {
  const idx = summaryDays.findIndex((d) => d.scan_date === selectedDate);
  const btnPrev = $('#btn-prev-day');
  const btnNext = $('#btn-next-day');
  // prev = older day = higher index (newest-first array)
  btnPrev.disabled = idx === -1 || idx >= summaryDays.length - 1;
  // next = newer day = lower index
  btnNext.disabled = idx <= 0;
}

/* ─── Summary cards ───────────────────────────────────────────────────────── */

function renderCards() {
  const s = summaryDays.find((d) => d.scan_date === selectedDate);
  const container = $('#cards');
  if (!s) { container.innerHTML = ''; return; }

  // [label, value, extraClass, iconLigature] — icon omitted for pure totals.
  const defs = [
    // RS≥80 / ≥90 share Stage 2 Full's green "highlight" — RS is the entry gate
    // (≥80) and the strongest cohort (≥90); see the "Score או RS" explainer
    // section. Score≥70 was dropped: its 2-year gradient is nearly flat
    // (67.5%→70.9% win) and the 2026-08-03 live study found it carries no
    // information beyond RS, so a Score threshold card asserted a quality
    // cut-off the data does not support.
    ['סה"כ',          s.total,       '',                      null,                    null],
    ['Stage 2 Full',  s.setup_full,  'stat-card--highlight',  'gps_fixed',              null],
    ['Setup/Rec',     s.setup_other, '',                      'visibility',             null],
    ['Breakout',      s.breakout,    '',                      'trending_up',            null],
    ['High Vol',      s.high_volume, '',                      'bolt',                   null],
    ['Pullback',      s.pullback,    '',                      'trending_down',          null],
    ['Stairstep',     s.creep,       '',                      'stairs',                 null],
    ['Near',          s.near_all,    '',                      'hourglass_empty',        null],
    // RS is ranked within OUR watchlist (63d alpha vs SPY), not IBD's
    // full-market 12-month weighted RS Rating — same name, narrower universe.
    ['RS≥80',         s.rs80 ?? 0,   'stat-card--highlight',  'fitness_center',         'RS: percentile rank within our watchlist, not IBD\'s market-wide RS Rating'],
    ['RS≥90',         s.rs90 ?? 0,   'stat-card--highlight',  'local_fire_department',  'RS: percentile rank within our watchlist, not IBD\'s market-wide RS Rating'],
  ];

  container.innerHTML = defs.map(([lbl, val, extra, icon, title]) => `
    <div class="stat-card ${extra}" role="listitem"${title ? ` title="${title}"` : ''}>
      <span class="stat-card-val">${val ?? 0}</span>
      <span class="stat-card-lbl">${icon ? iconHTML(icon) : ''}${lbl}</span>
    </div>`).join('');
}

/* ─── Chart ───────────────────────────────────────────────────────────────── */

function renderChart() {
  const counts = SCORE_LABELS.map(() => 0);
  for (const r of allRows) {
    const s = r.score;
    if (s == null) continue;
    for (let i = 0; i < SCORE_BUCKETS.length - 1; i++) {
      if (s >= SCORE_BUCKETS[i] && s < SCORE_BUCKETS[i + 1]) { counts[i]++; break; }
    }
  }

  if (chart) { chart.destroy(); chart = null; }

  const ctx = $('#dist-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: SCORE_LABELS,
      datasets: [{
        label: 'ציונים',
        data: counts,
        // Same sequential accent ramp as the score column — this is the
        // distribution of that exact number, so the two must agree.
        backgroundColor: [
          'rgba(255,107,53,0.16)',
          'rgba(255,107,53,0.28)',
          'rgba(255,107,53,0.44)',
          'rgba(255,107,53,0.64)',
          'rgba(255,107,53,0.88)',
        ],
        borderColor: 'transparent',
        borderRadius: 2,
      }],
    },
    options: {
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#151923',
          borderColor: '#282e39',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#9da6b9',
        },
      },
      scales: {
        x: {
          ticks: { color: '#9da6b9', font: { size: 10, family: 'Space Grotesk, sans-serif' } },
          grid:  { color: '#282e39' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#9da6b9', font: { size: 10 }, stepSize: 1 },
          grid:  { color: '#282e39' },
        },
      },
    },
  });
}

/* ─── Purple Fragility chart ──────────────────────────────────────────────── */

/**
 * Load the Purple List fragility series (written daily by the Smart pipeline)
 * and render it as a line chart with the 1.0 warning threshold. The series is
 * global (not per selected day) — loaded once at boot. Hidden when empty.
 */
async function loadFragility() {
  let rows = [];
  try {
    const resp = await fetch('/api/fragility');
    if (resp.ok) rows = await resp.json();
  } catch { /* keep panel hidden */ }
  if (!Array.isArray(rows) || rows.length === 0) return;
  fragilityRows = rows;
  $('#fragility-wrap').hidden = false;
  renderFragilityChart(rows, 'fragility-chart');
  $('#williamsr-wrap').hidden = false;
  loadWilliamsFreshness();
}

// Same 10-day window schedule-watchdog.yml uses for williams-r-snapshot.yml, so
// the Telegram alert and this marker agree on what "overdue" means. The capture
// runs Sundays: 10 days is one missed occurrence plus margin.
const WILLIAMSR_STALE_DAYS = 10;

/**
 * Date the Williams %R charts from the stamp deploy-dashboard.yml writes into
 * the bundle. This reports the age of the image actually being served — the
 * chart's last commit on `stable` — so it goes stale for any of the three real
 * causes: the capture stopped running, it runs but fails, or the dashboard was
 * never redeployed after a new chart landed.
 *
 * Deliberately silent on failure: a missing or malformed stamp hides the label
 * rather than showing a date that might be wrong.
 */
async function loadWilliamsFreshness() {
  const el = $('#williamsr-freshness');
  if (!el) return;
  try {
    const resp = await fetch('/assets/williams-r-updated.json', { cache: 'no-store' });
    if (!resp.ok) return;
    const { chartCommittedAt } = await resp.json();
    if (!chartCommittedAt) return;
    const when = new Date(chartCommittedAt);
    if (Number.isNaN(when.getTime())) return;

    const ageDays = Math.floor((Date.now() - when.getTime()) / 86400000);
    const stale = ageDays > WILLIAMSR_STALE_DAYS;
    const label = new Intl.DateTimeFormat('he-IL', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(when);

    el.className = stale ? 'williamsr-freshness is-stale' : 'williamsr-freshness';
    el.innerHTML = stale
      ? `${iconHTML('warning')}הגרף מתאריך ${esc(label)} — ${ageDays} ימים, ייתכן שהעדכון השבועי נתקע`
      : `${iconHTML('event_available')}הגרף מתאריך ${esc(label)}`;
    el.hidden = false;
  } catch { /* leave the label hidden */ }
}

function renderFragilityChart(rows, canvasId) {
  const isModal = canvasId === 'chart-modal-canvas';
  if (isModal) {
    if (fragChartModal) { fragChartModal.destroy(); fragChartModal = null; }
  } else if (fragChart) {
    fragChart.destroy(); fragChart = null;
  }
  const labels = rows.map((r) => r.scan_date.slice(5)); // MM-DD
  const scores = rows.map((r) => r.score);
  const capitulation = rows.map((r) => r.capitulation ?? null);
  const hasCapitulation = capitulation.some((v) => v != null);
  const threshold = rows.map(() => 1.0);
  const qqqIndex = rows.map((r) => r.qqq_index ?? null);
  const hasQqq = qqqIndex.some((v) => v != null);

  // Real two-tier alert rule, reconstructed from fields already in the payload
  // (no bare "score crossed 1.0" — that ignores the near-high gate). canary_count
  // is populated ONLY within 2% of the trailing-250d index high, so it is an exact
  // proxy for the engine's indexNearHigh (verified against the source + D1).
  //   Alert: score >= 1.0 AND near-high
  //   Watch: core3 >= 1.0 OR (climax >= 1.5 AND near-high)
  //
  // The two Watch arms are drawn differently because they perform differently.
  // Against the basket's own >=7% tops over the 252 sessions in D1 (study
  // 2026-07-27, docs/research/fragility-calibration on main): core3 runs 81%
  // precision, climax-only 33% — below the 31% base rate. As of PR #99 only the
  // core3 arm sends a Telegram message; climax stays here because it does add
  // real recall (11/11 top episodes with it, 7/11 without) and a chart you
  // choose to look at pays no price for a mark that doesn't pan out.
  const nearHigh = (r) => r.canary_count != null;
  const isAlert = (r) => r.score != null && r.score >= 1.0 && nearHigh(r);
  const isCore3 = (r) => r.core3 != null && r.core3 >= 1.0;
  const isClimax = (r) => r.climax != null && r.climax >= 1.5 && nearHigh(r);
  const isWatch = (r) => isCore3(r) || isClimax(r);
  // Mark the day each tier NEWLY fires (matches the one-per-crossing Telegram
  // alert), not every day it holds — held-days would flood the recent window.
  // 'watch' = core3 arm (messaged); 'soft' = climax-only (chart-only).
  const marker = rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    if (isAlert(r) && !(prev && isAlert(prev))) return 'alert';
    if (isWatch(r) && !isAlert(r) && !(prev && isWatch(prev))) {
      return isCore3(r) ? 'watch' : 'soft';
    }
    return null;
  });
  const heldState = (r) =>
    // Plain text, no icon markup: this string is drawn into the Chart.js
    // canvas tooltip, where Material Symbols ligatures would render as the
    // literal word ("circle") instead of a glyph.
    isAlert(r) ? 'Alert פעיל'
      : isCore3(r) ? 'Watch פעיל (core3)'
        : isClimax(r) ? 'climax בלבד — תיאורי, לא נשלחת הודעה'
          : 'שקט';

  const ctx = $('#' + canvasId).getContext('2d');
  const chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Fragility (אופוריה)',
          data: scores,
          borderColor: 'rgba(255,107,53,0.95)',
          backgroundColor: 'rgba(255,107,53,0.12)',
          borderWidth: 1.6,
          // Dots mark the day the real rule newly fired. Three weights, matching
          // how much each one earns: Alert (solid red), Watch/core3 (solid white
          // — the arm that still messages; white rather than the accent so it
          // stays legible on the orange line), climax-only (small hollow slate,
          // deliberately quiet: 33% precision, below base rate).
          pointRadius: (ctx) => {
            const m = marker[ctx.dataIndex];
            return m === 'alert' ? 3.6 : m === 'watch' ? 2.6 : m === 'soft' ? 2.2 : 0;
          },
          pointBackgroundColor: (ctx) => {
            const m = marker[ctx.dataIndex];
            return m === 'alert' ? 'rgba(248,113,113,0.95)'
              : m === 'watch' ? 'rgba(255,255,255,0.95)'
                : 'transparent';
          },
          pointBorderColor: (ctx) =>
            (marker[ctx.dataIndex] === 'soft' ? 'rgba(157,166,185,0.8)' : 'transparent'),
          pointBorderWidth: (ctx) => (marker[ctx.dataIndex] === 'soft' ? 1.2 : 0),
          pointHoverRadius: (ctx) => {
            const m = marker[ctx.dataIndex];
            return m === 'alert' ? 4.4 : m === 'watch' ? 3.6 : m === 'soft' ? 3.2 : 3;
          },
          pointHitRadius: 6,
          tension: 0.25,
          fill: false,
        },
        // Capitulation Score (מד המיצוי) — bottom-detection companion, descriptive
        // only. No threshold line for it: our own validation (see explainer tab)
        // found no reliable action level, unlike the Fragility score's 1.0.
        {
          label: 'Capitulation (מיצוי)',
          data: capitulation,
          borderColor: 'rgba(157,166,185,0.95)',
          backgroundColor: 'rgba(157,166,185,0.10)',
          borderWidth: 1.6,
          pointRadius: 0,
          pointHitRadius: 6,
          tension: 0.25,
          fill: false,
          // Off by default (click the legend to enable) — keeps the chart to
          // just the Fragility line on first load; Capitulation/QQQ are
          // secondary overlays, not the primary signal.
          hidden: true,
        },
        // Reference line only — the real Alert also requires the basket to be
        // near its own running high (indexNearHigh, not persisted per-day here),
        // so a score crossing 1.0 on this chart isn't identical to a real alert
        // having fired. See the tooltip / explainer tab for the full rule.
        {
          label: 'סף 1.0 (ייחוס — לא הכלל המלא)',
          data: threshold,
          borderColor: 'rgba(248,113,113,0.7)',
          borderWidth: 1,
          borderDash: [5, 4],
          pointRadius: 0,
          pointHitRadius: 0,
          fill: false,
        },
        // QQQ (Nasdaq-100), rebased to 100 at this chart's first day — plotted
        // on its own right-hand axis (y1) so its price scale never fights the
        // 0-2ish fragility/capitulation scores. Lets you eyeball whether a
        // purple peak actually led the next market pullback.
        {
          label: 'QQQ (נאסד"ק 100, מנורמל)',
          data: qqqIndex,
          borderColor: 'rgba(100,116,139,0.9)',
          borderWidth: 1.4,
          borderDash: [2, 2],
          pointRadius: 0,
          pointHitRadius: 6,
          tension: 0.15,
          fill: false,
          yAxisID: 'y1',
          // Off by default — see Capitulation dataset above for why.
          hidden: true,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#9da6b9',
            font: { size: 10 },
            boxWidth: 12,
            filter: (item) => item.text !== 'סף 1.0 (ייחוס — לא הכלל המלא)',
          },
        },
        tooltip: {
          backgroundColor: '#151923',
          borderColor: '#282e39',
          borderWidth: 1,
          titleColor: '#ffffff',
          bodyColor: '#9da6b9',
          filter: (item) => item.datasetIndex === 0 || item.datasetIndex === 1 || item.datasetIndex === 3,
          callbacks: {
            title: (items) => (items[0] ? rows[items[0].dataIndex].scan_date : ''),
            label: (item) => {
              const r = rows[item.dataIndex];
              const z = (v) => (v == null ? '—' : v.toFixed(1));
              if (item.datasetIndex === 3) {
                return r.qqq_index == null ? 'QQQ: —' : `QQQ: ${r.qqq_index.toFixed(1)} (בסיס 100)`;
              }
              if (item.datasetIndex === 1) {
                return r.capitulation == null
                  ? 'Capitulation: —'
                  : `Capitulation: ${r.capitulation.toFixed(2)} (תיאורי בלבד, לא טריגר)`;
              }
              return [
                heldState(r),
                `ציון: ${r.score.toFixed(2)}  |  core3: ${z(r.core3)}  |  climax: ${z(r.climax)}`,
                `DD: ${r.drawdown_pct == null ? '—' : r.drawdown_pct.toFixed(1) + '%'}` +
                  (r.canary_count != null ? ` | Canary: ${r.canary_count}` : ' | רחוק מהשיא'),
                `wick ${z(r.wick10_z)} | %>50 ${z(r.pct_above50_z)} | dist ${z(r.dist20_z)}`,
                `ext ${z(r.ext50_z)} | corr ${z(r.corr20_z)} | disp ${z(r.disp10_z)}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#9da6b9',
            font: { size: 9, family: 'Space Grotesk, sans-serif' },
            maxTicksLimit: 12,
            maxRotation: 0,
          },
          grid: { color: '#282e39' },
        },
        y: {
          ticks: { color: '#9da6b9', font: { size: 10 } },
          grid: { color: '#282e39' },
        },
        y1: {
          position: 'right',
          display: hasQqq,
          ticks: { color: 'rgba(100,116,139,0.9)', font: { size: 10 } },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });

  if (isModal) fragChartModal = chartInstance;
  else fragChart = chartInstance;
}

/* ─── Chart modal (expanded view) ─────────────────────────────────────────── */

function openFragilityModal() {
  if (fragilityRows.length === 0) return;
  $('#chart-modal-title').innerHTML = document.querySelector('#fragility-wrap .chart-title').innerHTML;
  $('#chart-modal').hidden = false;
  $('#chart-modal-overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  renderFragilityChart(fragilityRows, 'chart-modal-canvas');

  const modal = $('#chart-modal');
  modal._escHandler = (e) => { if (e.key === 'Escape') closeFragilityModal(); };
  document.addEventListener('keydown', modal._escHandler);
}

function closeFragilityModal() {
  const modal = $('#chart-modal');
  $('#chart-modal').hidden = true;
  $('#chart-modal-overlay').hidden = true;
  document.body.style.overflow = '';
  if (fragChartModal) { fragChartModal.destroy(); fragChartModal = null; }
  if (modal._escHandler) { document.removeEventListener('keydown', modal._escHandler); modal._escHandler = null; }
}

/* ─── Image lightbox (zoomed TradingView snapshots) ───────────────────────── */

/**
 * Opens the zoomed view of a thumbnail image at its natural size.
 * @param {HTMLImageElement} img the thumbnail that was clicked
 * @returns {void}
 */
function openImgLightbox(img) {
  const box = $('#img-lightbox');
  const zoomed = $('#img-lightbox-img');
  zoomed.src = img.currentSrc || img.src;
  zoomed.alt = img.alt;
  $('#img-lightbox-title').textContent = img.alt;
  box.hidden = false;
  $('#img-lightbox-overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#btn-close-img-lightbox').focus();

  box._escHandler = (e) => { if (e.key === 'Escape') closeImgLightbox(); };
  document.addEventListener('keydown', box._escHandler);
}

function closeImgLightbox() {
  const box = $('#img-lightbox');
  box.hidden = true;
  $('#img-lightbox-overlay').hidden = true;
  // Drop the source so a stale image never flashes on the next open.
  $('#img-lightbox-img').removeAttribute('src');
  document.body.style.overflow = '';
  if (box._escHandler) { document.removeEventListener('keydown', box._escHandler); box._escHandler = null; }
}

/* ─── Filtering / sorting ─────────────────────────────────────────────────── */

/**
 * Returns true if the row's primary signal is a "near" (silent watchlist) tier.
 * @param {object} r
 * @returns {boolean}
 */
function isNearRow(r) {
  return (r.signal || '').startsWith('near');
}

/** Count of rows hidden ONLY by the near-tier default filter (set by visibleRows). */
let hiddenNearCount = 0;
/** Count of near-tier rows currently visible (set by visibleRows) — drives the collapse label. */
let shownNearCount = 0;

function visibleRows() {
  const q    = ($('#search').value || '').trim().toUpperCase();
  const reg  = $('#f-region').value;
  const sig  = $('#f-signal').value;
  const s2   = $('#f-stage2').checked;
  const grad = $('#f-grad').checked;

  hiddenNearCount = 0;

  const filtered = allRows.filter((r) => {
    if (q    && !(r.ticker || '').toUpperCase().includes(q)) return false;
    if (reg  && r.region !== reg)   return false;
    // Match against the FULL signals list, not just the primary — merged rows
    // (e.g. "pullback,setupClose") must be findable by any of their signals.
    if (sig && r.signal !== sig &&
        !(r.signals || '').split(',').map((s) => s.trim()).includes(sig)) return false;
    if (s2   && r.stage2 !== 1)     return false;
    if (grad && !r.graduated_from)  return false;

    // Near-tier filter: hide near-* rows unless showNear is on OR the user
    // explicitly selected a near signal from the dropdown. Counted after the
    // other filters so the "show more" button reports how many rows it reveals.
    const nearExplicit = sig.startsWith('near');
    if (!showNear && !nearExplicit && isNearRow(r)) {
      hiddenNearCount++;
      return false;
    }
    return true;
  });

  shownNearCount = filtered.filter(isNearRow).length;

  return filtered.sort((a, b) => {
    let x = a[sortKey], y = b[sortKey];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === 'string') x = x.toLowerCase();
    if (typeof y === 'string') y = y.toLowerCase();
    return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
  });
}

/* ─── Table head ──────────────────────────────────────────────────────────── */

function renderHead() {
  const head = $('#grid-head');
  head.innerHTML = '<tr>' + COLS.map(([k, lbl]) => {
    const sorted = sortKey === k;
    const arrow  = sorted ? (sortDir < 0 ? ' ↓' : ' ↑') : '';
    const aSort  = sorted ? (sortDir < 0 ? 'descending' : 'ascending') : 'none';
    return `<th data-k="${k}" scope="col" aria-sort="${aSort}">${lbl}${arrow}</th>`;
  }).join('') + '</tr>';

  head.querySelectorAll('th').forEach((th) => {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (sortKey === k) sortDir *= -1;
      else { sortKey = k; sortDir = -1; }
      renderTable();
    });
  });
}

/* ─── Table body ──────────────────────────────────────────────────────────── */

function renderTable() {
  renderHead();

  const vr = visibleRows();
  const total = allRows.length;
  $('#row-count').textContent = vr.length === total
    ? `${vr.length} שורות`
    : `${vr.length} מוצגות מתוך ${total}`;
  // A ticker search with no rows on this day is the exact case the old search
  // dead-ended on. Offer the cross-day lookup instead of "אין תוצאות".
  const q = ($('#search').value || '').trim().toUpperCase();
  if (vr.length === 0 && !hiddenNearCount && q) {
    showState(null);
    showTickerMiss(q);
  } else {
    hideTickerMiss();
    showState(vr.length === 0 && !hiddenNearCount ? 'אין תוצאות לסינון הנוכחי' : null);
  }
  renderShowMore();

  /* — desktop table — */
  const tbody = $('#grid-body');
  tbody.innerHTML = vr.map((r, i) => {
    const conf = (r.signal_count > 1) || false;
    const grad = !!r.graduated_from;

    const tds = COLS.map(([k, , cls]) => {
      let inner = '';
      let extraCls = cls;

      switch (k) {
        case 'ticker':
          inner = r.ticker || '';
          break;
        case 'region':
          inner = r.region || '';
          break;
        case 'sector':
          inner = (r.sector || '').slice(0, 22); // truncate long sector names
          break;
        case 'signals':
          inner = signalBadgesHTML(r);
          break;
        case 'rvol':
          inner = fmtRvol(r.rvol);
          break;
        case 'ath_pct':
          inner = `<span class="${fmtPctClass(r.ath_pct)}">${fmtPct(r.ath_pct)}</span>`;
          break;
        case 'day_pct':
          inner = `<span class="${fmtPctClass(r.day_pct)}">${fmtPct(r.day_pct)}</span>`;
          break;
        case 'stage2':
          inner = r.stage2 ? `<span class="num-up" title="Stage 2">${iconHTML('check')}</span>` : '';
          break;
        case 'rs': {
          // RS percentile — the ranking metric that survived the 2y score study.
          if (r.rs == null) return `<td class="${cls}" data-v="-1">—</td>`;
          const flame = r.rs >= 90 ? iconHTML('local_fire_department', 'rs-flame') : '';
          return `<td class="${cls}" data-v="${r.rs}"><span class="${r.rs >= 90 ? 'num-up' : ''}">${r.rs}${flame}</span></td>`;
        }
        case 'score': {
          const bg    = scoreBg(r.score);
          const delta = scoreDeltaHTML(r.score_delta);
          return `<td class="${cls}" style="background:${bg}" data-v="${r.score ?? -1}">${r.score ?? '—'}${delta}</td>`;
        }
        case 'price':
          inner = fmtPrice(r.price);
          break;
        default:
          inner = r[k] ?? '';
      }
      return `<td class="${extraCls}">${inner}</td>`;
    }).join('');

    // grad wins over conf for the data attribute — CSS uses data-grad first
    return `<tr data-i="${i}" data-conf="${conf}" data-grad="${grad}" tabindex="0" role="row">${tds}</tr>`;
  }).join('');

  /* attach row click handlers */
  tbody.querySelectorAll('tr').forEach((tr) => {
    const idx = parseInt(tr.dataset.i, 10);
    tr.addEventListener('click', () => openDeepDive(vr[idx]));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDeepDive(vr[idx]); });
  });

  /* — mobile card list — */
  const cardList = $('#card-list');
  cardList.innerHTML = vr.map((r, i) => {
    const conf  = (r.signal_count > 1) || false;
    const grad  = !!r.graduated_from;
    const sc    = r.score ?? null;
    const scBg  = scoreBg(sc);
    const scClr = scoreColor(sc);
    const delta = scoreDeltaHTML(r.score_delta);
    return `
      <div
        class="signal-card"
        data-i="${i}"
        data-conf="${conf}"
        data-grad="${grad}"
        tabindex="0"
        role="button"
        aria-label="${r.ticker}, ציון ${sc ?? '—'}"
      >
        <div class="sc-top">
          <span class="sc-ticker">${r.ticker || ''}</span>
          <span class="sc-score-badge" style="background:${scBg};color:${scClr}">Score ${sc ?? '—'}${delta}</span>
        </div>
        <div class="sc-badges">${signalBadgesHTML(r)}</div>
        <div class="sc-grid">
          <div class="sc-kv"><span class="sc-k">RVOL</span><span class="sc-v">${fmtRvol(r.rvol)}</span></div>
          <div class="sc-kv"><span class="sc-k">יום%</span><span class="sc-v ${fmtPctClass(r.day_pct)}">${fmtPct(r.day_pct)}</span></div>
          <div class="sc-kv"><span class="sc-k">ATH%</span><span class="sc-v ${fmtPctClass(r.ath_pct)}">${fmtPct(r.ath_pct)}</span></div>
          <div class="sc-kv"><span class="sc-k">מחיר</span><span class="sc-v">${fmtPrice(r.price)}</span></div>
          <div class="sc-kv"><span class="sc-k">RS</span><span class="sc-v ${(r.rs ?? 0) >= 90 ? 'num-up' : ''}">${r.rs != null ? r.rs + (r.rs >= 90 ? iconHTML('local_fire_department', 'rs-flame') : '') : '—'}</span></div>
          <div class="sc-kv"><span class="sc-k">S2</span><span class="sc-v ${r.stage2 ? 'num-up' : ''}">${r.stage2 ? iconHTML('check') : '—'}</span></div>
        </div>
      </div>`;
  }).join('');

  cardList.querySelectorAll('.signal-card').forEach((card) => {
    const idx = parseInt(card.dataset.i, 10);
    card.addEventListener('click', () => openDeepDive(vr[idx]));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDeepDive(vr[idx]); });
  });
}

/* ─── Show-more (near tier) ───────────────────────────────────────────────── */

/**
 * Render the near-tier toggle button under the table. While near rows are
 * hidden it offers to load them; once loaded it flips to a collapse action
 * (kept in sync with the #f-near checkbox). Hidden when a near signal is
 * explicitly selected in the dropdown (nothing to toggle) or no near rows
 * exist for the current filters.
 */
function renderShowMore() {
  const wrap = $('#show-more-wrap');
  const btn  = $('#btn-show-more');
  if (!wrap || !btn) return;

  if (hiddenNearCount > 0) {
    btn.innerHTML = `${iconHTML('expand_more')}טען עוד ${hiddenNearCount} ניירות — רשימת מעקב שקטה (Near)`;
    wrap.hidden = false;
  } else if (showNear && shownNearCount > 0) {
    btn.innerHTML = `${iconHTML('expand_less')}הסתר ${shownNearCount} ניירות — רשימת מעקב שקטה (Near)`;
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
}

/* ─── Deep-dive panel ─────────────────────────────────────────────────────── */

/** BASE points per signal kind — client-side mirror of dashboardRows.scoreRow
 *  (lean kinds) and the setup-backfill scoring (setup kinds). */
const SCORE_BASE = {
  pullback: 50, creep: 42, nearPullback: 38, highVolume: 30,
  nearHighVol: 18, breakout: 12, nearBreakout: 8,
  setupFull: 60, setupRecovery: 55, setupClose: 40,
};

/**
 * Itemized score breakdown for the deep-dive. Mirrors the server formulas;
 * any drift (regime bonus, historic formula versions) lands in a residual
 * line so the items always sum to the actual score.
 * @returns {Array<[string, number]>}
 */
function scoreBreakdown(r) {
  const sigs = (r.signals || r.signal || '').split(',').map((s) => s.trim()).filter(Boolean);
  const isSetupOnly = sigs.length > 0 && sigs.every((s) => s.startsWith('setup'));
  const items = [];
  const rvolTerm = Math.min(r.rvol || 0, 6) * 5;

  if (isSetupOnly) {
    // Setup-backfill rows: BASE + min(RVOL,6)*5 + Stage2 + RS>=90 bonus.
    const base = Math.max(...sigs.map((s) => SCORE_BASE[s] ?? 0));
    items.push([`בסיס ${readableSignal(sigs[0])}`, base]);
    items.push(['RVOL ×5 (עד 30)', Math.round(rvolTerm)]);
    if (r.stage2) items.push(['Stage 2', 20]);
    if ((r.rs ?? 0) >= 90) items.push([`RS ≥ 90${iconHTML('local_fire_department', 'rs-flame')}`, 10]);
  } else {
    const leanSigs = sigs.filter((s) => !s.startsWith('setup'));
    const base = Math.max(...leanSigs.map((s) => SCORE_BASE[s] ?? 0), 0);
    const strongest = leanSigs.find((s) => (SCORE_BASE[s] ?? 0) === base) || leanSigs[0] || '';
    items.push([`בסיס ${readableSignal(strongest)}`, base]);
    items.push(['RVOL ×5 (עד 30)', Math.round(rvolTerm)]);
    if (r.stage2) items.push(['Stage 2', 20]);
    if (r.dist_pivot != null) {
      const piv = Math.max(0, 10 - r.dist_pivot * 4);
      if (piv > 0) items.push(['קרבה לפיבוט', Math.round(piv)]);
    }
    if (sigs.length > 1) items.push([`קונפלואנס ×${sigs.length}`, (sigs.length - 1) * 12]);
    if (leanSigs.includes('highVolume') && (r.day_pct || 0) < 0) items.push(['ווליום על ירידה (climax)', -25]);
    if ((r.rvol || 0) >= 8) items.push(['RVOL ≥ 8 (אזהרת climax)', -15]);
    if (r.ath_pct != null && r.ath_pct < -30) items.push(['עמוק מתחת לשיא (>30%-)', -20]);
    if (/ETF/i.test(r.sector || '')) items.push(['ETF', -12]);
  }

  const sum = items.reduce((a, [, v]) => a + v, 0);
  const resid = Math.round((r.score ?? sum) - sum);
  if (resid !== 0) items.push(['אחר (רג\'ים / עיגול)', resid]);
  return items;
}

function scoreBreakdownHTML(r) {
  if (r.score == null) return '';
  const rows = scoreBreakdown(r).map(([label, pts]) => {
    const cls = pts >= 0 ? 'num-up' : 'num-down';
    const sign = pts >= 0 ? '+' : '';
    return `<div class="dd-kv"><div class="dd-k">${label}</div><div class="dd-v ${cls}">${sign}${pts}</div></div>`;
  }).join('');
  return `
    <div class="dd-sub" style="margin-top:14px">פירוק הציון (${r.score})</div>
    <div class="dd-grid">${rows}</div>`;
}

/**
 * Open the side panel with arbitrary content. Shared by the row deep-dive and
 * the ticker-history view so both get the same close button, overlay, Escape
 * handling and focus behaviour.
 * @param {string} html - must contain a #btn-close-dd button
 * @param {boolean} [wide] - widen the panel (the history table needs the room)
 */
function openPanel(html, wide = false) {
  const panel   = $('#deepdive');
  const overlay = $('#deepdive-overlay');
  panel.classList.toggle('deepdive--wide', wide);

  // Re-opening without closing (row → history) would otherwise stack handlers.
  if (panel._escHandler) {
    document.removeEventListener('keydown', panel._escHandler);
    panel._escHandler = null;
  }

  $('#deepdive-inner').innerHTML = html;
  panel.hidden   = false;
  overlay.hidden = false;
  overlay.removeAttribute('aria-hidden');
  panel.scrollTop = 0;

  panel.querySelector('#btn-close-dd').addEventListener('click', closeDeepDive);
  overlay.addEventListener('click', closeDeepDive, { once: true });

  panel._escHandler = (e) => { if (e.key === 'Escape') closeDeepDive(); };
  document.addEventListener('keydown', panel._escHandler);
}

function openDeepDive(r) {
  const tvSymbol = (r.ticker || '').replace(/\./g, '-');
  const tvUrl    = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;

  // Graduation banner
  const gradBanner = r.graduated_from
    ? `<div class="dd-grad-banner" role="note" aria-label="Graduation">
        ${iconHTML('school')}Graduated from: ${readableSignal(r.graduated_from)}
       </div>`
    : '';

  // Score delta for deep-dive
  const deltaHtml = scoreDeltaHTML(r.score_delta);

  // Streak note
  const streakNote = (r.streak && r.streak > 1)
    ? `<span class="streak-chip" title="${r.streak} ימים ברצף">${iconHTML('calendar_month')}${r.streak}d ברצף</span>`
    : '';

  const pairs = [
    ['Score',  `${r.score ?? '—'}${deltaHtml ? ' ' + deltaHtml.replace(/class="delta-/g, 'class="delta-') : ''}`],
    ['RS',     r.rs != null ? `${r.rs}${r.rs >= 90 ? iconHTML('local_fire_department', 'rs-flame') : ''}` : '—'],
    ['RVOL',   fmtRvol(r.rvol)],
    ['ATH%',   fmtPct(r.ath_pct)],
    ['יום%',   fmtPct(r.day_pct)],
    ['לפיבוט', r.dist_pivot != null ? fmtPct(r.dist_pivot) : '—'],
    ['מחיר',   fmtPrice(r.price)],
    ['Stage2', r.stage2 ? `${iconHTML('check')}כן` : `${iconHTML('close')}לא`],
    ['אזור',   r.region || '—'],
  ];

  if (r.streak && r.streak > 1) {
    pairs.push(['Streak', `${r.streak} ימים`]);
  }

  if (r.graduated_from) {
    pairs.push(['Graduated', readableSignal(r.graduated_from)]);
  }

  const gridHTML = pairs.map(([k, v]) => `
    <div class="dd-kv">
      <div class="dd-k">${k}</div>
      <div class="dd-v">${v}</div>
    </div>`).join('');

  openPanel(`
    <button class="btn-close" id="btn-close-dd" aria-label="סגור פאנל">${iconHTML('close')}</button>
    ${gradBanner}
    <div class="dd-ticker">${r.ticker || ''} ${streakNote}</div>
    <div class="dd-sub">${r.sector || ''} · ${r.region || ''}</div>
    <div class="dd-badges">${signalBadgesHTML(r)}</div>
    <div class="dd-grid">${gridHTML}</div>
    ${scoreBreakdownHTML(r)}
    <button type="button" class="dd-history-btn" data-ticker="${r.ticker || ''}">
      ${iconHTML('history')}כל ההופעות של ${r.ticker || ''} בהיסטוריה
    </button>
    <a class="dd-tv-link" href="${tvUrl}" target="_blank" rel="noopener noreferrer">
      פתח ב-TradingView ↗
    </a>`);

  const histBtn = $('#deepdive').querySelector('.dd-history-btn');
  if (histBtn) histBtn.addEventListener('click', () => openTickerHistory(histBtn.dataset.ticker));
}

function closeDeepDive() {
  const panel   = $('#deepdive');
  const overlay = $('#deepdive-overlay');
  panel.hidden   = true;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  if (panel._escHandler) {
    document.removeEventListener('keydown', panel._escHandler);
    panel._escHandler = null;
  }
}

/* ─── Ticker history (cross-day search) ───────────────────────────────────── */

/**
 * Every ticker ever scanned: [{ticker, appearances, last_seen}]. Loaded once,
 * feeds the search box's <datalist> so names that are NOT in today's scan can
 * still be typed and looked up.
 * @type {Array<object>}
 */
let tickerIndex = [];

/** Escape a value for interpolation into HTML. Ticker text is user-typed. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function loadTickerIndex() {
  try {
    const resp = await fetch('/api/tickers');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    tickerIndex = await resp.json();
  } catch {
    tickerIndex = []; // autocomplete is a convenience — search still works without it
    return;
  }
  $('#ticker-list').innerHTML = tickerIndex
    .map((t) => `<option value="${esc(t.ticker)}">${esc(t.last_seen)} · ${t.appearances} הופעות</option>`)
    .join('');
}

/**
 * Inline prompt shown when a ticker search matches nothing on the selected day.
 * The last-seen date comes from the already-loaded index, so the answer to
 * "when did it last fire?" appears without a round trip.
 * @param {string} q - the uppercased search query
 */
function showTickerMiss(q) {
  const el = $('#ticker-miss');
  const exact = tickerIndex.find((t) => t.ticker === q);
  const prefix = exact ? [] : tickerIndex.filter((t) => t.ticker.startsWith(q)).slice(0, 6);

  if (exact) {
    el.innerHTML = `
      ${iconHTML('history')}
      <span><strong>${esc(q)}</strong> לא בסריקה של ${esc(selectedDate || '')} —
      הופיעה לאחרונה ב-<strong>${esc(exact.last_seen)}</strong> (${exact.appearances} הופעות)</span>
      <button type="button" class="btn-miss" data-ticker="${esc(q)}">${iconHTML('open_in_new')}פתח היסטוריה</button>`;
  } else if (prefix.length) {
    el.innerHTML = `
      ${iconHTML('search')}
      <span>אין <strong>${esc(q)}</strong> בסריקה של היום. אולי:</span>
      ${prefix.map((t) => `<button type="button" class="btn-miss" data-ticker="${esc(t.ticker)}">${esc(t.ticker)}<span class="btn-miss-meta">${esc(t.last_seen)}</span></button>`).join('')}`;
  } else {
    el.innerHTML = `
      ${iconHTML('search_off')}
      <span><strong>${esc(q)}</strong> לא הופיעה באף סריקה.</span>
      <button type="button" class="btn-miss" data-ticker="${esc(q)}">${iconHTML('open_in_new')}בדוק בהיסטוריה</button>`;
  }

  el.hidden = false;
  el.querySelectorAll('.btn-miss').forEach((b) =>
    b.addEventListener('click', () => openTickerHistory(b.dataset.ticker))
  );
}

function hideTickerMiss() {
  const el = $('#ticker-miss');
  el.hidden = true;
  el.innerHTML = '';
}

/** "לפני 4 ימי סריקה" / "בסריקה האחרונה" */
function sinceLabel(n) {
  if (n == null) return '';
  if (n === 0) return 'בסריקה האחרונה';
  if (n === 1) return 'לפני יום סריקה אחד';
  return `לפני ${n} ימי סריקה`;
}

/** One highlighted appearance ("the day it jumped"), or '' if there is none. */
function peakCardHTML(label, icon, row, valueHTML) {
  if (!row) return '';
  return `
    <button type="button" class="th-peak" data-date="${esc(row.scan_date)}">
      <span class="th-peak-label">${iconHTML(icon)}${label}</span>
      <span class="th-peak-value">${valueHTML}</span>
      <span class="th-peak-date">${esc(row.scan_date)}</span>
    </button>`;
}

function tickerHistoryHTML(h) {
  const head = `
    <button class="btn-close" id="btn-close-dd" aria-label="סגור פאנל">${iconHTML('close')}</button>
    <div class="dd-ticker">${esc(h.ticker)}</div>`;

  // Never scanned into a signal — say exactly that, and over what window, so
  // it does not read as "this stock never moved". The radar only records days
  // a name cleared the filter.
  if (h.total === 0) {
    const sugg = (h.suggestions || []).length
      ? `<div class="th-sub">אולי התכוונת:</div>
         <div class="th-suggest">${h.suggestions.map((s) => `
           <button type="button" class="th-sugg-btn" data-ticker="${esc(s.ticker)}">
             ${esc(s.ticker)}<span class="th-sugg-meta">${esc(s.last_seen)}</span>
           </button>`).join('')}</div>`
      : '';
    return `${head}
      <div class="th-empty">
        ${iconHTML('search_off')}
        <p><strong>${esc(h.ticker)}</strong> לא הופיעה באף סריקה.</p>
        <p class="th-note">
          ההיסטוריה מכסה ${h.scanned_days} ימי סריקה, ${esc(h.history_from)} → ${esc(h.history_to)}.
          נרשמים רק ימים שבהם המנייה עברה את הפילטר — היעדר שורה אינו אומר שהיא לא זזה.
        </p>
      </div>
      ${sugg}`;
  }

  const latest = h.appearances[0];
  const kv = [
    ['סה"כ הופעות', h.total],
    ['הופעה ראשונה', esc(h.first_seen)],
    ['רצף הכי ארוך', `${h.longest_streak} ימים`],
    ['רצף אחרון', `${h.latest_streak} ימים`],
  ].map(([k, v]) => `<div class="dd-kv"><div class="dd-k">${k}</div><div class="dd-v">${v}</div></div>`).join('');

  const signalChips = Object.entries(h.by_signal)
    .sort((a, b) => b[1] - a[1])
    .map(([sig, n]) => `<span class="th-chip">${badgeHTML(sig, false)}<span class="th-chip-n">×${n}</span></span>`)
    .join('');

  const peaks = [
    peakCardHTML('RVOL שיא', 'bolt', h.peak_rvol, fmtRvol(h.peak_rvol && h.peak_rvol.rvol)),
    peakCardHTML('היום הכי חזק', 'trending_up', h.peak_day,
      `<span class="${fmtPctClass(h.peak_day && h.peak_day.day_pct)}">${fmtPct(h.peak_day && h.peak_day.day_pct)}</span>`),
    peakCardHTML('ציון שיא', 'star', h.peak_score, String((h.peak_score && h.peak_score.score) ?? '—')),
  ].join('');

  const rows = h.appearances.map((r) => `
    <tr class="th-row" data-date="${esc(r.scan_date)}" tabindex="0">
      <td class="th-date">${esc(r.scan_date)}</td>
      <td class="th-badges">${signalBadgesHTML(r)}</td>
      <td class="col-mono">${fmtRvol(r.rvol)}</td>
      <td class="col-mono"><span class="${fmtPctClass(r.day_pct)}">${fmtPct(r.day_pct)}</span></td>
      <td class="col-mono">${r.rs != null ? r.rs : '—'}</td>
      <td class="col-mono">${r.score ?? '—'}</td>
    </tr>`).join('');

  const tvUrl = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(h.ticker.replace(/\./g, '-'))}`;

  return `${head}
    <div class="dd-sub">${esc(latest.sector || '')}${latest.sector && latest.region ? ' · ' : ''}${esc(latest.region || '')}</div>

    <div class="th-headline">
      <div class="th-headline-label">${iconHTML('event_available')}הופיעה לאחרונה</div>
      <div class="th-headline-date">${esc(h.last_seen)}</div>
      <div class="th-headline-since">${sinceLabel(h.scan_days_since)}</div>
      <div class="th-headline-badges">${signalBadgesHTML(latest)}</div>
    </div>

    <div class="dd-grid">${kv}</div>
    ${peaks ? `<div class="dd-sub" style="margin-top:14px">שיאים</div><div class="th-peaks">${peaks}</div>` : ''}
    ${signalChips ? `<div class="dd-sub" style="margin-top:14px">סוגי איתות</div><div class="th-chips">${signalChips}</div>` : ''}

    <div class="dd-sub" style="margin-top:14px">כל ההופעות (${h.total}) — לחיצה קופצת לאותו יום</div>
    <div class="th-table-wrap">
      <table class="th-table">
        <thead><tr><th>תאריך</th><th>סיגנלים</th><th>RVOL</th><th>יום%</th><th>RS</th><th>ציון</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="th-note">
      מוצגים רק ימים שבהם המנייה עברה את פילטר הסריקה, מתוך ${h.scanned_days} ימי סריקה
      (${esc(h.history_from)} → ${esc(h.history_to)}).
    </p>
    <a class="dd-tv-link" href="${tvUrl}" target="_blank" rel="noopener noreferrer">
      פתח ב-TradingView ↗
    </a>`;
}

/**
 * Look a ticker up across EVERY scan day and show it in the side panel.
 * @param {string} raw - user-typed or clicked ticker
 */
async function openTickerHistory(raw) {
  const ticker = (raw || '').trim().toUpperCase();
  if (!ticker) return;

  openPanel(`
    <button class="btn-close" id="btn-close-dd" aria-label="סגור פאנל">${iconHTML('close')}</button>
    <div class="dd-ticker">${esc(ticker)}</div>
    <div class="th-loading">${iconHTML('hourglass_empty')}טוען היסטוריה…</div>`, true);

  let h;
  try {
    const resp = await fetch(`/api/ticker?t=${encodeURIComponent(ticker)}`);
    // 400 = the API rejected the string as a ticker; say that rather than
    // reporting a transport error the user cannot act on.
    if (resp.status === 400) throw new Error(`"${ticker}" לא נראה כמו סימבול של מנייה`);
    if (!resp.ok) throw new Error(`שגיאה בטעינת ההיסטוריה: HTTP ${resp.status}`);
    h = await resp.json();
  } catch (err) {
    openPanel(`
      <button class="btn-close" id="btn-close-dd" aria-label="סגור פאנל">${iconHTML('close')}</button>
      <div class="dd-ticker">${esc(ticker)}</div>
      <div class="th-empty">${iconHTML('error')}<p>${esc(err.message || 'שגיאה בטעינת ההיסטוריה')}</p></div>`, true);
    return;
  }

  openPanel(tickerHistoryHTML(h), true);

  const panel = $('#deepdive');
  panel.querySelectorAll('[data-date]').forEach((el) =>
    el.addEventListener('click', () => jumpToDay(el.dataset.date, h.ticker))
  );
  panel.querySelectorAll('.th-row').forEach((el) =>
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToDay(el.dataset.date, h.ticker); }
    })
  );
  panel.querySelectorAll('.th-sugg-btn').forEach((el) =>
    el.addEventListener('click', () => openTickerHistory(el.dataset.ticker))
  );
}

/**
 * Jump the whole dashboard to one day with the ticker pre-filtered.
 * Near-tier rows are revealed on the way in: the ticker may well have been a
 * near signal that day, and it would otherwise land on an empty table.
 * @param {string} date
 * @param {string} ticker
 */
async function jumpToDay(date, ticker) {
  if (!date) return;
  closeDeepDive();
  $('#search').value = ticker;
  showNear = true;
  $('#f-near').checked = true;
  // selectDay is a no-op when the day is already loaded — re-render for the
  // new search filter instead. The calendar popover re-syncs when it opens.
  if (date === selectedDate) renderTable();
  else await selectDay(date);
}

/* ─── Day selection ───────────────────────────────────────────────────────── */

async function selectDay(date) {
  if (date === selectedDate) return;
  selectedDate = date;

  // Update date picker button label
  $('#selected-date').textContent = date || '—';

  // Update nav button states
  updateNavButtons();

  showState('טוען…');
  try {
    const url = date ? `/api/signals?from=${date}&to=${date}` : '/api/signals';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    allRows = await resp.json();
  } catch (err) {
    showState(`שגיאה בטעינת נתונים: ${err.message}`);
    allRows = [];
  }

  renderCards();
  renderChart();
  renderTable();
  updateHeaderMeta();
}

/* ─── Header meta ─────────────────────────────────────────────────────────── */

/** Format an ISO run timestamp for display in Israel time, e.g. "23:15 07.07". */
function fmtRunTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('hour')}:${g('minute')} ${g('day')}.${g('month')}`;
}

function updateHeaderMeta() {
  const s = summaryDays.find((d) => d.scan_date === selectedDate);
  if (!s) { $('#header-meta').textContent = ''; return; }
  const run = fmtRunTime(s.last_run);
  const runPart = run ? ` · ריצה אחרונה: ${run}` : '';
  // Leads with RS≥80 (the documented entry gate) rather than Score≥70, to match
  // the stat cards. Sourced from allRows for the same reason they are.
  $('#header-meta').textContent = `${s.total} סיגנלים · RS≥80: ${s.rs80 ?? 0}${runPart}`;
}

/* ─── Current TradingView watchlist (separate app/branch, read via /api/watchlist) ─ */

async function loadWatchlist() {
  let state = { updatedAt: null, watchlists: {} };
  try {
    const resp = await fetch('/api/watchlist');
    if (resp.ok) state = await resp.json();
  } catch { /* fall through to empty state below */ }

  // The list is additive — a ticker can sit there for up to 14 days without
  // being re-flagged. Pull the LATEST scan day (not the date-picker selection,
  // which this tab is independent of) so each row can say whether the radar
  // still fires on it today.
  let todayRows = null;
  const todayDate = summaryDays[0] ? summaryDays[0].scan_date : null;
  if (todayDate) {
    try {
      const resp = await fetch(`/api/signals?from=${todayDate}&to=${todayDate}`);
      if (resp.ok) todayRows = await resp.json();
    } catch { /* status column degrades to "—" below */ }
  }

  renderWatchlist(state, todayRows, todayDate);
}

/**
 * Resolve a watchlist entry to its row in the latest scan, if the radar flagged
 * it again today. Exchange-aware so a foreign listing never matches its US
 * namesake (and vice versa).
 * @param {{ticker: string, exchange?: string}} entry
 * @param {Map<string, object>} byTicker - D1 ticker (upper) → row
 * @param {Map<string, Array<object>>} byBase - base symbol (upper) → rows
 * @returns {object|null}
 */
function matchTodayRow(entry, byTicker, byBase) {
  const base = (entry.ticker || '').toUpperCase();
  if (!base) return null;

  // No exchange tag = US listing: only an exact, suffix-less match counts.
  if (!entry.exchange) return byTicker.get(base) || null;

  const suffix = EXCHANGE_SUFFIX[entry.exchange];
  if (suffix) return byTicker.get(base + suffix) || null;

  // Unknown/ambiguous tag (EURONEXT → .PA or .AS): any non-US listing wins.
  const candidates = byBase.get(base) || [];
  return candidates.find((r) => r.ticker.includes('.')) || null;
}

/** Whole calendar days between two ISO dates (yyyy-mm-dd). */
function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function renderWatchlist(state, todayRows, todayDate) {
  const meta = $('#watchlist-meta');
  const wrap = $('#watchlist-sections');
  const names = Object.keys(state.watchlists || {});

  if (!state.updatedAt || names.length === 0) {
    meta.textContent = 'לא ניתן לטעון כרגע — נסה שוב מאוחר יותר.';
    wrap.innerHTML = '';
    return;
  }

  const statusHead = todayRows ? `סטטוס ב-${todayDate}` : 'סטטוס היום';
  meta.textContent = `כפי שנשלח ל-TradingView (tv-sync) · עודכן לאחרונה: ${state.updatedAt}`
    + (todayRows ? ` · סטטוס מול סריקת ${todayDate}` : '');

  // Lookups for "did the radar flag it again today?"
  const byTicker = new Map();
  const byBase = new Map();
  for (const r of todayRows || []) {
    const t = (r.ticker || '').toUpperCase();
    if (!t) continue;
    byTicker.set(t, r);
    const base = t.split('.')[0];
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(r);
  }

  wrap.innerHTML = names.map((name) => {
    const rows = [...(state.watchlists[name] || [])].sort(
      (a, b) => b.signalDate.localeCompare(a.signalDate)
    );
    const body = rows.length
      ? rows.map((r) => {
        const age = todayDate ? daysBetween(r.signalDate, todayDate) : null;
        // 14 days without a fresh flag = auto-pruned on the next sync.
        const ageCell = age == null
          ? '—'
          : `<span title="14 יום ללא איתות חדש → גיזום אוטומטי בסנכרון הבא">${age}</span>`;
        const hit = todayRows ? matchTodayRow(r, byTicker, byBase) : null;
        let status;
        if (!todayRows) status = '—';
        else if (hit) status = `<span class="wl-live">${iconHTML('check_circle')}נדלק היום</span> ${badgeHTML((hit.signal || '').trim(), true)}`;
        else status = `<span class="wl-aged">${iconHTML('schedule')}ותק בלבד</span>`;
        return `
        <tr>
          <td>${r.ticker}</td>
          <td class="et-sub">${r.signalDate}</td>
          <td class="et-sub">${ageCell}</td>
          <td>${status}</td>
        </tr>
      `;
      }).join('')
      : `<tr><td colspan="4" class="et-sub">ריק כרגע</td></tr>`;
    return `
      <div class="explainer-section">
        <div class="explainer-h2">${name} (${rows.length})</div>
        <div class="explainer-table-wrap">
          <table class="explainer-table">
            <thead><tr><th>טיקר</th><th>איתות ראשון</th><th>ימים ברשימה</th><th>${statusHead}</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');
}

/* ─── Tab switching ───────────────────────────────────────────────────────── */

/**
 * Switch between the signals view, current-watchlist view, and explainer view.
 * @param {'signals'|'watchlist'|'explainer'} name
 */
function switchTab(name) {
  const tabs  = ['signals', 'watchlist', 'explainer'];
  for (const t of tabs) {
    const btn  = $(`#tab-${t}`);
    const view = $(`#view-${t}`);
    const active = t === name;
    btn.classList.toggle('header-tab--active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
    view.hidden = !active;
  }
}

/* ─── Boot ────────────────────────────────────────────────────────────────── */

async function boot() {
  // Wire filter controls
  ['#search', '#f-region', '#f-signal', '#f-stage2', '#f-grad'].forEach((sel) =>
    $(sel).addEventListener('input', renderTable)
  );

  // Enter in the search box = cross-day ticker lookup, not a day filter.
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      openTickerHistory($('#search').value);
    }
  });
  $('#btn-ticker-history').addEventListener('click', () => openTickerHistory($('#search').value));

  // Near-tier watchlist toggle
  $('#f-near').addEventListener('change', () => {
    showNear = $('#f-near').checked;
    renderTable();
  });

  // Near-tier toggle button — load/collapse, kept in sync with the checkbox
  $('#btn-show-more').addEventListener('click', () => {
    showNear = !showNear;
    $('#f-near').checked = showNear;
    renderTable();
  });

  // Fragility chart — expand to a larger modal view
  $('#btn-expand-fragility').addEventListener('click', openFragilityModal);
  $('#btn-close-chart-modal').addEventListener('click', closeFragilityModal);
  $('#chart-modal-overlay').addEventListener('click', closeFragilityModal);

  // TradingView snapshots — click the thumbnail to view it at full size
  document.querySelectorAll('.img-zoom-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const img = btn.querySelector('img');
      if (img) openImgLightbox(img);
    });
  });
  $('#btn-close-img-lightbox').addEventListener('click', closeImgLightbox);
  $('#img-lightbox-overlay').addEventListener('click', closeImgLightbox);

  // Tab navigation: signals ↔ watchlist ↔ explainer
  $('#tab-signals').addEventListener('click', () => switchTab('signals'));
  $('#tab-watchlist').addEventListener('click', () => switchTab('watchlist'));
  $('#tab-explainer').addEventListener('click', () => switchTab('explainer'));

  // Calendar popover — open/close
  $('#btn-date-picker').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCalPopover();
  });

  // Month navigation
  $('#cal-prev-month').addEventListener('click', () => {
    calViewMonth--;
    if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
    renderCalendar();
  });

  $('#cal-next-month').addEventListener('click', () => {
    calViewMonth++;
    if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
    renderCalendar();
  });

  // Prev/next day arrows
  $('#btn-prev-day').addEventListener('click', () => stepDay(-1));
  $('#btn-next-day').addEventListener('click', () => stepDay(1));

  // Close popover on outside click
  document.addEventListener('click', (e) => {
    const popover = $('#cal-popover');
    const group   = $('.date-picker-group');
    if (!popover.hidden && !group.contains(e.target)) {
      closeCalPopover();
    }
  });

  // Close popover on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const popover = $('#cal-popover');
      if (!popover.hidden) {
        closeCalPopover();
        $('#btn-date-picker').focus();
      }
    }
  });

  showState('טוען נתוני היסטוריה…');

  try {
    const resp = await fetch('/api/summary');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    summaryDays = await resp.json();
  } catch (err) {
    showState(`שגיאה בטעינת סיכום: ${err.message}`);
    return;
  }

  if (!summaryDays.length) {
    showState('אין נתונים זמינים');
    return;
  }

  buildSummaryIndex();

  // Initialize calendar view month to the latest data day
  const latestDate = summaryDays[0].scan_date;
  const parts = latestDate.split('-');
  calViewYear  = parseInt(parts[0], 10);
  calViewMonth = parseInt(parts[1], 10) - 1;

  // Select most recent day (index 0 = newest first per API contract)
  await selectDay(latestDate);

  // Fragility series is global (not per-day) — load once, after the main view.
  loadFragility();

  // Current TradingView watchlist — global (not per-day) — load once too.
  loadWatchlist();

  // Ticker autocomplete over the whole scanned universe — also global.
  loadTickerIndex();
}

boot();
