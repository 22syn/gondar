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
  ['wr14',      'W%R',       'col-mono'],
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
/** @type {Chart|null} Williams %R weekly chart, and its expanded-modal twin. */
let wrChart = null;
let wrChartModal = null;
/** @type {Chart|null} Breadth chart (S5FI vs universe), and its expanded twin. */
let mcChart = null;
let mcChartModal = null;
/** Last-loaded market_context rows, kept so the modal can re-render the same data. */
let marketContextRows = [];
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


/* ─── Dialog focus management ─────────────────────────────────────────────── */

/**
 * Elements that can hold focus inside a dialog. Deliberately excludes
 * `[tabindex="-1"]` — those are programmatic focus targets, not tab stops.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Visible focusables inside `root`, in DOM order. */
function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
    (el) => !el.hidden && el.offsetParent !== null
  );
}

/**
 * Make a dialog behave like one: move focus inside it and keep Tab within it.
 *
 * Both dialogs already declared `aria-modal="true"`, which tells assistive tech
 * the rest of the page is inert — but focus stayed on the trigger behind them
 * and Tab walked straight out into the page underneath. The claim and the
 * behaviour disagreed. `cal-popover` already did this correctly; this brings the
 * other two in line.
 *
 * Pass the element focus should return to on close (normally the trigger).
 */
function captureDialogFocus(dialog, returnTo) {
  dialog._returnFocusTo = returnTo instanceof HTMLElement ? returnTo : null;
  (focusablesIn(dialog)[0] ?? dialog).focus();

  dialog._trapHandler = (e) => {
    if (e.key !== 'Tab') return;
    const items = focusablesIn(dialog);
    if (items.length === 0) { e.preventDefault(); dialog.focus(); return; }
    const first = items[0];
    const last  = items[items.length - 1];
    // Wrap at both ends, and pull focus back in if it escaped some other way.
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  };
  document.addEventListener('keydown', dialog._trapHandler, true);
}

/** Undo captureDialogFocus and hand focus back to whatever opened the dialog. */
function releaseDialogFocus(dialog) {
  if (dialog._trapHandler) {
    document.removeEventListener('keydown', dialog._trapHandler, true);
    dialog._trapHandler = null;
  }
  const back = dialog._returnFocusTo;
  dialog._returnFocusTo = null;
  // isConnected: the table re-renders, so a row that opened the panel may be
  // gone by the time it closes. Focusing a detached node silently drops focus
  // to <body>, which strands a keyboard user at the top of the document.
  if (back && back.isConnected) back.focus();
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
  captureDialogFocus(modal, $('#btn-expand-fragility'));
}

