@echo off
setlocal
cd /d "%~dp0"
title Chatbot Setup

echo [1/4] Checking Python ...
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found. Install Python 3.11 or newer and add it to PATH.
    if not defined CHATBOT_NO_PAUSE pause
    exit /b 1
)

echo [2/4] Preparing the backend environment ...
if not exist "backend\.venv\Scripts\python.exe" (
    if exist "backend\.venv" rmdir /s /q "backend\.venv"
    python -m venv "backend\.venv"
    if errorlevel 1 goto :failed
)

"backend\.venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto :failed
"backend\.venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt"
if errorlevel 1 goto :failed

echo [3/4] Checking Node.js ...
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found. Install Node.js 20 LTS or newer.
    if not defined CHATBOT_NO_PAUSE pause
    exit /b 1
)

echo [4/4] Installing frontend dependencies ...
call npm --prefix frontend install
if errorlevel 1 goto :failed

echo.
echo Setup completed. Run start.bat to launch the application.
if not defined CHATBOT_NO_PAUSE pause
exit /b 0

:failed
echo.
echo [ERROR] Setup failed. Review the first error shown above.
if not defined CHATBOT_NO_PAUSE pause
exit /b 1

