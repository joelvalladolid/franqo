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
  renderStrategyExplainer();
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
    renderStrategyExplainer();
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
    renderStrategyExplainer();
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

// ── Strategy Explainer ────────────────────────────────────────────────────────
function renderStrategyExplainer() {
  const el = document.getElementById('explainerContent');
  const title = document.getElementById('explainerTitle');
  if (!el) return;

  if (state.strategy === 'compare') {
    document.getElementById('explainerSection').style.display = 'none';
    return;
  }
  document.getElementById('explainerSection').style.display = '';

  const isV428 = state.strategy === 'V428';
  title.textContent = isV428
    ? '📖 ¿Cómo funciona V428? — Trend-Following 1x'
    : '📖 ¿Cómo funciona V503? — Full System hasta 2x';

  if (isV428) {
    el.innerHTML = renderV428Explainer();
  } else {
    el.innerHTML = renderV503Explainer();
  }
}

function renderV428Explainer() {
  return `
    <div class="explainer-summary">
      <strong>V428</strong> es una estrategia de <strong>Seguimiento de Tendencia</strong> con apalancamiento fijo de 1x.
      Invierte en <strong>TQQQ</strong> (3x Nasdaq) y <strong>ETH</strong> (Ethereum) cuando el mercado está alcista,
      y se refugia en <strong>GLD</strong> (Oro) o <strong>SHV</strong> (Efectivo) cuando no hay tendencia clara.
      <br/><br/>
      🎯 <strong>Resultados del backtest (2020–2026):</strong> CAGR 57.4%, Sharpe 1.066, MaxDD 51.7%, $100K → $1.89M
    </div>

    <h3 style="font-size:15px;font-weight:700;margin-bottom:16px;color:var(--text)">🧒 Reglas del día a día — paso por paso:</h3>

    <div class="explainer-steps">
      <div class="explainer-step">
        <div class="step-number">1</div>
        <div class="step-title">📊 Revisar las medias móviles</div>
        <div class="step-desc">
          Cada día, el algoritmo mira 3 promedios del precio de cada activo:
          <br/>• <em>SMA rápida (15 días)</em> — tendencia reciente
          <br/>• <em>SMA lenta (50 días)</em> — tendencia de mediano plazo
          <br/>• <em>SMA de régimen (200 días)</em> — ¿estamos en mercado alcista o bajista?
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">2</div>
        <div class="step-title">✅ Señal de compra ("BULL")</div>
        <div class="step-desc">
          Un activo tiene señal <em>BULL</em> cuando se cumplen las 3 condiciones:
          <br/>1. El precio está <em>por encima</em> de la SMA de 50 días
          <br/>2. La SMA de 15 días está <em>por encima</em> de la SMA de 50 días
          <br/>3. El precio está <em>por encima</em> de la SMA de 200 días
          <br/><br/>
          Si no se cumplen las 3, la señal es <em>BEAR</em> (bajista).
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">3</div>
        <div class="step-title">💰 ¿Dónde poner el dinero?</div>
        <div class="step-desc">
          El algoritmo sigue este orden de prioridad:
          <br/><br/>
          <strong>Si TQQQ y ETH son BULL:</strong> 55% al de más momentum, 45% al otro
          <br/><strong>Si solo uno es BULL:</strong> 100% en ese activo
          <br/><strong>Si ninguno es BULL pero GLD sí:</strong> 50% GLD + 50% Efectivo
          <br/><strong>Si nada funciona:</strong> Revisar RSI(2) para oportunidad de rebote →
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">4</div>
        <div class="step-title">🎯 Mean Reversion (MR) — Rebote por sobreventa</div>
        <div class="step-desc">
          Cuando ningún activo tiene tendencia, el algoritmo busca rebotes rápidos:
          <br/><br/>
          Si el <em>RSI(2) cae por debajo de 10</em> en TQQQ o ETH, significa que
          el activo cayó mucho en 2 días y podría rebotar.
          <br/>→ Se compra <em>25% en ese activo + 75% Efectivo</em>
          <br/><br/>
          Si ni siquiera hay rebote: <em>100% Efectivo (SHV)</em>.
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">5</div>
        <div class="step-title">🛑 Stop-Loss — Protección contra crashes</div>
        <div class="step-desc">
          Si el portafolio cae más del <em>11%</em> desde su pico más alto:
          <br/>→ Se vende <em>TODO</em> y se pasa a 100% Efectivo (SHV)
          <br/>→ Se espera <em>1 día</em> de cooldown antes de volver a operar
          <br/><br/>
          Después de <em>20 ciclos</em> de stop consecutivos, se reinicia el pico
          para que la estrategia pueda volver a operar normalmente.
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">6</div>
        <div class="step-title">📏 Umbral de rebalanceo (2%)</div>
        <div class="step-desc">
          Para no hacer trades innecesarios cada día, el algoritmo solo ajusta posiciones
          si la diferencia entre los pesos actuales y los deseados es <em>mayor al 2%</em>.
          <br/><br/>
          Esto evita costos de transacción y reduce el ruido.
        </div>
      </div>
    </div>

    <div class="explainer-params">
      <h3>⚙️ Parámetros exactos de V428</h3>
      <table class="params-table">
        <thead><tr><th>Parámetro</th><th>Valor</th><th>¿Qué significa?</th></tr></thead>
        <tbody>
          <tr><td>slow</td><td>50</td><td>Media móvil lenta de 50 días</td></tr>
          <tr><td>fast</td><td>15</td><td>Media móvil rápida de 15 días (para TQQQ, ETH, GLD)</td></tr>
          <tr><td>regime</td><td>200</td><td>Media de régimen (200 días) — define si el mercado es alcista</td></tr>
          <tr><td>stop</td><td>11%</td><td>Se activa el stop-loss si caes más del 11% desde el pico</td></tr>
          <tr><td>max_stop_cycles</td><td>20</td><td>Después de 20 stops seguidos, se reinicia el pico</td></tr>
          <tr><td>mr_oversold</td><td>RSI < 10</td><td>RSI(2) menor a 10 = señal de rebote</td></tr>
          <tr><td>mr_alloc</td><td>25%</td><td>25% en el activo sobrevendido, 75% en efectivo</td></tr>
          <tr><td>mom_lookback</td><td>21 días</td><td>Mide el momentum de los últimos 21 días</td></tr>
          <tr><td>rebal_threshold</td><td>2%</td><td>Solo rebalancea si la diferencia es mayor a 2%</td></tr>
          <tr><td>leverage</td><td>1.0x</td><td>Sin apalancamiento — inversión normal</td></tr>
        </tbody>
      </table>
    </div>

    <div class="explainer-diff">
      <h3>📝 Activos que usa V428</h3>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px">
        <span class="alloc-pill alloc-bull"><strong>TQQQ</strong> 3x Nasdaq-100</span>
        <span class="alloc-pill alloc-bull"><strong>ETH</strong> Ethereum</span>
        <span class="alloc-pill alloc-gld"><strong>GLD</strong> Oro</span>
        <span class="alloc-pill alloc-cash"><strong>SHV</strong> Efectivo (T-Bills)</span>
      </div>
    </div>
  `;
}