function closeFragilityModal() {
  const modal = $('#chart-modal');
  $('#chart-modal').hidden = true;
  $('#chart-modal-overlay').hidden = true;
  document.body.style.overflow = '';
  // Both panels render into #chart-modal-canvas, so whichever one is open must
  // be destroyed here — leaving an instance attached leaks it and makes the
  // next open render on top of a live chart.
  if (fragChartModal) { fragChartModal.destroy(); fragChartModal = null; }
  if (wrChartModal) { wrChartModal.destroy(); wrChartModal = null; }
  if (mcChartModal) { mcChartModal.destroy(); mcChartModal = null; }
  if (modal._escHandler) { document.removeEventListener('keydown', modal._escHandler); modal._escHandler = null; }
  releaseDialogFocus(modal);
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

/**
 * RS at or above this keeps a near-tier row in the default view.
 *
 * The near tiers are collapsed because they are noisy — median 35 rows/day
 * against the 14 that show. But collapsing them by tier alone buried the best
 * name on the board: on 2026-08-14 CRDO sat at RS 97, second of 46, and went
 * on to +37% — while CLBT at RS 20 was displayed, because it happened to fire
 * a real tier. RS is the one ranking measured to carry information here (the
 * 2026-08-03 study; scoreRow does not), so it is what earns a row its place.
 *
 * 90 measured over the 55 scan days in D1: median +4 rows/day, worst day +13,
 * against a default view of 14. 85 would add 6/day, 95 only 2 and nothing at
 * all on 10 of 55 days.
 */
const NEAR_ALWAYS_SHOW_RS = 90;

/** A near-tier row strong enough to show without expanding the collapse. */
function isHighRsNearRow(r) {
  return isNearRow(r) && r.rs != null && r.rs >= NEAR_ALWAYS_SHOW_RS;
}

/** Count of rows hidden ONLY by the near-tier default filter (set by visibleRows). */
let hiddenNearCount = 0;
/** Count of near-tier rows currently visible (set by visibleRows) — drives the collapse label. */
let shownNearCount = 0;
/**
 * Index in the array visibleRows() returns where the promoted-near block
 * starts, or -1 when there is nothing to divide (no real rows shown, no
 * promoted near rows shown, or the user asked for near rows explicitly via
 * the signal dropdown / search — in every one of those cases the list is
 * already one kind and a divider would separate nothing).
 */
let nearDividerIndex = -1;

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

    // Near-tier filter: hide near-* rows unless showNear is on, the user
    // explicitly selected a near signal from the dropdown, they searched for a
    // ticker, or the row's RS clears NEAR_ALWAYS_SHOW_RS. Counted after the
    // other filters so the "show more" button reports how many rows it reveals.
    //
    // `|| !!q` — a ticker search must never come back empty because the name
    // happens to be a near row. Searching CRDO on 2026-08-14 returned a blank
    // table and a generic "load 1 more" button, even though the row was right
    // there, RS 97, #2 of 46 by the dashboard's own default sort. jumpToDay
    // already forces showNear for exactly this reason ("it would otherwise
    // land on an empty table"); typing in the search box deserves the same.
    const nearExplicit = sig.startsWith('near') || !!q;
    if (!showNear && !nearExplicit && isNearRow(r) && !isHighRsNearRow(r)) {
      hiddenNearCount++;
      return false;
    }
    return true;
  });

  shownNearCount = filtered.filter(isNearRow).length;

  // Real signals stay their own block above promoted near rows, each block
  // sorted independently by the chosen column. Rationale (Kobi, 2026-08-18):
  // a near-miss outranking a real signal by raw RS — TEAM at RS 99 above
  // CRDO's real signal at 98 — read as clutter, not confidence. This keeps
  // RS (or whatever column is sorted) meaningful WITHIN each group instead of
  // letting a promoted row's RS put it ahead of every real signal on the
  // board. Trade-off, stated once rather than re-discovered: clicking a
  // column header re-sorts inside each block, not across the whole table —
  // a promoted near row can never climb above a real one, by design.
  const real = filtered.filter((r) => !isNearRow(r)).sort(compareRows);
  const near = filtered.filter((r) => isNearRow(r)).sort(compareRows);
  nearDividerIndex = (real.length > 0 && near.length > 0) ? real.length : -1;
  return [...real, ...near];
}

