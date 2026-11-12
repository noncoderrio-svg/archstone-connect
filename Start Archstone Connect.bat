@echo off
title Archstone Connect
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

echo Starting Archstone Connect...
echo Keep this window open while you use the app. Close it to stop.
echo.
start "" http://localhost:4100
"%NODE%" --disable-warning=ExperimentalWarning --import tsx server/index.ts
pause
