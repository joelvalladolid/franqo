/* ================================================================
   SMF Paper Trading — Dashboard Application Logic
   ================================================================ */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  strategy: 'V428',
  backtestResults: [],
  signalsData: null,
  portfolioData: null,
  equityChart: null,
  selectedBacktest: null,
};

// Asset display names & colors
const ASSET_META = {
  TQQQ: { name: '3x Nasdaq-100', color: '#6366f1', type: 'bull' },
  ETH:  { name: 'Ethereum',      color: '#06b6d4', type: 'bull' },
  BTC:  { name: 'Bitcoin',       color: '#f59e0b', type: 'bull' },
  SQQQ: { name: '3x Inv Nasdaq', color: '#ef4444', type: 'bear' },
  GLD:  { name: 'Gold ETF',      color: '#fbbf24', type: 'gld'  },
  SHV:  { name: 'T-Bill ETF',    color: '#64748b', type: 'cash' },
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAllData();
});

async function loadAllData() {
  const btn = document.getElementById('btnUpdate');
  if (btn) btn.innerHTML = '<span class="btn-update-icon" style="animation: spin 1s linear infinite;">↻</span> Updating...';
  
  await Promise.all([
    loadBacktestResults(),
    loadSignals(),
    loadPortfolio(),
  ]);
  renderDashboard();
  
  if (btn) btn.innerHTML = '<span class="btn-update-icon">↻</span> Update Today';
}


// ── Data Loading ──────────────────────────────────────────────────────────────
async function loadBacktestResults() {
  try {
    const res = await fetch('data/backtest_results.json?t=' + Date.now());
    if (!res.ok) throw new Error(res.status);
    state.backtestResults = await res.json();
  } catch (e) {
    console.warn('Backtest results not found — run backtest/backtest.py first', e);
    state.backtestResults = generatePlaceholderData();
  }
}

async function loadSignals() {
  try {
    const res = await fetch('data/signals.json?t=' + Date.now());
    if (!res.ok) throw new Error(res.status);
    state.signalsData = await res.json();
  } catch (e) {
    console.warn('Signals not found — run update.py first', e);
    state.signalsData = null;
  }
}