/** The sort comparator visibleRows() applies within each block. */
function compareRows(a, b) {
  let x = a[sortKey], y = b[sortKey];
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  if (typeof x === 'string') x = x.toLowerCase();
  if (typeof y === 'string') y = y.toLowerCase();
  return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
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
        case 'wr14': {
          // Williams %R(14), daily. Sorts numerically via data-v; nulls last.
          if (r.wr14 == null) return `<td class="${cls}" data-v="-999">—</td>`;
          const cl = r.wr14 <= -80 ? 'num-down' : r.wr14 >= -20 ? 'num-up' : '';
          return `<td class="${cls}" data-v="${r.wr14}"><span class="${cl}">${r.wr14.toFixed(0)}</span></td>`;
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
    const row = `<tr data-i="${i}" data-conf="${conf}" data-grad="${grad}" tabindex="0" role="row">${tds}</tr>`;
    return i === nearDividerIndex ? nearDividerRowHTML() + row : row;
  }).join('');

  /* attach row click handlers — skip the divider, it carries no data-i */
  tbody.querySelectorAll('tr').forEach((tr) => {
    if (tr.dataset.i === undefined) return;
    const idx = parseInt(tr.dataset.i, 10);
    tr.addEventListener('click', () => openDeepDive(vr[idx], tr));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDeepDive(vr[idx], tr); });
  });

  /* — mobile card list — */
  const cardList = $('#card-list');
  cardList.innerHTML = vr.map((r, i) => {
    const divider = i === nearDividerIndex ? nearDividerCardHTML() : '';
    const conf  = (r.signal_count > 1) || false;
    const grad  = !!r.graduated_from;
    const sc    = r.score ?? null;
    const scBg  = scoreBg(sc);
    const scClr = scoreColor(sc);
    const delta = scoreDeltaHTML(r.score_delta);
    const card = `
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
    return divider + card;
  }).join('');

  cardList.querySelectorAll('.signal-card').forEach((card) => {
    const idx = parseInt(card.dataset.i, 10);
    card.addEventListener('click', () => openDeepDive(vr[idx], card));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDeepDive(vr[idx], card); });
  });
}

/**
 * Divider between the real-signal block and the promoted near rows below it
 * (RS >= NEAR_ALWAYS_SHOW_RS). Non-interactive and excluded from both click
 * wiring loops on purpose — it carries no data-i, and the desktop wiring
 * skips any <tr> without one.
 */
function nearDividerRowHTML() {
  return `<tr class="near-divider-row" aria-hidden="true">`
    + `<td colspan="${COLS.length}" class="near-divider-cell">`
    + `${iconHTML('visibility')}ניירות near (RS ≥ ${NEAR_ALWAYS_SHOW_RS}) — לא סיגנל מלא`
    + `</td></tr>`;
}

function nearDividerCardHTML() {
  return `<div class="near-divider-card" aria-hidden="true">`
    + `${iconHTML('visibility')}ניירות near (RS ≥ ${NEAR_ALWAYS_SHOW_RS}) — לא סיגנל מלא`
    + `</div>`;
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
 * @param {HTMLElement|null} [opener] - element focus returns to on close;
 *   defaults to whatever had focus. Ignored on a re-open, so a row → history
 *   hop still returns to the row.
 */
function openPanel(html, wide = false, opener = null) {
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

  // The panel declares aria-modal="true", so the page behind it must actually
  // be inert: lock body scroll and keep focus inside. Re-opening in place
  // (row → history) keeps the ORIGINAL opener, so closing the history view
  // still hands focus back to the row that started the journey.
  document.body.style.overflow = 'hidden';
  captureDialogFocus(panel, panel._returnFocusTo ?? opener ?? document.activeElement);
}

function openDeepDive(r, opener = null) {
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
    </a>`, false, opener);

  const histBtn = $('#deepdive').querySelector('.dd-history-btn');
  if (histBtn) histBtn.addEventListener('click', () => openTickerHistory(histBtn.dataset.ticker));
}

