@echo off
setlocal
cd /d "%~dp0"
title Chatbot Launcher

if not exist "backend\.venv\Scripts\python.exe" (
    echo [ERROR] Backend dependencies are missing. Run setup.bat first.
    if not defined CHATBOT_NO_PAUSE pause
    exit /b 1
)

if not exist "frontend\node_modules" (
    echo [ERROR] Frontend dependencies are missing. Run setup.bat first.
    if not defined CHATBOT_NO_PAUSE pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found. Install Node.js 20 LTS or newer.
    if not defined CHATBOT_NO_PAUSE pause
    exit /b 1
)

echo [1/2] Starting backend at http://127.0.0.1:8010 ...
start "Chatbot Backend" /min /d "%~dp0backend" ".venv\Scripts\python.exe" main.py

echo [2/2] Starting frontend at http://localhost:5180 ...
start "Chatbot Frontend" /min /d "%~dp0frontend" cmd /c "npm run dev"

echo Waiting for the backend ...
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 30;$i++){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8010); $c.Close(); $ok=$true; break } catch { Start-Sleep -Seconds 1 } }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
    echo [WARNING] The backend is still unavailable after 30 seconds.
)

if not defined CHATBOT_NO_OPEN start "" http://localhost:5180
echo.
echo Chatbot started. Open http://localhost:5180 in your browser.
echo Closing this window does not stop the backend or frontend processes.
if not defined CHATBOT_NO_PAUSE pause

