@echo off
setlocal
if defined NOVACLAW_BUILD_MEMORY_JOB goto :bounded_build
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0..\..\..\script\bounded-build.ps1" -BuildScript "%~f0"
exit /b %errorlevel%
:bounded_build
cd /d "%~dp0.."
call bun --smol ../../script/bounded-build.ts --verify
if not "%errorlevel%"=="0" exit /b %errorlevel%
set "NOVACLAW_NODE_BUILD_DIR=%~dp0..\..\..\tmp\node-build-%RANDOM%-%RANDOM%"
call bun --smol script/build-node.ts --prepare
if not "%errorlevel%"=="0" exit /b %errorlevel%
call node script/bundle-server.mjs "%NOVACLAW_NODE_BUILD_DIR%\plan.json"
if not "%errorlevel%"=="0" exit /b %errorlevel%
call bun --smol script/build-node.ts --verify
exit /b %errorlevel%