function closeDeepDive() {
  const panel   = $('#deepdive');
  const overlay = $('#deepdive-overlay');
  panel.hidden   = true;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  if (panel._escHandler) {
    document.removeEventListener('keydown', panel._escHandler);
    panel._escHandler = null;
  }
  releaseDialogFocus(panel);
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
    <tr class="th-row" data-pick="${esc(r.scan_date)}" tabindex="0"
        title="הצג כמה עשתה מאז ההופעה הזאת">
      <td class="th-date">
        <span>${esc(r.scan_date)}</span>
        <button type="button" class="th-jump" data-date="${esc(r.scan_date)}"
                aria-label="קפוץ ליום ${esc(r.scan_date)}"
                title="קפוץ ליום הזה">${iconHTML('open_in_new')}</button>
      </td>
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

    <div class="dd-sub" style="margin-top:14px">כל ההופעות (${h.total}) — לחיצה מציגה כמה עשתה מאז, ${iconHTML('open_in_new')} קופץ לאותו יום</div>
    <div class="th-since" id="th-since" hidden></div>
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
 * "What has it done since the signal I picked."
 *
 * Pure so it can be tested without a DOM: returns a state plus the numbers,
 * and the renderer decides how to phrase it. Both prices come from the same
 * StockData.lastPrice pipeline (lean_signals.price for the appearance,
 * rs_daily.price for today), so they share one raw scale per ticker — agorot
 * for .TA — and dividing them is safe. Never mix in a differently-scaled quote.
 *
 * @param {{scan_date: string, price: ?number}} pick - the chosen appearance
 * @param {?number} latestPrice
 * @param {?string} latestDate
 */
function buildSinceSignal(pick, latestPrice, latestDate) {
  if (!pick || pick.price == null) return { state: 'no-then' };
  // rs_daily.price only started filling 2026-08-17; before that there is
  // genuinely no "today" to compare against, and saying so beats a 0%.
  if (latestPrice == null || !latestDate) return { state: 'no-now', then: pick.price };
  if (!(pick.price > 0)) return { state: 'no-then' };
  return {
    state: 'ok',
    then: pick.price,
    now: latestPrice,
    pct: (latestPrice / pick.price - 1) * 100,
    days: daysBetween(pick.scan_date, latestDate),
    from: pick.scan_date,
    to: latestDate,
  };
}

/** Render the comparison into #th-since. */
function renderSinceSignal(pick, latestPrice, latestDate) {
  const el = $('#th-since');
  if (!el) return;
  const r = buildSinceSignal(pick, latestPrice, latestDate);

  if (r.state === 'no-then') {
    el.className = 'th-since is-empty';
    el.innerHTML = `${iconHTML('help')}אין מחיר שמור להופעה הזאת`;
  } else if (r.state === 'no-now') {
    el.className = 'th-since is-empty';
    el.innerHTML = `${iconHTML('help')}אין מחיר עדכני למנייה הזאת — `
      + `מחיר יומי נשמר רק מ-17.08.2026 ואילך`;
  } else {
    const cls = r.pct >= 0 ? 'up' : 'down';
    el.className = `th-since is-${cls}`;
    el.innerHTML = `
      <div class="th-since-head">${iconHTML('straighten')}מאז ההופעה ב-${esc(r.from)}</div>
      <div class="th-since-grid">
        <div><span class="th-since-k">מחיר אז</span><span class="th-since-v">${fmtPrice(r.then)}</span></div>
        <div><span class="th-since-k">מחיר ב-${esc(r.to)}</span><span class="th-since-v">${fmtPrice(r.now)}</span></div>
        <div><span class="th-since-k">שינוי</span><span class="th-since-v th-since-pct">${fmtPct(r.pct)}</span></div>
        <div><span class="th-since-k">ימים</span><span class="th-since-v">${r.days ?? '—'}</span></div>
      </div>`;
  }
  el.hidden = false;
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
  // [data-date] now matches only the peak cards and the explicit jump buttons —
  // NOT the rows. Jumping navigates the whole dashboard away from this panel,
  // which is the disruptive action; the row is reserved for the cheap one.
  panel.querySelectorAll('[data-date]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      jumpToDay(el.dataset.date, h.ticker);
    })
  );
  panel.querySelectorAll('.th-sugg-btn').forEach((el) =>
    el.addEventListener('click', () => openTickerHistory(el.dataset.ticker))
  );
  // Row click shows the comparison in place. The previous shape — row jumps,
  // small button compares — put the primary action in an 8th column of a table
  // inside a 460px panel with overflow-x:auto, i.e. behind a horizontal
  // scrollbar, so every click landed on the row and navigated away instead.
  const byDate = new Map((h.appearances || []).map((r) => [r.scan_date, r]));
  const pick = (el) => {
    panel.querySelectorAll('.th-row').forEach((r) => r.classList.remove('is-picked'));
    el.classList.add('is-picked');
    renderSinceSignal(byDate.get(el.dataset.pick), h.latest_price, h.latest_price_date);
  };
  panel.querySelectorAll('.th-row').forEach((el) => {
    el.addEventListener('click', () => pick(el));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(el); }
    });
  });
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
  $('#btn-expand-wr').addEventListener('click', openWrModal);
  $('#btn-expand-mc').addEventListener('click', openMcModal);
  $('#btn-close-chart-modal').addEventListener('click', closeFragilityModal);
  $('#chart-modal-overlay').addEventListener('click', closeFragilityModal);

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
  loadMarketContext();

  // Current TradingView watchlist — global (not per-day) — load once too.
  loadWatchlist();

  // Ticker autocomplete over the whole scanned universe — also global.
  loadTickerIndex();
}

