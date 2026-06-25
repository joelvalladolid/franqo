@echo off
title SMF Paper Trading Dashboard
color 0A

echo ==================================================
echo   SMF Paper Trading - Actualizando Senales...
echo ==================================================
echo.

set PYTHONIOENCODING=utf-8

REM Ejecutar la actualizacion
python update.py

echo.
echo ==================================================
echo   Iniciando Servidor Local
echo ==================================================

REM Iniciar el servidor local en segundo plano
start /B python -m http.server 8000 -d dashboard > nul 2>&1

REM Esperar 2 segundos
timeout /t 2 /nobreak > nul

start http://localhost:8000

echo.
echo Listo! El dashboard se ha abierto en tu navegador.
echo Puedes cerrar esta ventana negra cuando termines de usarlo.
echo.
pause
