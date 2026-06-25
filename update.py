"""
Update Script — Run this to refresh the dashboard data
========================================================
Usage: python update.py
This fetches latest prices, computes signals, and saves all JSON data
for the Netlify dashboard.
"""

import sys
import json
from pathlib import Path
from datetime import datetime

# Add path
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.portfolio import run_daily_update
from engine.strategy import get_today_signals


def update_signals_only():
    """Fast update — just refresh signals and prices."""
    print(f"Refreshing signals at {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}...")
    
    output_dir = Path(__file__).parent / 'dashboard' / 'data'
    output_dir.mkdir(parents=True, exist_ok=True)
    
    signals = {}
    for v in ['V428', 'V503']:
        try:
            sig = get_today_signals(v)
            signals[v] = sig
            print(f"  ✓ {v}: {sig['signal_reason']}")
        except Exception as e:
            print(f"  ✗ {v}: Error — {e}")
            signals[v] = {'error': str(e), 'version': v}
    
    out = {
        'generated_at': datetime.utcnow().isoformat() + 'Z',
        'signals': signals,
    }
    
    with open(output_dir / 'signals.json', 'w') as f:
        json.dump(out, f, indent=2, default=str)
    
    print(f"✓ Signals saved")
    return out


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--signals-only', action='store_true',
                        help='Only update signals (faster, no portfolio update)')
    args = parser.parse_args()
    
    if args.signals_only:
        update_signals_only()
    else:
        # Full update
        state = run_daily_update()
        update_signals_only()
        print("\n✓ All data updated successfully!")
        print("  Open dashboard/index.html in a browser or deploy to Netlify.")