async function loadPortfolio() {
  try {
    const res = await fetch('data/portfolio.json?t=' + Date.now());
    if (!res.ok) throw new Error(res.status);
    state.portfolioData = await res.json();
  } catch (e) {
    console.warn('Portfolio not found — run engine/portfolio.py first', e);
    state.portfolioData = null;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderDashboard() {
  renderLastUpdated();
  renderSignalBanner();
  renderKPIs();
  renderBacktestSelector();
  updateEquityChart();
  renderPositions();
  renderAssetSignals();
  renderHeatmapSelector();
  updateHeatmap();
  renderTradeLog();
}

function renderLastUpdated() {
  const el = document.getElementById('lastUpdated');
  const src = state.signalsData?.generated_at || state.backtestResults?.[0]?.generated_at;
  if (src) {
    const d = new Date(src);
    el.textContent = 'Updated: ' + d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
  }
}

// ── Signal Banner ─────────────────────────────────────────────────────────────
function renderSignalBanner() {
  const sig = state.signalsData?.signals?.[state.strategy];
  if (!sig || sig.error) {
    document.getElementById('signalText').textContent =
      sig?.error || '⚠️ Run update.py to get today\'s signals';
    document.getElementById('signalDate').textContent = 'SIGNALS UNAVAILABLE';
    return;
  }

  const dateEl = document.getElementById('signalDate');
  const textEl = document.getElementById('signalText');
  const allocEl = document.getElementById('signalAllocation');

  dateEl.textContent = `TODAY — ${sig.date || state.signalsData.generated_at?.slice(0,10)}`;
  textEl.textContent = sig.signal_reason || '—';

  // Render allocation pills
  allocEl.innerHTML = '';
  const alloc = sig.allocation || {};
  Object.entries(alloc).forEach(([sym, weight]) => {
    if (weight < 0.001) return;
    const meta = ASSET_META[sym];
    const cls = meta ? `alloc-${meta.type}` : 'alloc-cash';
    const pill = document.createElement('div');
    pill.className = `alloc-pill ${cls}`;
    pill.innerHTML = `<strong>${sym}</strong> ${(weight * 100).toFixed(0)}%`;
    allocEl.appendChild(pill);
  });
}

// ── KPI Cards ─────────────────────────────────────────────────────────────────
function renderKPIs() {
  // Try portfolio NAV first
  const port = state.portfolioData?.portfolios?.[state.strategy];
  if (port) {
    const nav = port.nav || 100000;
    const ret = port.total_return || 0;
    const el = document.getElementById('kpiNavValue');
    el.textContent = '$' + nav.toLocaleString('en-US', { maximumFractionDigits: 0 });
    el.className = `kpi-value ${ret >= 0 ? 'pos' : 'neg'}`;
    document.getElementById('kpiNavSub').textContent =
      (ret >= 0 ? '+' : '') + (ret * 100).toFixed(2) + '% total return';
  }

  // Find the matching full-period backtest
  const bt = getFullPeriodBacktest();
  if (!bt) return;
  const m = bt.metrics;

  setKPI('kpiCagrValue',    fmtPct(m.cagr),         m.cagr >= 0);
  setKPI('kpiSharpeValue',  m.sharpe?.toFixed(3) || '—', m.sharpe >= 1.0);
  setKPI('kpiMaxddValue',   fmtPct(m.max_dd),        false, true);
  setKPI('kpiDailyValue',   fmtPct(m.daily_return),  m.daily_return >= 0);
  setKPI('kpiWinrateValue', fmtPct(m.win_rate),      m.win_rate >= 0.5);
}

function setKPI(id, value, positive, alwaysNeg = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  if (alwaysNeg) el.className = 'kpi-value kpi-neg';
  else el.className = `kpi-value ${positive ? 'pos' : 'neg'}`;
}

function getFullPeriodBacktest() {
  const label = state.strategy === 'V428' ? 'V428 — Full Period' : 'V503 — Full Period';
  return state.backtestResults.find(r => r.label?.startsWith(label));
}

// ── Backtest Selector ─────────────────────────────────────────────────────────
function renderBacktestSelector() {
  const sel = document.getElementById('selectBacktest');
  const heatSel = document.getElementById('selectHeatmap');
  sel.innerHTML = '';
  heatSel.innerHTML = '';

  const filtered = state.backtestResults.filter(r =>
    r.version === state.strategy || state.strategy === 'compare'
  );

  filtered.forEach((r, i) => {
    const opt = new Option(r.label, i);
    sel.appendChild(opt.cloneNode(true));
    heatSel.appendChild(opt.cloneNode(true));
  });

  // Select full period by default
  const fullIdx = filtered.findIndex(r => r.label?.includes('Full Period'));
  if (fullIdx >= 0) {
    sel.selectedIndex = fullIdx;
    heatSel.selectedIndex = fullIdx;
  }
}

function getSelectedBacktest(selectId = 'selectBacktest') {
  const sel = document.getElementById(selectId);
  const idx = parseInt(sel.value);
  const filtered = state.backtestResults.filter(r =>
    r.version === state.strategy || state.strategy === 'compare'
  );
  return filtered[idx] || null;
}

// ── Equity Chart ──────────────────────────────────────────────────────────────
function updateEquityChart() {
  const bt = getSelectedBacktest('selectBacktest');
  if (!bt?.equity_curve) return;

  const ctx = document.getElementById('equityChart').getContext('2d');

  if (state.equityChart) {
    state.equityChart.destroy();
    state.equityChart = null;
  }

  const stratColor = '#6366f1';
  const benchColor = '#ef4444';
  const gridColor = 'rgba(255,255,255,0.05)';

  // Sample every N points for performance
  const sampleRate = bt.equity_curve.length > 1000 ? 5 : 1;
  const sample = (arr) => arr?.filter((_, i) => i % sampleRate === 0 || i === arr.length - 1) ?? [];

  const stratData = sample(bt.equity_curve).map(p => ({ x: p.date, y: p.value }));
  const benchData = sample(bt.benchmark_curve).map(p => ({ x: p.date, y: p.value }));

  const datasets = [
    {
      label: `${bt.version} Strategy`,
      data: stratData,
      borderColor: stratColor,
      backgroundColor: createGradient(ctx, stratColor),
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      fill: true,
    },
  ];

  if (benchData.length > 0) {
    datasets.push({
      label: 'TQQQ Buy & Hold',
      data: benchData,
      borderColor: benchColor,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderDash: [5, 5],
      pointRadius: 0,
      tension: 0.3,
      fill: false,
    });
  }

  // Add portfolio NAV history
  const port = state.portfolioData?.portfolios?.[state.strategy];
  if (port?.history?.length > 1) {
    datasets.push({
      label: 'Paper Portfolio',
      data: port.history.map(h => ({ x: h.date, y: h.nav })),
      borderColor: '#10b981',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.3,
      fill: false,
    });
  }

  state.equityChart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(14,16,24,0.95)',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleColor: '#94a3b8',
          bodyColor: '#e2e8f0',
          padding: 12,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: $${ctx.parsed.y.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'month', tooltipFormat: 'MMM yyyy' },
          grid: { color: gridColor },
          ticks: { color: '#64748b', maxTicksLimit: 12 },
        },
        y: {
          position: 'right',
          grid: { color: gridColor },
          ticks: {
            color: '#64748b',
            callback: (v) => '$' + (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : (v / 1e3).toFixed(0) + 'K'),
          },
        },
      },
    },
  });
}

