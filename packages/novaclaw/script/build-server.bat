@echo off
setlocal
if defined NOVACLAW_BUILD_MEMORY_JOB goto :bounded_build
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0..\..\..\script\bounded-build.ps1" -BuildScript "%~f0" -BuildArgument "%*"
exit /b %errorlevel%
:bounded_build
cd /d "%~dp0.."
call bun --smol ../../script/bounded-build.ts --verify
if not "%errorlevel%"=="0" exit /b %errorlevel%
for %%A in (%*) do if "%%~A"=="--reuse-web-ui" goto :prepared_web
for %%A in (%*) do if "%%~A"=="--skip-embed-web-ui" goto :prepared_web
cd /d "%~dp0..\..\app"
call node --expose-gc node_modules/vite/bin/vite.js build
if not "%errorlevel%"=="0" exit /b %errorlevel%
:prepared_web
cd /d "%~dp0.."
set "NOVACLAW_SERVER_BUILD_DIR=%~dp0..\..\..\tmp\server-build-%RANDOM%-%RANDOM%"
call bun --smol script/build.ts --prepare-bundle --reuse-web-ui %*
if not "%errorlevel%"=="0" exit /b %errorlevel%
call node script/bundle-server.mjs "%NOVACLAW_SERVER_BUILD_DIR%\plan.json"
if not "%errorlevel%"=="0" exit /b %errorlevel%
call bun --smol script/build.ts --compile-bundle %*
exit /b %errorlevel%
