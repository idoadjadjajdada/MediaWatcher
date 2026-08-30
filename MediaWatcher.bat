@echo off
REM MediaWatcher - double-click to open the launcher.
start "" powershell -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File "%~dp0launcher\MediaWatcher.ps1"