function createGradient(ctx, color) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 380);
  gradient.addColorStop(0, color + '40');
  gradient.addColorStop(1, color + '00');
  return gradient;
}

// ── Positions ─────────────────────────────────────────────────────────────────
function renderPositions() {
  const el = document.getElementById('positionsTable');
  const port = state.portfolioData?.portfolios?.[state.strategy];

  if (!port) {
    el.innerHTML = '<div class="loading-spinner" style="opacity:0.4">Run update.py to see live positions</div>';
    return;
  }

  document.getElementById('positionsDate').textContent =
    'Updated: ' + (port.last_updated?.slice(0, 10) || '—');

  const alloc = port.current_allocation || { SHV: 1.0 };
  const nav = port.nav || 100000;
  const positions = port.positions || {};

  let html = '<div class="positions-grid">';

  Object.entries(alloc).forEach(([sym, weight]) => {
    if (weight < 0.001) return;
    const meta = ASSET_META[sym] || { name: sym, color: '#64748b' };
    const pos = positions[sym];
    const price = pos?.current_price;
    const value = nav * weight;

    html += `
      <div class="positions-row">
        <div>
          <div class="pos-symbol" style="color:${meta.color}">${sym}</div>
          <div class="pos-name">${meta.name}</div>
        </div>
        <div class="pos-weight">${(weight * 100).toFixed(1)}%</div>
        <div class="pos-price">${price ? '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</div>
        <div class="pos-value" style="color:${meta.color}">$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
      </div>`;
  });

  // Total NAV row
  html += `
    <div class="positions-row" style="background:rgba(99,102,241,0.05);border-top:1px solid rgba(99,102,241,0.2)">
      <div><div class="pos-symbol">TOTAL NAV</div><div class="pos-name">Virtual Portfolio</div></div>
      <div></div>
      <div></div>
      <div class="pos-value" style="color:#6366f1">$${nav.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
    </div>`;

  html += '</div>';
  el.innerHTML = html;
}