boot();


/* ─── Market Context + computed Williams %R ───────────────────────────────── */

/**
 * The six gauges, and which end of their own distribution counts as a warning.
 * MUST stay in sync with GAUGES in dashboard/src/marketContext.ts, which is what
 * actually computes warn_count — this copy only decides how a tile is drawn.
 */
const MC_GAUGES = [
  { key: 'spx_dist_sma150', label: 'SPX מעל SMA150', unit: '%', digits: 1 },
  { key: 'rsp_slope21', label: 'RSP מגמת 21י', unit: '%', digits: 1 },
  { key: 'vix', label: 'VIX', unit: '', digits: 2 },
  { key: 'xlp_spx_slope21', label: 'XLP/SPX 21י', unit: '%', digits: 2 },
  { key: 'xly_xlp_slope21', label: 'XLY/XLP 21י', unit: '%', digits: 2 },
  { key: 's5fi', label: 'S5FI רוחב', unit: '%', digits: 1 },
];

/** Percentile at or beyond which a gauge is drawn as warning. Mirrors WARN_PCT. */
const MC_WARN_PCT = 90;

function mcTile({ label, value, unit, digits, pct, warn, extra }) {
  const el = document.createElement('div');
  el.className = 'mc-tile' + (warn ? ' is-warn' : '') + (value == null ? ' is-empty' : '');
  el.setAttribute('role', 'listitem');

  const l = document.createElement('p');
  l.className = 'mc-tile-label';
  l.textContent = label;

  const v = document.createElement('p');
  v.className = 'mc-tile-value';
  v.textContent = value == null ? '—' : `${value.toFixed(digits)}${unit}`;

  el.append(l, v);

  const foot = pct == null ? extra : `אחוזון ${Math.round(pct)}${extra ? ` · ${extra}` : ''}`;
  if (foot) {
    const p = document.createElement('p');
    p.className = 'mc-tile-pct';
    p.textContent = foot;
    el.append(p);
  }
  return el;
}

/**
 * Load market_context and render the two panels. Silent on failure and hidden
 * on an empty series — the table does not exist until the first ingest, and a
 * missing panel is better than an empty frame full of dashes.
 */
