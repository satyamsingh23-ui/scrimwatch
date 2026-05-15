@echo off
title ScrimWatch Launcher
color 0A

cd /d "%~dp0"

echo.
echo ==========================================
echo        ScrimWatch v2 - Starting
echo ==========================================
echo.

REM ===== Activate Python venv =====
call venv\Scripts\activate

REM ===== Create folders =====
if not exist "data" mkdir data
if not exist "logs" mkdir logs

REM ===== Python dependencies =====
echo [1/3] Checking Python dependencies...
pip install -r requirements.txt -q
echo Python dependencies OK.
echo.

REM ===== Backend =====
echo [2/3] Starting Backend + Bot...
start cmd /k "call venv\Scripts\activate && python run.py"

timeout /t 5 >nul

REM ===== Frontend =====
echo [3/3] Starting Frontend...

cd frontend

if not exist "node_modules" (
    npm install
)

start cmd /k "npm run dev"

cd ..

timeout /t 8 >nul

echo.
echo ==========================================
echo Dashboard : http://localhost:3000
echo API       : http://localhost:8000
echo ==========================================
echo.

start http://localhost:3000

pause