@echo off
title ChemBuilder
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install Node 18 or newer, then run this again.
  pause
  exit /b 1
)
node "%~dp0server.js" --open
echo.
echo ChemBuilder has stopped.
pause