// ── Asset Signals ─────────────────────────────────────────────────────────────
function renderAssetSignals() {
  const el = document.getElementById('assetSignalsTable');
  const sig = state.signalsData?.signals?.[state.strategy];

  if (!sig || sig.error) {
    el.innerHTML = '<div class="loading-spinner" style="opacity:0.4">Run update.py to see signals</div>';
    return;
  }

  document.getElementById('signalDataDate').textContent = sig.signal_date || sig.date || '—';

  const details = sig.asset_details || {};
  const ASSETS = ['TQQQ', 'ETH', 'BTC', 'SQQQ', 'GLD'];

  let html = '<div class="signals-grid">';

  ASSETS.forEach(sym => {
    const d = details[sym];
    if (!d) return;
    const meta = ASSET_META[sym] || { color: '#64748b', type: 'neutral' };
    const rsi = d.rsi2;
    const rsiCls = rsi < 10 ? 'rsi-low' : rsi > 80 ? 'rsi-high' : 'rsi-mid';
    const isBull = d.is_bull;
    const price = d.price;
    const mom = d.momentum;

    let inds = '';
    if (d.above_regime) inds += '<span class="indicator ind-bull">SMA200 ✓</span>';
    else                inds += '<span class="indicator ind-bear">SMA200 ✗</span>';
    if (d.above_slow)   inds += '<span class="indicator ind-bull">SMA50 ✓</span>';
    else                inds += '<span class="indicator ind-bear">SMA50 ✗</span>';
    if (rsi < 10)       inds += '<span class="indicator ind-bull">RSI OVERSOLD</span>';
    else if (rsi > 80)  inds += '<span class="indicator ind-bear">RSI OVERBOUGHT</span>';

    const statusCls = sym === 'SQQQ' ? (isBull ? 'status-bear' : 'status-neutral') :
                      isBull ? 'status-bull' : rsi < 10 ? 'status-mr' : 'status-bear';
    const statusTxt = sym === 'SQQQ' ? (isBull ? '🐻 ACTIVE' : '— IDLE') :
                      isBull ? '🟢 BULL' : rsi < 10 ? '🎯 MR' : '🔴 BEAR';

    html += `
      <div class="signal-row">
        <div class="signal-sym" style="color:${meta.color}">${sym}</div>
        <div>
          <div style="font-size:12px;color:#94a3b8;margin-bottom:3px">$${price?.toLocaleString('en-US',{maximumFractionDigits:2}) || '—'} &nbsp;<span style="color:${mom>=0?'#10b981':'#ef4444'}">${mom>=0?'+':''}${((mom||0)*100).toFixed(1)}%</span></div>
          <div class="signal-indicators">${inds}</div>
        </div>
        <div class="signal-rsi ${rsiCls}">RSI(2)<br/>${rsi?.toFixed(1) || '—'}</div>
        <div><span class="signal-status ${statusCls}">${statusTxt}</span></div>
      </div>`;
  });

  html += '</div>';
  el.innerHTML = html;
}

// ── Heatmap ───────────────────────────────────────────────────────────────────
function renderHeatmapSelector() {
  // Same as backtest selector, already done
}