async function loadMarketContext() {
  let rows = [];
  try {
    const resp = await fetch('/api/market-context');
    if (resp.ok) rows = await resp.json();
  } catch { /* keep panels hidden */ }
  if (!Array.isArray(rows) || rows.length === 0) return;
  marketContextRows = rows;

  const latest = rows[rows.length - 1];
  const grid = $('#mc-grid');
  grid.textContent = '';
  for (const g of MC_GAUGES) {
    const pct = latest.pct ? latest.pct[g.key] : null;
    const warnHigh = ['spx_dist_sma150', 'xlp_spx_slope21', 's5fi'].includes(g.key);
    const warn = pct != null && (warnHigh ? pct >= MC_WARN_PCT : pct <= 100 - MC_WARN_PCT);
    grid.append(mcTile({
      label: g.label,
      value: latest[g.key],
      unit: g.unit,
      digits: g.digits,
      pct,
      warn,
      extra: g.key === 's5fi' && latest.s5fi_n != null ? `n=${latest.s5fi_n}` : '',
    }));
  }

  const wc = $('#mc-warncount');
  if (latest.warn_count == null) {
    // Percentiles need history before they mean anything; say so rather than
    // printing "0 warnings" and implying an all-clear we have not measured.
    wc.textContent = 'אחוזונים בהרצה — צריך 60 ימי מסחר';
    wc.className = 'mc-warncount';
  } else {
    wc.textContent = `${latest.warn_count}/6 באזור אזהרה`;
    wc.className = 'mc-warncount' + (latest.warn_count >= 3 ? ' is-hot' : '');
  }
  wc.hidden = false;

  // Universe breadth + the spread — reported BESIDE the six, not inside them.
  // warn_count says "N/6"; 250 backfilled rows carry that definition.
  const spreadWrap = $('#mc-spread');
  if (latest.universe_breadth == null) {
    spreadWrap.hidden = true;
  } else {
    spreadWrap.textContent = '';
    const ubPct = latest.pct ? latest.pct.universe_breadth : null;
    spreadWrap.append(mcTile({
      label: 'רוחב היוניברס',
      value: latest.universe_breadth,
      unit: '%',
      digits: 1,
      pct: ubPct,
      // Elevated breadth preceded one of the three real corrections tested
      // (2026-08-24 backtest, 2.7x its own base rate); low breadth is not warned.
      warn: ubPct != null && ubPct >= MC_WARN_PCT,
      extra: latest.universe_breadth_n != null ? `n=${latest.universe_breadth_n}` : '',
    }));
    const sp = latest.breadth_spread;
    const spPct = latest.pct ? latest.pct.breadth_spread : null;
    spreadWrap.append(mcTile({
      label: 'הפער: S5FI פחות היוניברס',
      value: sp,
      unit: 'pp',
      digits: 1,
      pct: spPct,
      // A large POSITIVE gap = the S&P is fine while the radar's own names are
      // not. That is the reading neither number gives alone.
      warn: spPct != null && spPct >= MC_WARN_PCT,
      extra: sp == null ? '' : sp > 0 ? 'היוניברס מפגר' : 'היוניברס מוביל',
    }));
    spreadWrap.hidden = false;
  }

  const note = $('#mc-note');
  note.textContent = `עודכן ${latest.scan_date} · ${rows.length} ימי מסחר בסדרה`;
  note.hidden = false;
  $('#market-context-wrap').hidden = false;

  // Chart.js sizes a canvas from its container at construction time, so this
  // has to run AFTER the panel is visible — building it while an ancestor is
  // still `hidden` yields a 0x0 canvas and a chart that reports 250 points and
  // draws nothing. That is the failure a logic-only check calls a pass.
  if (rows.some((r) => r.breadth_spread != null)) {
    $('#mc-chart-wrap').hidden = false;
    $('#btn-expand-mc').hidden = false;
    renderMcChart(rows, 'mc-chart');
  }

  // Williams %R panel — the four current readings plus the weekly series.
  const wrGrid = $('#wr-grid');
  wrGrid.textContent = '';
  for (const [key, label] of [
    ['spy_wr_1w', 'SPY שבועי'],
    ['spy_wr_1d', 'SPY יומי'],
    ['qqq_wr_1w', 'QQQ שבועי'],
    ['qqq_wr_1d', 'QQQ יומי'],
  ]) {
    const v = latest[key];
    wrGrid.append(mcTile({
      label,
      value: v,
      unit: '',
      digits: 1,
      pct: null,
      warn: v != null && v <= -80,
      extra: v == null ? '' : v <= -80 ? 'פאניקה' : v >= -20 ? 'overbought' : '',
    }));
  }
  if (rows.some((r) => r.spy_wr_1w != null || r.qqq_wr_1w != null)) {
    $('#wr-wrap').hidden = false;
    renderWrChart(rows, 'wr-chart');
  }
}

