@echo off
setlocal
if defined NOVACLAW_BUILD_MEMORY_JOB goto :bounded_build
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0..\..\..\script\bounded-build.ps1" -BuildScript "%~f0" -BuildArgument "%*"
exit /b %errorlevel%
:bounded_build
cd /d "%~dp0.."
call bun --smol ../../script/bounded-build.ts --verify
if not "%errorlevel%"=="0" exit /b %errorlevel%
node node_modules/electron-builder/cli.js %1 --config electron-builder.config.ts
exit /b %errorlevel%