function updateHeatmap() {
  const bt = getSelectedBacktest('selectHeatmap');
  const el = document.getElementById('heatmapContainer');

  if (!bt?.monthly_returns?.length) {
    el.innerHTML = '<div class="loading-spinner" style="opacity:0.4">No data — run backtest first</div>';
    return;
  }

  const monthly = bt.monthly_returns;

  // Group by year
  const byYear = {};
  monthly.forEach(d => {
    if (!byYear[d.year]) byYear[d.year] = {};
    byYear[d.year][d.month] = d.return;
  });

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const years = Object.keys(byYear).sort();

  let html = '<table class="heatmap-table"><thead><tr><th class="heatmap-th">Year</th>';
  months.forEach(m => { html += `<th class="heatmap-th">${m}</th>`; });
  html += '<th class="heatmap-th">Ann.</th></tr></thead><tbody>';

  years.forEach(year => {
    html += `<tr><td class="heatmap-year">${year}</td>`;
    let annProd = 1;
    for (let mo = 1; mo <= 12; mo++) {
      const val = byYear[year][mo];
      if (val === undefined) {
        html += '<td></td>';
        continue;
      }
      annProd *= (1 + val / 100);
      const bg = heatColor(val);
      const textColor = Math.abs(val) > 5 ? '#fff' : '#e2e8f0';
      html += `<td class="heatmap-cell" style="background:${bg};color:${textColor}" title="${val.toFixed(2)}%">${val >= 0 ? '+' : ''}${val.toFixed(1)}%</td>`;
    }
    const ann = ((annProd - 1) * 100).toFixed(1);
    const annBg = heatColor(parseFloat(ann));
    html += `<td class="heatmap-cell" style="background:${annBg};color:#fff;font-weight:700">${parseFloat(ann) >= 0 ? '+' : ''}${ann}%</td>`;
    html += '</tr>';
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

function heatColor(val) {
  // val is in percent
  const maxVal = 25;
  const clamped = Math.max(-maxVal, Math.min(maxVal, val));
  if (clamped >= 0) {
    const t = clamped / maxVal;
    const g = Math.round(100 + t * 85);
    return `rgba(16,${g},129,${0.2 + t * 0.6})`;
  } else {
    const t = Math.abs(clamped) / maxVal;
    const r = Math.round(200 + t * 55);
    return `rgba(${r},68,68,${0.2 + t * 0.6})`;
  }
}

// ── Compare ───────────────────────────────────────────────────────────────────
function renderCompare() {
  const el = document.getElementById('compareSection');
  const inner = document.getElementById('compareTable');
  el.style.display = 'block';

  const v428 = state.backtestResults.find(r => r.label?.includes('V428') && r.label?.includes('Full Period'));
  const v503 = state.backtestResults.find(r => r.label?.includes('V503') && r.label?.includes('Full Period'));

  if (!v428 || !v503) {
    inner.innerHTML = '<div class="loading-spinner" style="opacity:0.4">Run backtest first</div>';
    return;
  }

  const rows = [
    { label: 'Strategy', v428: 'V428 — Trend 1x', v503: 'V503 — Full System 2x', winner: null },
    { label: 'CAGR',         v428: fmtPct(v428.metrics.cagr),         v503: fmtPct(v503.metrics.cagr),         winner: 'v503' },
    { label: 'Daily Return', v428: fmtPct(v428.metrics.daily_return),  v503: fmtPct(v503.metrics.daily_return),  winner: 'v503' },
    { label: 'Sharpe Ratio', v428: v428.metrics.sharpe?.toFixed(3),    v503: v503.metrics.sharpe?.toFixed(3),    winner: 'v503' },
    { label: 'Sortino',      v428: v428.metrics.sortino?.toFixed(3),   v503: v503.metrics.sortino?.toFixed(3),   winner: 'v503' },
    { label: 'Max Drawdown', v428: fmtPct(v428.metrics.max_dd),        v503: fmtPct(v503.metrics.max_dd),        winner: 'v428' },
    { label: 'Win Rate',     v428: fmtPct(v428.metrics.win_rate),      v503: fmtPct(v503.metrics.win_rate),      winner: null },
    { label: 'Final Equity', v428: '$' + Math.round(v428.metrics.final_equity).toLocaleString(), v503: '$' + Math.round(v503.metrics.final_equity).toLocaleString(), winner: 'v503' },
    { label: 'Benchmark CAGR', v428: fmtPct(v428.benchmark?.cagr), v503: fmtPct(v503.benchmark?.cagr), winner: null },
    { label: 'Assets', v428: 'TQQQ + ETH', v503: 'TQQQ + ETH + BTC + SQQQ', winner: null },
    { label: 'Max Leverage', v428: '1x', v503: 'Up to 2x', winner: null },
    { label: 'Bear Market', v428: 'GLD / SHV (cash)', v503: 'SQQQ (profit from drop)', winner: 'v503' },
  ];

  let html = '<div class="compare-grid"><table class="compare-table"><thead><tr><th>Metric</th><th>V428</th><th>V503</th></tr></thead><tbody>';

  rows.forEach(r => {
    const v428cls = r.winner === 'v428' ? 'winner' : '';
    const v503cls = r.winner === 'v503' ? 'winner' : '';
    html += `
      <tr>
        <td class="metric-label">${r.label}</td>
        <td class="metric-value ${v428cls}">${r.v428 || '—'}</td>
        <td class="metric-value ${v503cls}">${r.v503 || '—'}</td>
      </tr>`;
  });

  html += '</tbody></table></div>';
  inner.innerHTML = html;
}

// ── Trade Log ─────────────────────────────────────────────────────────────────
function renderTradeLog() {
  const el = document.getElementById('tradeLog');
  
  // Use portfolio trades first, then backtest trades
  const port = state.portfolioData?.portfolios?.[state.strategy];
  const portTrades = port?.trade_log || [];
  
  const bt = getFullPeriodBacktest();
  const btTrades = bt?.trades || [];

  const allTrades = [...portTrades.map(t => ({ ...t, source: '🟢 Paper' })),
                     ...btTrades.map(t => ({ ...t, source: '📊 Backtest' }))];

  document.getElementById('tradeCount').textContent = allTrades.length + ' trades';

  if (allTrades.length === 0) {
    el.innerHTML = '<div class="loading-spinner" style="opacity:0.4">No trades yet — run update.py</div>';
    return;
  }

  // Show most recent first
  const sorted = [...allTrades].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const show = sorted.slice(0, 100);

  let html = `<table class="trade-table">
    <thead><tr>
      <th>Date</th><th>Source</th><th>Action</th><th>Details</th><th>NAV / Equity</th>
    </tr></thead><tbody>`;

  show.forEach(t => {
    const actionStr = t.action || '';
    const actionCls = actionStr.includes('STOP') ? 'action-stop' :
                      (actionStr.includes('COMPRAR') || actionStr === 'REBALANCE') ? 'action-rebal' : 'action-init';
    const details = t.details || t.signal || t.to || '—';
    const equity = t.nav ?? t.equity;

    html += `
      <tr>
        <td class="trade-date">${t.date || '—'}</td>
        <td class="trade-date">${t.source || '—'}</td>
        <td><span class="trade-action ${actionCls}">${t.action}</span></td>
        <td class="trade-details">${details}</td>
        <td class="trade-equity">${equity ? '$' + Math.round(equity).toLocaleString() : '—'}</td>
      </tr>`;
  });

  html += '</tbody></table>';
  el.innerHTML = html;
}

// ── Strategy Selector ─────────────────────────────────────────────────────────
function selectStrategy(version) {
  state.strategy = version;

  // Update tabs
  document.querySelectorAll('.strat-tab').forEach(t => t.classList.remove('active'));
  const tabId = version === 'compare' ? 'tabCompare' :
                version === 'V503'    ? 'tabV503'    : 'tabV428';
  document.getElementById(tabId)?.classList.add('active');

  // Show/hide sections
  const compareSection = document.getElementById('compareSection');
  const signalBanner = document.getElementById('signalBanner');
  const kpiGrid = document.getElementById('kpiGrid');
  const twoCol = document.querySelector('.two-col');

  if (version === 'compare') {
    compareSection.style.display = 'block';
    if (signalBanner) signalBanner.style.display = 'none';
    if (kpiGrid) kpiGrid.style.display = 'none';
    if (twoCol) twoCol.style.display = 'none';
    
    renderCompare();
    renderBacktestSelector();
    updateEquityChart();
    renderHeatmapSelector();
    updateHeatmap();
    renderTradeLog();
  } else {
    compareSection.style.display = 'none';
    if (signalBanner) signalBanner.style.display = '';
    if (kpiGrid) kpiGrid.style.display = '';
    if (twoCol) twoCol.style.display = '';

    // Re-render everything
    renderSignalBanner();
    renderKPIs();
    renderBacktestSelector();
    updateEquityChart();
    renderPositions();
    renderAssetSignals();
    renderHeatmapSelector();
    updateHeatmap();
    renderTradeLog();
  }
}

// ── Update Button ─────────────────────────────────────────────────────────────
async function refreshDashboard() {
  const btn = document.getElementById('btnUpdate');
  btn.classList.add('loading');
  btn.disabled = true;

  try {
    // Reload data files (requires python to have run first)
    await loadAllData();
    renderDashboard();
    
    // Show a brief "updated" state
    const icon = btn.querySelector('.btn-update-icon');
    icon.textContent = '✓';
    setTimeout(() => { icon.textContent = '↻'; }, 2000);
  } catch (e) {
    console.error('Update failed:', e);
    alert('Update failed. Please run python update.py first, then click Update.');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtPct(val) {
  if (val == null || isNaN(val)) return '—';
  return (val >= 0 ? '+' : '') + (val * 100).toFixed(2) + '%';
}

function generatePlaceholderData() {
  // Fallback placeholder data if backtest hasn't run yet
  const now = new Date();
  const years = 3;
  const days = years * 252;
  const startVal = 100000;
  
  const curves = { V428: [], V503: [], bench: [] };
  let val428 = startVal, val503 = startVal, bench = startVal;
  
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - i));
    const date = d.toISOString().slice(0, 10);
    
    // Simulate approximate returns
    const r428 = (Math.random() - 0.45) * 0.025 + 0.0009;  // ~74% CAGR
    const r503 = (Math.random() - 0.43) * 0.04 + 0.0015;   // ~141% CAGR
    const rb   = (Math.random() - 0.47) * 0.03 + 0.001;
    
    val428 *= (1 + r428); val503 *= (1 + r503); bench *= (1 + rb);
    
    curves.V428.push({ date, value: Math.round(val428 * 100) / 100 });
    curves.V503.push({ date, value: Math.round(val503 * 100) / 100 });
    curves.bench.push({ date, value: Math.round(bench * 100) / 100 });
  }

  // Show warning banner once
  const existingWarn = document.getElementById('placeholderWarning');
  if (!existingWarn) {
    const warn = document.createElement('div');
    warn.id = 'placeholderWarning';
    warn.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
      'background:#92400e', 'color:#fef3c7', 'text-align:center',
      'padding:10px 16px', 'font-size:13px', 'font-weight:600',
      'border-bottom:2px solid #f59e0b',
    ].join(';');
    warn.innerHTML = '⚠️ DATOS SIMULADOS ALEATORIOS — Los números de abajo NO son los backtest reales. ' +
      'Ejecuta <code style="background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px">python backtest/backtest.py</code> ' +
      'para ver resultados reales. ' +
      '<button onclick="document.getElementById(\'placeholderWarning\').remove()" ' +
      'style="margin-left:12px;background:none;border:1px solid #f59e0b;color:#fef3c7;' +
      'border-radius:4px;padding:2px 8px;cursor:pointer;font-size:12px">✕ Cerrar</button>';
    document.body.prepend(warn);
  }

  const makeResult = (v, curve, benchCurve) => ({
    label: `${v} — Full Period (⚠️ PLACEHOLDER — datos aleatorios)`,
    version: v,
    start: curve[0].date,
    end: curve[curve.length - 1].date,
    initial_cash: startVal,
    // NOTE: these metrics are RANDOM — NOT real backtest numbers
    metrics: {
      cagr: null, sharpe: null, max_dd: null,
      daily_return: null, win_rate: null, sortino: null,
      total_return: null, final_equity: null,
    },
    benchmark: { cagr: null, sharpe: null, max_dd: null },
    equity_curve: curve,
    benchmark_curve: benchCurve,
    monthly_returns: [],
    trades: [],
    num_trades: 0,
    generated_at: now.toISOString(),
  });

  return [
    makeResult('V428', curves.V428, curves.bench),
    makeResult('V503', curves.V503, curves.bench),
  ];
}