/** Weekly Williams %R for SPY and QQQ, with the -20 / -80 reference bands. */
function renderWrChart(rows, canvasId) {
  const isModal = canvasId === 'chart-modal-canvas';
  if (isModal) {
    if (wrChartModal) { wrChartModal.destroy(); wrChartModal = null; }
  } else if (wrChart) {
    wrChart.destroy(); wrChart = null;
  }
  const ctx = document.getElementById(canvasId);
  if (!ctx || typeof Chart === 'undefined') return;

  const line = (label, key, color) => ({
    label,
    data: rows.map((r) => r[key] ?? null),
    borderColor: color,
    backgroundColor: 'transparent',
    borderWidth: 1.6,
    pointRadius: 0,
    spanGaps: true,
    tension: 0.2,
  });
  // U+200E LEFT-TO-RIGHT MARK. Canvas text inherits the page's RTL context, so
  // without it a tick reads "20-" with the sign on the wrong side of the number.
  const ltr = (n) => `\u200E${n}`;
  const band = (label, level, color) => ({
    label,
    data: rows.map(() => level),
    borderColor: color,
    borderDash: [4, 4],
    borderWidth: 1,
    pointRadius: 0,
    fill: false,
  });

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map((r) => r.scan_date.slice(5)),
      datasets: [
        line('SPY 1W', 'spy_wr_1w', '#5aa0ff'),
        line('QQQ 1W', 'qqq_wr_1w', '#b07cff'),
        band(`overbought ${ltr('-20')}`, -20, 'rgba(255,107,53,0.5)'),
        band(`${ltr('-80')} פאניקה`, -80, 'rgba(80,200,140,0.5)'),
      ],
    },
    options: {
      // Matches dist-chart and fragility-chart, which have always set this —
      // and not for taste. Chart.js animates from the scale's base via
      // requestAnimationFrame; when those frames do not fire, every point stays
      // parked at the base and the canvas paints NOTHING, while the chart still
      // reports its full dataset and a healthy scale. Reproduced 2026-08-24 at
      // 460px on both this chart and the Williams one: 0% of the canvas
      // painted, all 250 points at y=174, unchanged after 3s and an explicit
      // update(). Rebuilding the identical chart with animation off painted
      // 16.88% immediately. A reference line has no reason to animate, and this
      // makes it either drawn or not — never blank.
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { min: -100, max: 0, ticks: { font: { size: 10 }, callback: (v) => ltr(v) } },
        x: { ticks: { font: { size: 10 }, maxTicksLimit: 12 } },
      },
      plugins: {
        legend: { labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${ltr(c.parsed.y?.toFixed(1) ?? '—')}` } },
      },
    },
  });
  if (isModal) wrChartModal = chart; else wrChart = chart;
}

/**
 * Expanded view of the Williams %R chart. Mirrors openFragilityModal exactly —
 * same dialog, same overlay, same body-scroll lock, same Escape handler. The
 * first version showed the dialog without the overlay, which left the backdrop
 * un-dimmed, click-outside dead and Escape inert.
 */
function openWrModal() {
  if (marketContextRows.length === 0) return;
  $('#chart-modal-title').innerHTML = document.querySelector('#wr-wrap .chart-title').innerHTML;
  $('#chart-modal').hidden = false;
  $('#chart-modal-overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  renderWrChart(marketContextRows, 'chart-modal-canvas');

  const modal = $('#chart-modal');
  modal._escHandler = (e) => { if (e.key === 'Escape') closeFragilityModal(); };
  document.addEventListener('keydown', modal._escHandler);
  captureDialogFocus(modal, $('#btn-expand-wr'));
}



/**
 * The two breadth series with the gap between them shaded.
 *
 * Drawing the pair beats plotting `breadth_spread` on its own: the subtraction
 * tells you the size of the gap, the two lines tell you which side is moving.
 * On 2026-07-28 — the widest day in the backfilled series — S5FI sat at 71.4%
 * while the radar's own universe was at 46.3%, and the shape of that says
 * "the index broadened away from my names", which a single line does not.
 *
 * Chart.js fills BETWEEN datasets via `fill: { target: <index> }`; the fill
 * belongs to the universe series so its colour reads as "the universe is
 * below". Both series are percentages on one axis, so no second scale.
 */
function renderMcChart(rows, canvasId) {
  const isModal = canvasId === 'chart-modal-canvas';
  if (isModal) {
    if (mcChartModal) { mcChartModal.destroy(); mcChartModal = null; }
  } else if (mcChart) {
    mcChart.destroy(); mcChart = null;
  }
  const ctx = document.getElementById(canvasId);
  if (!ctx || typeof Chart === 'undefined') return;

  // U+200E again: canvas text inherits the page's RTL context, so a negative
  // tick renders as "20-" without it.
  const ltr = (n) => `\u200E${n}`;
  const spreadAt = (i) => rows[i]?.breadth_spread;

  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: rows.map((r) => r.scan_date.slice(5)),
      datasets: [
        {
          label: 'S5FI (S&P 500)',
          data: rows.map((r) => r.s5fi ?? null),
          borderColor: '#5aa0ff',
          backgroundColor: 'transparent',
          borderWidth: 1.6, pointRadius: 0, spanGaps: true, tension: 0.2,
        },
        {
          label: 'רוחב היוניברס',
          data: rows.map((r) => r.universe_breadth ?? null),
          borderColor: '#ff9f45',
          // Fills the band back to dataset 0 — that band IS the spread.
          backgroundColor: 'rgba(255, 159, 69, 0.16)',
          fill: { target: 0 },
          borderWidth: 1.6, pointRadius: 0, spanGaps: true, tension: 0.2,
        },
      ],
    },
    options: {
      // Matches dist-chart and fragility-chart, which have always set this —
      // and not for taste. Chart.js animates from the scale's base via
      // requestAnimationFrame; when those frames do not fire, every point stays
      // parked at the base and the canvas paints NOTHING, while the chart still
      // reports its full dataset and a healthy scale. Reproduced 2026-08-24 at
      // 460px on both this chart and the Williams one: 0% of the canvas
      // painted, all 250 points at y=174, unchanged after 3s and an explicit
      // update(). Rebuilding the identical chart with animation off painted
      // 16.88% immediately. A reference line has no reason to animate, and this
      // makes it either drawn or not — never blank.
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { min: 0, max: 100, ticks: { font: { size: 10 }, callback: (v) => ltr(v + '%') } },
        x: { ticks: { font: { size: 10 }, maxTicksLimit: 12 } },
      },
      plugins: {
        legend: { labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${ltr((c.parsed.y ?? 0).toFixed(1) + '%')}`,
            // The gap is the reason this chart exists — state it outright
            // rather than making the reader subtract two tooltip lines.
            afterBody: (items) => {
              const sp = spreadAt(items[0]?.dataIndex);
              if (sp == null) return '';
              return `פער: ${ltr((sp > 0 ? '+' : '') + sp.toFixed(1) + 'pp')} — ${sp > 0 ? 'היוניברס מפגר' : 'היוניברס מוביל'}`;
            },
          },
        },
      },
    },
  });
  if (isModal) mcChartModal = chart; else mcChart = chart;
}

/** Expanded view of the breadth chart. Mirrors openFragilityModal exactly. */
function openMcModal() {
  if (marketContextRows.length === 0) return;
  $('#chart-modal-title').innerHTML = document.querySelector('#market-context-wrap .chart-title').innerHTML;
  $('#chart-modal').hidden = false;
  $('#chart-modal-overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  renderMcChart(marketContextRows, 'chart-modal-canvas');

  const modal = $('#chart-modal');
  modal._escHandler = (e) => { if (e.key === 'Escape') closeFragilityModal(); };
  document.addEventListener('keydown', modal._escHandler);
  captureDialogFocus(modal, $('#btn-expand-mc'));
}
