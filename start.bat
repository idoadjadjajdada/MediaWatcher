@echo off
REM MediaWatcher - first-run setup, then opens the launcher.
title MediaWatcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install Node 20 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   Installing dependencies, this only happens once...
  echo.
  call npm install || (echo. & echo   npm install failed. & pause & exit /b 1)
)

if not exist ".env" (
  echo.
  echo   No .env file yet - creating one from .env.example.
  echo   Add your TMDB and AllDebrid keys in the launcher, then start the server.
  echo.
  copy /y ".env.example" ".env" >nul
)

call "%~dp0MediaWatcher.bat"
