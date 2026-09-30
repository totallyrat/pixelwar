@echo off
title PIXEL WAR server
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22 or newer is required: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies, one moment...
  call npm install --no-fund --no-audit || (pause & exit /b 1)
)
set PW_OPEN=1
call npm start
pause
