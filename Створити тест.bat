@echo off
chcp 65001 >nul
cd /d "%~dp0app"
title Створення тесту в Classtime

where node >nul 2>nul
if errorlevel 1 (
  echo Потрібно один раз встановити програму Node.js.
  echo Відкрийте https://nodejs.org , натисніть LTS, встановіть, потім запустіть цей файл знову.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Перше налаштування, зачекайте 1-2 хвилини...
  call npm install --silent
  echo.
)

if "%~1"=="" (
  node classtime.mjs
) else (
  node classtime.mjs "%~1"
)

echo.
pause
