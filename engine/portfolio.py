"""
Virtual Portfolio Manager
===========================
Tracks the virtual $100K paper trading portfolio for both V428 and V503.
Saves state to JSON and generates daily updates.
"""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
import sys
import yfinance as yf
import pandas as pd
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from engine.strategy import get_today_signals, TICKERS

PORTFOLIO_FILE = Path(__file__).parent.parent / 'dashboard' / 'data' / 'portfolio.json'
INITIAL_CASH = 100_000.0

TICKER_SYMBOL_MAP = {
    'TQQQ': 'TQQQ',
    'ETH':  'ETH-USD',
    'BTC':  'BTC-USD',
    'SQQQ': 'SQQQ',
    'GLD':  'GLD',
    'SHV':  'SHV',
}


def load_portfolio() -> dict:
    """Load portfolio state from JSON, or create fresh one."""
    if PORTFOLIO_FILE.exists():
        with open(PORTFOLIO_FILE) as f:
            return json.load(f)
    
    return {
        'initialized_at': datetime.utcnow().isoformat() + 'Z',
        'initial_cash': INITIAL_CASH,
        'portfolios': {
            'V428': _empty_portfolio('V428'),
            'V503': _empty_portfolio('V503'),
        },
    }


def _empty_portfolio(version: str) -> dict:
    return {
        'version': version,
        'cash': INITIAL_CASH,
        'positions': {},     # {symbol: {shares, avg_cost, current_price, value}}
        'nav': INITIAL_CASH,
        'peak_nav': INITIAL_CASH,
        'drawdown': 0.0,
        'total_return': 0.0,
        'total_trades': 0,
        'history': [         # Daily NAV history
            {
                'date': datetime.utcnow().strftime('%Y-%m-%d'),
                'nav': INITIAL_CASH,
                'weights': {'SHV': 1.0},
            }
        ],
        'trade_log': [],
        'current_allocation': {'SHV': 1.0},
        'signal_reason': 'Initialized — 100% SHV (Cash)',
        'last_updated': datetime.utcnow().isoformat() + 'Z',
    }


def save_portfolio(state: dict):
    PORTFOLIO_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(PORTFOLIO_FILE, 'w') as f:
        json.dump(state, f, indent=2, default=str)


def get_current_prices(symbols: list[str]) -> dict:
    """Get latest prices for a list of symbols."""
    prices = {}
    for sym in symbols:
        ticker = TICKER_SYMBOL_MAP.get(sym, sym)
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period='5d')
            if len(hist) > 0:
                prices[sym] = float(hist['Close'].iloc[-1])
        except Exception as e:
            print(f"Warning: Could not get price for {ticker}: {e}")
    return prices


def update_portfolio(version: str, state: dict) -> dict:
    """
    Update a virtual portfolio with today's signals and prices.
    Executes paper trades to match the strategy's target allocation.
    """
    today = datetime.utcnow().strftime('%Y-%m-%d')
    port = state['portfolios'][version]

    # Get today's signals
    try:
        sig = get_today_signals(version)
        target_alloc = sig['allocation']
        signal_reason = sig['signal_reason']
    except Exception as e:
        print(f"Error getting signals: {e}")
        return state

    # Get current prices
    all_symbols = list(set(list(target_alloc.keys()) + list(port['positions'].keys())))
    prices = get_current_prices(all_symbols)
    
    if not prices:
        print("Error: Could not get any prices")
        return state

    # Compute current NAV
    nav = port['cash']
    for sym, pos in port['positions'].items():
        if sym in prices:
            pos['current_price'] = prices[sym]
            pos['value'] = pos['shares'] * prices[sym]
            nav += pos['value']
        elif 'value' in pos:
            nav += pos['value']

    port['nav'] = nav
    port['peak_nav'] = max(port['peak_nav'], nav)
    port['drawdown'] = (port['peak_nav'] - nav) / port['peak_nav'] if port['peak_nav'] > 0 else 0.0
    port['total_return'] = (nav - INITIAL_CASH) / INITIAL_CASH

    # Check if allocation needs updating (rebalance threshold: 2%)
    current_alloc = {}
    for sym, pos in port['positions'].items():
        if nav > 0:
            current_alloc[sym] = pos.get('value', 0) / nav
    if port['cash'] > 0 and nav > 0:
        current_alloc['SHV'] = current_alloc.get('SHV', 0) + port['cash'] / nav

    needs_rebalance = False
    for sym in set(list(target_alloc.keys()) + list(current_alloc.keys())):
        target_w = target_alloc.get(sym, 0)
        current_w = current_alloc.get(sym, 0)
        if abs(target_w - current_w) > 0.02:
            needs_rebalance = True
            break

    if needs_rebalance:
        # Execute paper trades
        old_alloc_str = ', '.join(f"{k}:{v:.0%}" for k, v in current_alloc.items() if v > 0.01)
        new_alloc_str = ', '.join(f"{k}:{v:.0%}" for k, v in target_alloc.items() if v > 0.01)
        
        # Liquidate current positions
        cash = nav  # Assume we can liquidate all at current prices
        port['positions'] = {}
        port['cash'] = 0
        
        # Enter new positions
        for sym, weight in target_alloc.items():
            if weight <= 0 or sym == 'SHV':
                continue
            if sym not in prices:
                continue
            value = nav * weight
            shares = value / prices[sym]
            port['positions'][sym] = {
                'shares': shares,
                'avg_cost': prices[sym],
                'current_price': prices[sym],
                'value': value,
                'weight': weight,
            }
            cash -= value
        
        port['cash'] = max(cash, 0) + nav * target_alloc.get('SHV', 0)
        
        port['trade_log'].append({
            'date': datetime.utcnow().strftime('%Y-%m-%d %H:%M') + ' UTC',
            'action': '🔄 COMPRAR / VENDER',
            'from': old_alloc_str,
            'to': new_alloc_str,
            'signal': f"Vender posiciones actuales y COMPRAR EXACTAMENTE: {new_alloc_str}",
            'nav': round(nav, 2),
        })
        port['total_trades'] += 1

    port['current_allocation'] = target_alloc
    port['signal_reason'] = signal_reason
    port['action_required'] = needs_rebalance
    port['last_updated'] = datetime.utcnow().isoformat() + 'Z'

    # Add to history (only once per day)
    if not port['history'] or port['history'][-1]['date'] != today:
        port['history'].append({
            'date': today,
            'nav': round(nav, 2),
            'weights': target_alloc,
            'return': round(port['total_return'] * 100, 3),
        })
        # Keep last 365 days
        port['history'] = port['history'][-365:]

    state['portfolios'][version] = port
    return state


def run_daily_update():
    """Run the daily portfolio update for both strategies."""
    print("=" * 60)
    print(f"Paper Trading Update — {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
    print("=" * 60)

    state = load_portfolio()

    for version in ['V428', 'V503']:
        print(f"\nUpdating {version} portfolio...")
        state = update_portfolio(version, state)
        port = state['portfolios'][version]
        print(f"  NAV:    ${port['nav']:,.2f}")
        print(f"  Return: {port['total_return']:+.2%}")
        print(f"  Signal: {port['signal_reason']}")
        print(f"  Alloc:  {port['current_allocation']}")

    save_portfolio(state)
    print(f"\n✓ Portfolio saved to {PORTFOLIO_FILE}")
    return state


if __name__ == '__main__':
    state = run_daily_update()