function renderV503Explainer() {
  return `
    <div class="explainer-summary">
      <strong>V503</strong> es la versión <strong>más agresiva</strong>. Hace todo lo que V428 pero suma:
      <strong>BTC</strong> (Bitcoin), <strong>SQQQ</strong> (apuesta contra el Nasdaq cuando todo cae),
      y <strong>apalancamiento dinámico hasta 2x</strong> controlado por volatilidad.
      <br/><br/>
      🎯 <strong>Resultados del backtest (2020–2026):</strong> CAGR 123.4%, Sharpe 1.246, MaxDD 57.3%
      <br/>⚠️ El MaxDD de 57.3% es agresivo — significa que en el peor momento, el portafolio perdió más de la mitad de su valor antes de recuperarse.
    </div>

    <h3 style="font-size:15px;font-weight:700;margin-bottom:16px;color:var(--text)">🧒 Reglas del día a día — paso por paso:</h3>

    <div class="explainer-steps">
      <div class="explainer-step">
        <div class="step-number">1</div>
        <div class="step-title">📊 Misma revisión de medias que V428</div>
        <div class="step-desc">
          Mira las mismas 3 medias (SMA 15, 50, 200) pero ahora para <em>5 activos</em>:
          TQQQ, ETH, <em>BTC</em>, GLD, y <em>SQQQ</em>.
          <br/><br/>
          La señal BULL funciona exactamente igual: precio > SMA50, SMA15 > SMA50, precio > SMA200.
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">2</div>
        <div class="step-title">⚡ Apalancamiento por Volatilidad</div>
        <div class="step-desc">
          V503 <em>ajusta cuánto invierte</em> según la volatilidad reciente:
          <br/><br/>
          <strong>Volatilidad baja</strong> (mercado tranquilo) → sube hasta <em>2x</em>
          <br/><strong>Volatilidad alta</strong> (mercado turbulento) → baja hasta <em>0.5x</em>
          <br/><br/>
          Fórmula: <em>Leverage = Vol. Objetivo (100%) ÷ Vol. Real del portafolio</em>
          <br/>Mide la volatilidad de los últimos <em>21 días</em>.
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">3</div>
        <div class="step-title">💰 ¿Dónde poner el dinero?</div>
        <div class="step-desc">
          Misma cascada que V428, pero con 3 activos bull (TQQQ, ETH, <em>BTC</em>):
          <br/><br/>
          <strong>Si 2+ activos son BULL:</strong> 55% al de más momentum, 45% al segundo
          <br/><strong>Si solo uno es BULL:</strong> 100% en ese activo
          <br/><strong>Si GLD es BULL:</strong> 50% GLD + 50% Efectivo
          <br/><strong>🐻 Si SQQQ es BULL</strong> (y RSI < 90): 100% SQQQ — <em>ganar dinero cuando todo cae</em>
          <br/><strong>Rebote MR:</strong> RSI(2) < 10 → comprar el activo sobrevendido
          <br/><strong>Nada funciona:</strong> 100% Efectivo (SHV)
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">4</div>
        <div class="step-title">🐻 Modo Bear Market — SQQQ</div>
        <div class="step-desc">
          <strong>Exclusivo de V503.</strong> SQQQ es un ETF que sube cuando el Nasdaq baja (3x inverso).
          <br/><br/>
          Cuando <em>ningún activo BULL tiene señal</em> pero SQQQ sí la tiene:
          <br/>→ Significa que el Nasdaq lleva semanas cayendo
          <br/>→ V503 pone <em>100% en SQQQ</em> para ganar dinero con la caída
          <br/><br/>
          ⚠️ Pero si RSI(2) de SQQQ > 90 (ya subió mucho), no entra.
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">5</div>
        <div class="step-title">🛑 Stop-Loss + Anti-Espiral</div>
        <div class="step-desc">
          Stop-loss al <em>20%</em> de caída (más tolerante que V428).
          <br/><br/>
          <strong>Anti-espiral:</strong> Durante <em>10 días después de un stop</em>,
          el leverage se limita a 1x máximo. Esto evita que el algoritmo
          vuelva a apostar fuerte justo después de perder.
          <br/><br/>
          Después de <em>5 ciclos</em> de stop consecutivos, se reinicia el pico.
        </div>
      </div>

      <div class="explainer-step">
        <div class="step-number">6</div>
        <div class="step-title">🎯 Mean Reversion más agresiva</div>
        <div class="step-desc">
          Cuando el RSI(2) de TQQQ, ETH, o <em>BTC</em> cae bajo 10:
          <br/>→ V503 apuesta con el leverage calculado (puede ser >1x)
          <br/><br/>
          El MR overlay en V503 revisa <em>3 activos</em> (TQQQ, ETH, BTC) vs solo 2 en V428.
        </div>
      </div>
    </div>

    <div class="explainer-params">
      <h3>⚙️ Parámetros exactos de V503</h3>
      <table class="params-table">
        <thead><tr><th>Parámetro</th><th>Valor</th><th>¿Qué significa?</th></tr></thead>
        <tbody>
          <tr><td>slow</td><td>50</td><td>Media móvil lenta de 50 días</td></tr>
          <tr><td>fast</td><td>15</td><td>Media móvil rápida de 15 días (única para todos)</td></tr>
          <tr><td>regime</td><td>200</td><td>Media de régimen — define mercado alcista/bajista</td></tr>
          <tr><td>stop</td><td>20%</td><td>Stop-loss al 20% de caída — más tolerante que V428</td></tr>
          <tr><td>max_stop_cycles</td><td>5</td><td>Menos ciclos antes de reiniciar el pico (vs 20 en V428)</td></tr>
          <tr><td>target_vol</td><td>100%</td><td>Volatilidad anual objetivo para calcular leverage</td></tr>
          <tr><td>vol_lookback</td><td>21 días</td><td>Ventana para medir volatilidad reciente</td></tr>
          <tr><td>max_lev</td><td>2.0x</td><td>Apalancamiento máximo permitido</td></tr>
          <tr><td>mr_oversold</td><td>RSI < 10</td><td>RSI(2) menor a 10 = señal de rebote</td></tr>
          <tr><td>mr_alloc</td><td>25%*</td><td>25% en activo sobrevendido (código actual; documento dice 75%)</td></tr>
          <tr><td>mom_lookback</td><td>21 días</td><td>Mide el momentum de los últimos 21 días</td></tr>
          <tr><td>rebal_threshold</td><td>2%</td><td>Solo rebalancea si la diferencia es mayor a 2%</td></tr>
        </tbody>
      </table>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">* El documento 'Estrategias ganadoras' especifica mr_alloc = 0.75 (75%). El código actual usa 0.25 (25%) tras un ajuste del 25-Jun-2026. Este parámetro está en revisión.</p>
    </div>

    <div class="explainer-diff">
      <h3>⚖️ Diferencias clave: V428 vs V503</h3>
      <div class="diff-grid">
        <div class="diff-header">Característica</div>
        <div class="diff-header">V428</div>
        <div class="diff-header">V503</div>

        <div class="diff-cell">Activos</div>
        <div class="diff-cell">4 (TQQQ, ETH, GLD, SHV)</div>
        <div class="diff-cell highlight">6 (+BTC, +SQQQ)</div>

        <div class="diff-cell">Apalancamiento</div>
        <div class="diff-cell">1x fijo</div>
        <div class="diff-cell highlight">Hasta 2x (por volatilidad)</div>

        <div class="diff-cell">Bear Market</div>
        <div class="diff-cell">Refugio en GLD/SHV</div>
        <div class="diff-cell highlight">SQQQ (ganar con la caída)</div>

        <div class="diff-cell">Anti-espiral</div>
        <div class="diff-cell">No tiene</div>
        <div class="diff-cell highlight">Leverage cap 1x por 10 días post-stop</div>

        <div class="diff-cell">Stop-Loss</div>
        <div class="diff-cell highlight">11% (más conservador)</div>
        <div class="diff-cell">20% (más tolerante)</div>

        <div class="diff-cell">Max Stop Cycles</div>
        <div class="diff-cell">20</div>
        <div class="diff-cell">5</div>

        <div class="diff-cell">MR Alloc</div>
        <div class="diff-cell">25%</div>
        <div class="diff-cell">25% (código) / 75% (documento)</div>

        <div class="diff-cell">CAGR Backtest</div>
        <div class="diff-cell">57.4%</div>
        <div class="diff-cell highlight">123.4%</div>

        <div class="diff-cell">MaxDD</div>
        <div class="diff-cell highlight">51.7% (mejor)</div>
        <div class="diff-cell">57.3% (más arriesgado)</div>
      </div>
    </div>
  `;
}

function toggleExplainer() {
  const body = document.getElementById('explainerContent');
  const text = document.getElementById('explainerToggleText');
  const arrow = document.getElementById('explainerArrow');

  if (body.classList.contains('collapsed')) {
    body.classList.remove('collapsed');
    text.textContent = 'Ocultar';
    arrow.classList.remove('collapsed');
  } else {
    body.classList.add('collapsed');
    text.textContent = 'Mostrar';
    arrow.classList.add('collapsed');
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
