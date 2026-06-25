# SMF Paper Trading — V428 & V503 Strategy Dashboard

Un dashboard profesional para simular y ejecutar las estrategias algorítmicas V428 y V503.

---

## 🚀 Rutina Diaria del Trader (Uso Local)

El sistema está diseñado para que todo el trabajo pesado ocurra de forma automatizada en tu computadora local:

1. **Al cierre del mercado:** Haz doble clic en el archivo `Iniciar_Dashboard.bat` ubicado en tu carpeta.
2. **El Motor:** El `.bat` automáticamente:
   - Descarga los precios de cierre exactos de hoy (Yahoo Finance).
   - Ejecuta las matemáticas de las estrategias (Cruces SMA, RSI, etc).
   - Evalúa tu portafolio Virtual de $100,000 (Paper Trading).
   - Guarda los resultados en la carpeta `dashboard/data/`.
3. **El Dashboard:** Se abrirá la página web automáticamente en tu navegador.
   - Revisa el **Trade Log (Bitácora verde)** para ver si debes ajustar tus posiciones en tu bróker.
   - Si no hay alertas nuevas, verás que la estrategia "Mantiene Posiciones".

---

## 🌐 Subir a GitHub y Netlify (Ver en el teléfono / nube)

### Paso 1 — Subir a GitHub

```bash
# 1. En tu carpeta "Paper trading", abre una terminal (PowerShell o CMD)
cd "C:\Users\Alumno\Desktop\SMF\Paper trading"

# 2. Inicia el repositorio Git
git init
git add .
git commit -m "Initial commit: V428 & V503 Paper Trading Dashboard"

# 3. Crea un repositorio en github.com (privado recomendado) y luego:
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git branch -M main
git push -u origin main
```

### Paso 2 — Conectar a Netlify

1. Ve a [netlify.com](https://netlify.com) → **Add new site** → **Import from GitHub**
2. Selecciona tu repositorio
3. Netlify detectará el `netlify.toml` automáticamente:
   - **Publish directory:** `dashboard`
   - **Build command:** *(vacío — es un sitio estático)*
4. Haz clic en **Deploy site** — en ~30 segundos tu dashboard estará en la nube ✅

### Paso 3 — Tu Rutina Diaria (Actualizada)

```bash
# 1. Ejecuta el .bat para actualizar los datos
Iniciar_Dashboard.bat

# 2. Haz push a GitHub — Netlify actualiza automáticamente en <60 segundos
git add dashboard/data/
git commit -m "Update data $(date +%Y-%m-%d)"
git push
```

> **Nota:** Netlify sirve los archivos estáticos del commit más reciente. Los datos JSON que genera `update.py` localmente necesitan subirse a GitHub para que el dashboard en la nube los muestre.

---

## 📖 Entendiendo los Tipos de Alertas (Trade Log)

El sistema es robusto y cuenta con dos mecanismos de seguridad distintos que te pueden mandar a refugiarte en Efectivo (SHV):

* 🔄 **COMPRAR / VENDER (Salida Táctica):** 
  La estrategia de Seguimiento de Tendencia (SMA) indica que la tendencia alcista se ha agotado. El sistema ajusta tu portafolio y te refugia en Efectivo pacíficamente.
* 🛑 **VENDER TODO (Salida de Emergencia / Stop Loss):** 
  Ocurrió un Crash de mercado repentino (caída superior al 16% desde tu pico histórico). El sistema actúa más rápido que las medias móviles y corta pérdidas de raíz mandándote 100% a SHV.


> **Nota sobre las Fechas:** 
> - Las alertas del **Paper Trading (Verdes)** tienen la *fecha y hora exacta* en que ejecutaste el script.
> - Las alertas del **Backtest Histórico (Azules/Grises)** solo tienen *el día* (ej. 2026-06-16) porque la simulación histórica asume precios de cierre diarios. No es spam, es el algoritmo navegando volatilidad día por día.

---

## 📊 Estrategias

### V428 — Trend-Following (1x leverage)
- **CAGR Histórico:** ~55.6%  |  **Sharpe:** ~1.20  |  **MaxDD:** -35.4%
- **Activos:** TQQQ (3x Nasdaq) + ETH
- **Lógica:** SMA 15/50 crossover + Filtro de Régimen de 200 días + RSI(2) Mean Reversion (MR).

### V503 — Full System (hasta 2x leverage)
- **CAGR Histórico:** ~107.0%  |  **Sharpe:** ~1.15  |  **MaxDD:** -61.5%  
- **Activos:** TQQQ + ETH + BTC + SQQQ (bear market) + GLD + SHV
- **Lógica:** Estrategia V428 completa + Operativa agresiva de mercado bajista (SQQQ) + Apalancamiento por volatilidad objetivo (Target Volatility).

---

## 🛠️ Herramientas para Desarrolladores

Si necesitas reiniciar todo desde cero:

* **Para borrar tu historial Paper:** Elimina el archivo `dashboard/data/portfolio.json`. Al correr el script de nuevo, tu capital iniciará en $100,000 limpios.
* **Para re-correr toda la historia:** 
  ```bash
  python backtest/backtest.py
  ```
  Luego haz `git add dashboard/data/ && git commit -m "Rerun backtest" && git push`

---

## ⚠️ Disclaimer
Esta herramienta es una simulación de Paper Trading con fines de investigación y análisis cuantitativo.
El rendimiento pasado no garantiza resultados futuros. Esto no es consejo financiero.
