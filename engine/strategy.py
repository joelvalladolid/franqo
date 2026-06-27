"""
V428 & V503 Strategy Engine
============================
Implements both strategies from PRUEBAS.txt using yfinance data.

V428: Multi-asset trend-following + RSI(2) MR overlay (1x leverage)
      CAGR: 74.54%, Sharpe: 1.608, MaxDD: 25.9%

V503: V428 + SQQQ bear market + vol-targeting leverage (up to 2x)
      CAGR: 141.52%, Sharpe: 1.937, MaxDD: 71.2%
"""

import numpy as np
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

# ─── Strategy Parameters ─────────────────────────────────────────────────────
PARAMS_V428 = {
    'fast': 15,
    'slow': 50,
    'regime': 200,
    'stop_threshold': 0.11,
    'max_stop_cycles': 20,
    'cooldown': 1,
    'rebal_threshold': 0.02,
    'mr_oversold': 10,
    'mr_alloc': 0.25,
    'mr_exit': 50,
    'mom_lookback': 21,
    'mom_split': (0.55, 0.45),
    'leverage': 1.0,
    'max_lev': 1.0,
    'target_vol': None,  # No vol-targeting
    'use_sqqq': False,
    'free_cash': 0.05,
}

PARAMS_V503 = {
    'fast': 15,
    'slow': 50,
    'regime': 200,
    'stop_threshold': 0.20,
    'max_stop_cycles': 5,
    'cooldown': 1,
    'rebal_threshold': 0.02,
    'mr_oversold': 10,
    'mr_alloc': 0.75,
    'mr_exit': 50,
    'mom_lookback': 21,
    'mom_split': (0.55, 0.45),
    'leverage': 1.0,
    'max_lev': 2.0,
    'target_vol': 1.0,   # 100% annualized target
    'vol_lookback': 21,
    'post_stop_days': 10,
    'use_sqqq': True,
    'free_cash': 0.05,
}

# ─── Asset Tickers ────────────────────────────────────────────────────────────
TICKERS = {
    'TQQQ': 'TQQQ',
    'ETH':  'ETH-USD',
    'BTC':  'BTC-USD',
    'SQQQ': 'SQQQ',
    'GLD':  'GLD',
    'SHV':  'SHV',
}


def download_data(start: str, end: str = None, period: str = None) -> pd.DataFrame:
    """Download OHLCV data for all assets from yfinance."""
    if end is None:
        end = datetime.today().strftime('%Y-%m-%d')
    
    all_closes = {}
    for name, ticker in TICKERS.items():
        try:
            if period:
                df = yf.download(ticker, period=period, interval='1d', 
                                 progress=False, auto_adjust=True)
            else:
                df = yf.download(ticker, start=start, end=end, 
                                 progress=False, auto_adjust=True)
            if len(df) > 0:
                all_closes[name] = df['Close'].squeeze()
        except Exception as e:
            print(f"Warning: Could not download {ticker}: {e}")
    
    data = pd.DataFrame(all_closes)
    data.index = pd.to_datetime(data.index)
    # Forward fill missing (e.g. crypto doesn't trade weekdays the same)
    data = data.ffill()
    return data.dropna(how='all')


def compute_rsi2(series: pd.Series) -> pd.Series:
    """RSI(2) using Simple Moving Average (Connors style)."""
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(2).mean()
    avg_loss = loss.rolling(2).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi


def compute_signal(prices: pd.Series, fast: int, slow: int, regime: int) -> pd.Series:
    """
    Trend signal: True when:
    1. price > SMA(slow)
    2. SMA(fast) > SMA(slow) — bullish crossover
    3. price > SMA(regime) — long-term bull regime
    """
    sma_fast = prices.rolling(fast).mean()
    sma_slow = prices.rolling(slow).mean()
    sma_regime = prices.rolling(regime).mean()
    
    signal = (prices > sma_slow) & (sma_fast > sma_slow) & (prices > sma_regime)
    return signal.fillna(False)


