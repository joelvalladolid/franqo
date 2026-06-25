"""
Backtest Runner — V428 & V503
================================
Runs a 3-year historical backtest and a 3-year look-forward (out-of-sample)
analysis using yfinance data. Saves results as JSON for the dashboard.
"""

import json
import sys
import os
from datetime import datetime, timedelta
from pathlib import Path
import pandas as pd
import numpy as np

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))
from engine.strategy import StrategyEngine, download_data, get_today_signals, TICKERS

import yfinance as yf
import warnings
warnings.filterwarnings('ignore')

def clean_nans(obj):
    if isinstance(obj, dict):
        return {k: clean_nans(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [clean_nans(v) for v in obj]
    elif isinstance(obj, float) and pd.isna(obj):
        return None
    return obj


def run_backtest(
    version: str,
    start: str,
    end: str,
    label: str,
    initial_cash: float = 100_000.0,
) -> dict:
    """Run a single backtest and return results dict."""
    print(f"  Running {version} backtest: {label} ({start} → {end})...")
    
    data = download_data(start=start, end=end)
    if len(data) < 250:
        print(f"  Warning: Only {len(data)} rows of data available")
        return None

    engine = StrategyEngine(version=version, initial_cash=initial_cash)
    result = engine.run(data)

    # Convert equity curve to JSON-serializable format
    equity = result['equity_curve']
    rets = result['daily_returns']
    
    # Downsample to weekly for chart performance (daily points for full precision)
    equity_chart = [
        {'date': d.strftime('%Y-%m-%d'), 'value': round(float(v), 2) if pd.notna(v) else None}
        for d, v in equity.items()
    ]
    
    # Benchmark (buy-and-hold TQQQ)
    tqqq_bench = None
    if 'TQQQ' in data.columns:
        tqqq_valid = data['TQQQ'].bfill()
        tqqq_start = float(tqqq_valid.iloc[0])
        bench_equity = (tqqq_valid / tqqq_start) * initial_cash
        tqqq_bench = [
            {'date': d.strftime('%Y-%m-%d'), 'value': round(float(v), 2) if pd.notna(v) else None}
            for d, v in bench_equity.items()
        ]
        # Benchmark metrics
        bench_rets = tqqq_valid.pct_change().dropna()
        bench_cagr = (bench_equity.iloc[-1] / bench_equity.iloc[0]) ** (
            365.25 / (bench_equity.index[-1] - bench_equity.index[0]).days
        ) - 1
        bench_sharpe = bench_rets.mean() * 252 / (bench_rets.std() * np.sqrt(252))
        rolling_max_b = bench_equity.cummax()
        bench_maxdd = float(((bench_equity - rolling_max_b) / rolling_max_b).min())
    else:
        bench_cagr = bench_sharpe = bench_maxdd = 0.0

    # Monthly returns heatmap
    monthly_rets = (1 + rets).resample('ME').prod() - 1
    monthly_data = []
    for dt, val in monthly_rets.items():
        monthly_data.append({
            'year': int(dt.year),
            'month': int(dt.month),
            'return': round(float(val) * 100, 2),
        })

    return {
        'label': label,
        'version': version,
        'start': start,
        'end': end,
        'initial_cash': initial_cash,
        'metrics': result['metrics'],
        'benchmark': {
            'cagr': float(bench_cagr),
            'sharpe': float(bench_sharpe),
            'max_dd': float(bench_maxdd),
        },
        'equity_curve': equity_chart,
        'benchmark_curve': tqqq_bench,
        'monthly_returns': monthly_data,
        'trades': result['trades'][-100:],  # Last 100 trades
        'num_trades': len(result['trades']),
        'final_equity': result['final_equity'],
        'generated_at': datetime.utcnow().isoformat() + 'Z',
    }


def run_all_backtests(output_dir: str = None):
    """Run all backtests and save to JSON."""
    if output_dir is None:
        output_dir = Path(__file__).parent.parent / 'dashboard' / 'data'
    
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.today()
    # 3-year lookback + 3-year look-forward setup:
    # We use 2018 → 2021 as "historical backtest" and 2021 → today as "look-forward"
    
    backtest_configs = [
        # In-sample: 3 years historical
        {
            'version': 'V428',
            'start': '2018-01-01',
            'end':   '2021-01-01',
            'label': 'V428 — Historical (2018–2021)',
        },
        {
            'version': 'V503',
            'start': '2018-01-01',
            'end':   '2021-01-01',
            'label': 'V503 — Historical (2018–2021)',
        },
        # Out-of-sample look-forward: 3 years from 2021
        {
            'version': 'V428',
            'start': '2021-01-01',
            'end':   today.strftime('%Y-%m-%d'),
            'label': 'V428 — Look-Forward (2021–Today)',
        },
        {
            'version': 'V503',
            'start': '2021-01-01',
            'end':   today.strftime('%Y-%m-%d'),
            'label': 'V503 — Look-Forward (2021–Today)',
        },
        # Full history: from 2020
        {
            'version': 'V428',
            'start': '2020-01-01',
            'end':   today.strftime('%Y-%m-%d'),
            'label': 'V428 — Full Period (2020–Today)',
        },
        {
            'version': 'V503',
            'start': '2020-01-01',
            'end':   today.strftime('%Y-%m-%d'),
            'label': 'V503 — Full Period (2020–Today)',
        },
        # Bear market stress test: from 2022
        {
            'version': 'V503',
            'start': '2022-01-01',
            'end':   today.strftime('%Y-%m-%d'),
            'label': 'V503 — Stress Test (2022 Bear Market Start)',
        },
    ]

    all_results = []
    for cfg in backtest_configs:
        result = run_backtest(
            version=cfg['version'],
            start=cfg['start'],
            end=cfg['end'],
            label=cfg['label'],
        )
        if result:
            all_results.append(result)
            print(f"  ✓ {cfg['label']}: CAGR={result['metrics']['cagr']:.1%}, "
                  f"Sharpe={result['metrics']['sharpe']:.3f}, "
                  f"MaxDD={result['metrics']['max_dd']:.1%}")
    
    # Save all results
    all_results = clean_nans(all_results)
    output_file = output_dir / 'backtest_results.json'
    with open(output_file, 'w') as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\n✓ Saved {len(all_results)} backtest results to {output_file}")
    
    # Get today's signals
    print("\nGenerating today's signals...")
    signals = {}
    for v in ['V428', 'V503']:
        try:
            sig = get_today_signals(v)
            signals[v] = sig
            print(f"  ✓ {v}: {sig['signal_reason']}")
        except Exception as e:
            print(f"  Error getting {v} signals: {e}")
            signals[v] = {'error': str(e)}
    
    signals_file = output_dir / 'signals.json'
    with open(signals_file, 'w') as f:
        json.dump({
            'generated_at': datetime.utcnow().isoformat() + 'Z',
            'signals': signals,
        }, f, indent=2, default=str)
    print(f"✓ Saved signals to {signals_file}")
    
    return all_results, signals


if __name__ == '__main__':
    print("=" * 60)
    print("V428 & V503 Strategy — Backtest Runner")
    print("=" * 60)
    
    results, signals = run_all_backtests()
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for r in results:
        m = r['metrics']
        print(f"\n{r['label']}")
        print(f"  CAGR:      {m['cagr']:.1%}")
        print(f"  Sharpe:    {m['sharpe']:.3f}")
        print(f"  MaxDD:     {m['max_dd']:.1%}")
        print(f"  Daily Ret: {m['daily_return']:.3%}")
        print(f"  Win Rate:  {m['win_rate']:.1%}")
        print(f"  Final:     ${m['final_equity']:,.0f}")
