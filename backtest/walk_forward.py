import sys
import os
from datetime import datetime, timedelta
from pathlib import Path
import pandas as pd
import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent))
from engine.strategy import StrategyEngine, download_data

def run_walk_forward():
    print("Iniciando análisis Walk-Forward...")
    print("Descargando datos desde 2015...")
    # Descargar datos suficientes para tener varias ventanas
    data = download_data(start="2015-01-01")
    
    if len(data) < 1000:
        print("No hay suficientes datos para el walk-forward.")
        return

    # Definir parámetros de la ventana
    window_years = 2
    step_months = 6
    
    # Aproximación en días
    window_days = int(window_years * 252)
    step_days = int(step_months * 21)
    
    total_days = len(data)
    
    strategies = ['V428', 'V503']
    
    for version in strategies:
        print(f"\n{'='*60}")
        print(f"Estrategia: {version} - Análisis Walk-Forward (Ventana: {window_years} años, Paso: {step_months} meses)")
        print(f"{'='*60}")
        print(f"{'Periodo':<25} | {'CAGR':<8} | {'Sharpe':<8} | {'MaxDD':<8} | {'Win Rate':<8}")
        print("-" * 65)
        
        start_idx = 0
        all_metrics = []
        
        while start_idx + window_days < total_days:
            end_idx = start_idx + window_days
            window_data = data.iloc[start_idx:end_idx]
            
            start_date = window_data.index[0].strftime('%Y-%m-%d')
            end_date = window_data.index[-1].strftime('%Y-%m-%d')
            
            engine = StrategyEngine(version=version, initial_cash=100000.0)
            res = engine.run(window_data)
            
            if not res['metrics']:
                start_idx += step_days
                continue
                
            m = res['metrics']
            cagr = m.get('cagr', 0)
            sharpe = m.get('sharpe', 0)
            max_dd = m.get('max_dd', 0)
            win_rate = m.get('win_rate', 0)
            
            all_metrics.append({
                'cagr': cagr,
                'sharpe': sharpe,
                'max_dd': max_dd
            })
            
            print(f"{start_date} a {end_date} | {cagr:>7.1%} | {sharpe:>8.3f} | {max_dd:>7.1%} | {win_rate:>7.1%}")
            
            start_idx += step_days
            
        # Resumen
        if all_metrics:
            avg_cagr = np.mean([m['cagr'] for m in all_metrics])
            avg_sharpe = np.mean([m['sharpe'] for m in all_metrics])
            avg_max_dd = np.mean([m['max_dd'] for m in all_metrics])
            
            print("-" * 65)
            print(f"{'PROMEDIO':<25} | {avg_cagr:>7.1%} | {avg_sharpe:>8.3f} | {avg_max_dd:>7.1%} |")
            print("=" * 65)

if __name__ == '__main__':
    run_walk_forward()