def compute_momentum(prices: pd.Series, lookback: int) -> pd.Series:
    """21-day momentum: price / price[21 days ago] - 1"""
    return prices / prices.shift(lookback) - 1


class StrategyEngine:
    """
    Runs the V428 or V503 strategy on historical data.
    Outputs daily positions, equity curve, and metrics.
    """

    def __init__(self, version: str = 'V503', initial_cash: float = 100_000.0):
        self.version = version.upper()
        self.params = PARAMS_V428.copy() if self.version == 'V428' else PARAMS_V503.copy()
        self.initial_cash = initial_cash

    def run(self, data: pd.DataFrame) -> dict:
        """
        Run backtest on a DataFrame of daily close prices.
        Returns dict with equity_curve, positions, trades, metrics.
        """
        p = self.params
        dates = data.index
        n = len(dates)

        # Precompute indicators
        signals = {}
        rsi = {}
        momentum = {}

        for asset in ['TQQQ', 'ETH', 'BTC', 'SQQQ', 'GLD']:
            if asset not in data.columns:
                signals[asset] = pd.Series(False, index=data.index)
                rsi[asset] = pd.Series(50.0, index=data.index)
                momentum[asset] = pd.Series(0.0, index=data.index)
                continue
            
            signals[asset] = compute_signal(
                data[asset], p['fast'], p['slow'], p['regime']
            )
            rsi[asset] = compute_rsi2(data[asset])
            momentum[asset] = compute_momentum(data[asset], p['mom_lookback'])

        # ── Portfolio State ──────────────────────────────────────────────────
        equity = self.initial_cash
        peak = equity
        weights = {'SHV': 1.0}   # current target weights
        
        # Stop-loss state
        in_stop = False
        cooldown_days = 0
        stop_counter = 0
        days_since_stop = 999   # for post-stop leverage cap
        
        # Vol-targeting state
        daily_returns = []
        prev_equity = equity

        # Output arrays
        equities = [equity]
        daily_rets = [0.0]
        all_weights = [weights.copy()]
        trades_log = []

        for i in range(1, n):
            date = dates[i]
            prev_date = dates[i - 1]

            # Track daily return for vol-targeting
            if p.get('target_vol') and prev_equity > 0:
                ret = (equity - prev_equity) / prev_equity
                daily_returns.append(ret)
                if len(daily_returns) > p.get('vol_lookback', 21):
                    daily_returns.pop(0)
            prev_equity = equity

            # ── Compute leverage ─────────────────────────────────────────────
            lev = 1.0
            if p.get('target_vol') and len(daily_returns) >= 5:
                vol_lookback = p.get('vol_lookback', 21)
                recent_vol = np.std(daily_returns[-vol_lookback:]) * np.sqrt(252)
                if recent_vol > 0:
                    lev = p['target_vol'] / recent_vol
                    # Post-stop leverage cap
                    days_since_stop += 1
                    post_stop = p.get('post_stop_days', 10)
                    if days_since_stop < post_stop:
                        lev = min(lev, 1.0)
                    lev = max(0.5, min(lev, p['max_lev']))

            # ── Stop-loss check ──────────────────────────────────────────────
            if equity > peak:
                peak = equity
                stop_counter = 0

            skip_drawdown_check = False
            if in_stop:
                cooldown_days += 1
                if cooldown_days >= p['cooldown']:
                    in_stop = False
                    cooldown_days = 0
                    skip_drawdown_check = True  # Give it one day to trade MR overlay
                else:
                    # Remain in cash during cooldown
                    # Apply existing weights to prices
                    equity = self._apply_weights(equity, weights, data, i, prev_date, date)
                    equities.append(equity)
                    daily_rets.append((equity - equities[-2]) / equities[-2] if equities[-2] > 0 else 0)
                    all_weights.append(weights.copy())
                    continue

            if not skip_drawdown_check and peak > 0 and (peak - equity) / peak > p['stop_threshold']:
                stop_counter += 1
                if stop_counter >= p['max_stop_cycles']:
                    peak = equity
                    stop_counter = 0
                else:
                    in_stop = True
                    cooldown_days = 0
                    days_since_stop = 0
                    # Liquidate to cash
                    if weights.get('SHV', 0) < 0.99:
                        trades_log.append({
                            'date': date.strftime('%Y-%m-%d'),
                            'action': '🛑 VENDER TODO (STOP)',
                            'details': f'Caída del {(peak-equity)/peak:.1%}. Vender todo y pasar a 100% Efectivo (SHV).',
                            'equity': equity,
                        })
                    weights = {'SHV': 1.0}
                    equity = self._apply_weights(equity, weights, data, i, prev_date, date)
                    equities.append(equity)
                    daily_rets.append((equity - equities[-2]) / equities[-2] if equities[-2] > 0 else 0)
                    all_weights.append(weights.copy())
                    continue

            # ── Signal generation (use data available at i-1) ────────────────
            # Only use data up to previous day (no lookahead)
            sig_idx = i - 1
            
            tqqq_bull = bool(signals['TQQQ'].iloc[sig_idx]) if 'TQQQ' in signals else False
            eth_bull   = bool(signals['ETH'].iloc[sig_idx])  if 'ETH'  in signals else False
            btc_bull   = bool(signals['BTC'].iloc[sig_idx])  if 'BTC'  in signals else False
            gld_bull   = bool(signals['GLD'].iloc[sig_idx])  if 'GLD'  in signals else False
            sqqq_bull  = bool(signals['SQQQ'].iloc[sig_idx]) if 'SQQQ' in signals and p['use_sqqq'] else False
            
            rsi_tqqq = float(rsi['TQQQ'].iloc[sig_idx]) if 'TQQQ' in rsi else 50.0
            rsi_eth  = float(rsi['ETH'].iloc[sig_idx])  if 'ETH'  in rsi else 50.0
            rsi_btc  = float(rsi['BTC'].iloc[sig_idx])  if 'BTC'  in rsi else 50.0
            rsi_sqqq = float(rsi['SQQQ'].iloc[sig_idx]) if 'SQQQ' in rsi else 50.0
            
            mom_tqqq = float(momentum['TQQQ'].iloc[sig_idx]) if 'TQQQ' in momentum else 0.0
            mom_eth  = float(momentum['ETH'].iloc[sig_idx])  if 'ETH'  in momentum else 0.0
            mom_btc  = float(momentum['BTC'].iloc[sig_idx])  if 'BTC'  in momentum else 0.0

            # ── Allocation cascade ───────────────────────────────────────────
            new_weights = self._allocate(
                tqqq_bull, eth_bull, btc_bull, gld_bull, sqqq_bull,
                rsi_tqqq, rsi_eth, rsi_btc, rsi_sqqq,
                mom_tqqq, mom_eth, mom_btc,
                lev, p
            )

            # ── Rebalance threshold check ────────────────────────────────────
            need_trade = False
            all_syms = set(new_weights.keys()) | set(weights.keys())
            for sym in all_syms:
                diff = abs(new_weights.get(sym, 0) - weights.get(sym, 0))
                if diff > p['rebal_threshold']:
                    need_trade = True
                    break

            if need_trade and new_weights != weights:
                # Log trade
                old_str = ', '.join(f"{k}:{v:.0%}" for k, v in weights.items() if v > 0.01)
                new_str = ', '.join(f"{k}:{v:.0%}" for k, v in new_weights.items() if v > 0.01)
                if old_str != new_str:
                    trades_log.append({
                        'date': date.strftime('%Y-%m-%d'),
                        'action': '🔄 COMPRAR / VENDER',
                        'from': old_str,
                        'to': new_str,
                        'details': f"Ajustar posiciones. Vender actuales y COMPRAR EXACTAMENTE: {new_str}",
                        'equity': equity,
                    })
                weights = new_weights

            # ── Apply returns ────────────────────────────────────────────────
            equity = self._apply_weights(equity, weights, data, i, prev_date, date)
            equities.append(equity)
            daily_rets.append((equity - equities[-2]) / equities[-2] if equities[-2] > 0 else 0)
            all_weights.append(weights.copy())

        # ── Compute Metrics ───────────────────────────────────────────────────
        eq_series = pd.Series(equities, index=dates)
        ret_series = pd.Series(daily_rets[1:], index=dates[1:])

        metrics = self._compute_metrics(eq_series, ret_series)
        
        return {
            'equity_curve': eq_series,
            'daily_returns': ret_series,
            'all_weights': pd.DataFrame(all_weights, index=dates),
            'trades': trades_log,
            'metrics': metrics,
            'final_equity': equities[-1],
            'initial_equity': self.initial_cash,
            'version': self.version,
            'final_state': {
                'equity': equity,
                'peak': peak,
                'in_stop': in_stop,
                'cooldown_days': cooldown_days,
                'stop_counter': stop_counter,
                'days_since_stop': days_since_stop,
                'daily_returns_list': daily_returns,
            }
        }

    def _allocate(self, tqqq_bull, eth_bull, btc_bull, gld_bull, sqqq_bull,
                  rsi_tqqq, rsi_eth, rsi_btc, rsi_sqqq,
                  mom_tqqq, mom_eth, mom_btc, lev, p):
        """V503 allocation cascade."""
        w = p['mom_split']
        mr_alloc = p['mr_alloc']
        oversold = p['mr_oversold']

        # Build list of active bull assets
        active = []
        if tqqq_bull: active.append(('TQQQ', mom_tqqq))
        if eth_bull:  active.append(('ETH',  mom_eth))
        if btc_bull:  active.append(('BTC',  mom_btc))
        active.sort(key=lambda x: x[1], reverse=True)

        if len(active) >= 2:
            # 55/45 momentum-weighted split between top 2
            return {active[0][0]: w[0] * lev, active[1][0]: w[1] * lev}
        elif len(active) == 1:
            return {active[0][0]: 1.0 * lev}
        elif gld_bull:
            return {'GLD': 0.5 * lev, 'SHV': 0.5 * lev}
        elif p['use_sqqq'] and sqqq_bull and rsi_sqqq < 90:
            # Bear market — profit from SQQQ
            return {'SQQQ': 1.0 * lev}
        else:
            # MR overlay
            mr_asset = None
            mr_rsi = 999
            if rsi_tqqq < oversold and rsi_tqqq < mr_rsi:
                mr_asset, mr_rsi = 'TQQQ', rsi_tqqq
            if rsi_eth < oversold and rsi_eth < mr_rsi:
                mr_asset, mr_rsi = 'ETH', rsi_eth
            if rsi_btc < oversold and rsi_btc < mr_rsi:
                mr_asset, mr_rsi = 'BTC', rsi_btc

            if mr_asset:
                return {mr_asset: mr_alloc, 'SHV': (1.0 - mr_alloc)}
            else:
                return {'SHV': 1.0}

    def _apply_weights(self, equity, weights, data, i, prev_date, date):
        """Apply portfolio weights to daily returns."""
        total = equity
        for asset, w in weights.items():
            if asset not in data.columns or w == 0:
                continue
            prev_price = data[asset].iloc[i - 1]
            curr_price = data[asset].iloc[i]
            if prev_price > 0:
                ret = (curr_price - prev_price) / prev_price
                total += equity * w * ret
        return max(total, 0.0)

    def _compute_metrics(self, equity: pd.Series, returns: pd.Series) -> dict:
        """Compute CAGR, Sharpe, MaxDD, Sortino, Win Rate."""
        if len(equity) < 2:
            return {}

        # CAGR
        years = (equity.index[-1] - equity.index[0]).days / 365.25
        cagr = (equity.iloc[-1] / equity.iloc[0]) ** (1 / max(years, 0.01)) - 1

        # Sharpe (annualized, risk-free=0)
        mu = returns.mean() * 252
        sigma = returns.std() * np.sqrt(252)
        sharpe = mu / sigma if sigma > 0 else 0

        # Sortino
        downside = returns[returns < 0].std() * np.sqrt(252)
        sortino = mu / downside if downside > 0 else 0

        # Max Drawdown
        rolling_max = equity.cummax()
        drawdown = (equity - rolling_max) / rolling_max
        max_dd = drawdown.min()

        # Win rate
        win_rate = (returns > 0).sum() / max(len(returns), 1)

        # Total return
        total_return = (equity.iloc[-1] - equity.iloc[0]) / equity.iloc[0]

        # Daily return
        daily_return = (1 + cagr) ** (1 / 252) - 1

        return {
            'cagr': float(cagr),
            'sharpe': float(sharpe),
            'sortino': float(sortino),
            'max_dd': float(max_dd),
            'win_rate': float(win_rate),
            'total_return': float(total_return),
            'daily_return': float(daily_return),
            'final_equity': float(equity.iloc[-1]),
            'years': float(years),
            'num_trades': len(returns[returns != 0]),
            'daily_vol': float(returns.std() * np.sqrt(252)),
        }


