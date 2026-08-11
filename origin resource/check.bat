@echo off
setlocal
cd /d "%~dp0"
title Chatbot Code Check

if not exist "backend\.venv\Scripts\python.exe" (
    echo [ERROR] Backend dependencies are missing. Run setup.bat first.
    if not defined CHATBOT_NO_PAUSE pause
    exit /b 1
)

echo [1/2] Checking backend Python syntax ...
"backend\.venv\Scripts\python.exe" -m compileall -q -x ".venv|data" backend
if errorlevel 1 goto :failed

echo [2/2] Checking and building the frontend ...
call npm --prefix frontend run build
if errorlevel 1 goto :failed

echo.
echo All checks passed.
if not defined CHATBOT_NO_PAUSE pause
exit /b 0

:failed
echo.
echo [ERROR] Checks failed. Review the first error shown above.
if not defined CHATBOT_NO_PAUSE pause
exit /b 1