def get_today_signals(version: str = 'V503') -> dict:
    """
    Compute today's trading signals using the latest available data.
    Returns the recommended portfolio allocation for TODAY.
    """
    params = PARAMS_V428 if version.upper() == 'V428' else PARAMS_V503
    p = params

    # Download enough data for all indicators
    lookback_days = p['regime'] + 100
    start = (datetime.today() - timedelta(days=lookback_days * 2)).strftime('%Y-%m-%d')
    
    data = download_data(start=start)
    if len(data) < p['regime'] + 21:
        return {'error': 'Insufficient data'}

    # 1. Run backtest to get exact state as of today
    engine = StrategyEngine(version)
    res = engine.run(data)
    state = res['final_state']

    # 2. Compute the signal for TOMORROW using TODAY'S close
    last_idx = len(data) - 1  # No lookahead, use the absolute latest data

    signals = {}
    rsi = {}
    momentum = {}
    detail = {}
    bull_assets = []
    
    for asset in ['TQQQ', 'ETH', 'BTC', 'GLD', 'SQQQ']:
        if asset not in data.columns:
            continue
        prices = data[asset]
        sma_fast = prices.rolling(p['fast']).mean()
        sma_slow = prices.rolling(p['slow']).mean()
        sma_regime = prices.rolling(p['regime']).mean()
        rsi_vals = compute_rsi2(prices)
        mom = compute_momentum(prices, p['mom_lookback'])
        
        is_bull = bool(
            prices.iloc[last_idx] > sma_slow.iloc[last_idx] and
            sma_fast.iloc[last_idx] > sma_slow.iloc[last_idx] and
            prices.iloc[last_idx] > sma_regime.iloc[last_idx]
        )
        
        detail[asset] = {
            'price': float(prices.iloc[last_idx]),
            'price_prev': float(prices.iloc[last_idx - 1]) if last_idx > 0 else float(prices.iloc[last_idx]),
            'sma_fast': float(sma_fast.iloc[last_idx]),
            'sma_slow': float(sma_slow.iloc[last_idx]),
            'sma_regime': float(sma_regime.iloc[last_idx]),
            'rsi2': float(rsi_vals.iloc[last_idx]) if pd.notna(rsi_vals.iloc[last_idx]) else None,
            'momentum': float(mom.iloc[last_idx]) if pd.notna(mom.iloc[last_idx]) else None,
            'is_bull': is_bull,
            'above_fast': bool(prices.iloc[last_idx] > sma_fast.iloc[last_idx]),
            'above_slow': bool(prices.iloc[last_idx] > sma_slow.iloc[last_idx]),
            'above_regime': bool(prices.iloc[last_idx] > sma_regime.iloc[last_idx]),
        }
        
        if is_bull and asset not in ['SQQQ', 'GLD']:
            bull_assets.append((asset, float(mom.iloc[last_idx])))
            
        signals[asset] = is_bull
        rsi[asset] = float(rsi_vals.iloc[last_idx]) if pd.notna(rsi_vals.iloc[last_idx]) else 50.0
        momentum[asset] = float(mom.iloc[last_idx]) if pd.notna(mom.iloc[last_idx]) else 0.0

    # 3. Compute leverage exactly as backtest does
    lev = 1.0
    if p.get('target_vol') and len(state['daily_returns_list']) >= 5:
        vol_lookback = p.get('vol_lookback', 21)
        recent_vol = np.std(state['daily_returns_list'][-vol_lookback:]) * np.sqrt(252)
        if recent_vol > 0:
            lev = p['target_vol'] / recent_vol
            if state['days_since_stop'] < p.get('post_stop_days', 10):
                lev = min(lev, 1.0)
            lev = max(0.5, min(lev, p['max_lev']))
            
    # 4. Check if we should be in stop mode
    equity = state['equity']
    peak = state['peak']
    in_stop = state['in_stop']
    
    if in_stop:
        allocation = {'SHV': 1.0}
        signal_reason = f'🛑 STOP MODE (Cooldown) - 100% SHV'
    elif peak > 0 and (peak - equity) / peak > p['stop_threshold']:
        allocation = {'SHV': 1.0}
        signal_reason = f'🛑 VENDER TODO (STOP) - Caída del {(peak-equity)/peak:.1%}'
    else:
        # 5. Normal allocation cascade
        allocation = engine._allocate(
            signals.get('TQQQ', False), signals.get('ETH', False), signals.get('BTC', False),
            signals.get('GLD', False), signals.get('SQQQ', False),
            rsi.get('TQQQ', 50), rsi.get('ETH', 50), rsi.get('BTC', 50), rsi.get('SQQQ', 50),
            momentum.get('TQQQ', 0), momentum.get('ETH', 0), momentum.get('BTC', 0),
            lev, p
        )
        
        # Format reason string
        bull_assets.sort(key=lambda x: x[1], reverse=True)
        if len(bull_assets) >= 2:
            signal_reason = f'📈 BULL — Top 2: {bull_assets[0][0]} & {bull_assets[1][0]} (Lev: {lev:.2f}x)'
        elif len(bull_assets) == 1:
            signal_reason = f'📈 BULL — 100% {bull_assets[0][0]} (Lev: {lev:.2f}x)'
        elif signals.get('GLD', False):
            signal_reason = f'🥇 GLD fallback (Lev: {lev:.2f}x)'
        elif signals.get('SQQQ', False) and rsi.get('SQQQ', 50) < 90 and p.get('use_sqqq', False):
            signal_reason = f'🐻 BEAR MARKET — SQQQ (Lev: {lev:.2f}x)'
        else:
            mr_candidates = [(a, rsi.get(a, 50)) for a in ['TQQQ', 'ETH', 'BTC'] if rsi.get(a, 50) < p['mr_oversold']]
            if mr_candidates:
                mr_asset = sorted(mr_candidates, key=lambda x: x[1])[0][0]
                signal_reason = f'🎯 MR OVERLAY — RSI(2) oversold on {mr_asset} (Lev: {lev:.2f}x)'
            else:
                signal_reason = '💰 CASH — 100% SHV (no trend, no MR)'

    return {
        'version': version,
        'date': datetime.today().strftime('%Y-%m-%d'),
        'allocation': allocation,
        'signal_reason': signal_reason,
        'asset_details': detail,
        'bull_assets': [a[0] for a in bull_assets],
        'data_date': data.index[-1].strftime('%Y-%m-%d'),
        'signal_date': data.index[-1].strftime('%Y-%m-%d'),
    }


if __name__ == '__main__':
    print("Testing strategy engine...")
    signals_v428 = get_today_signals('V428')
    signals_v503 = get_today_signals('V503')
    
    print(f"\n=== V428 Today's Signal ===")
    print(f"Signal: {signals_v428['signal_reason']}")
    print(f"Allocation: {signals_v428['allocation']}")
    
    print(f"\n=== V503 Today's Signal ===")
    print(f"Signal: {signals_v503['signal_reason']}")
    print(f"Allocation: {signals_v503['allocation']}")
