@echo off
setlocal
if defined NOVACLAW_BUILD_MEMORY_JOB goto :bounded_build
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0..\..\..\script\bounded-build.ps1" -BuildScript "%~f0"
exit /b %errorlevel%
:bounded_build
cd /d "%~dp0.."
call bun --smol ../../script/bounded-build.ts --verify
if not "%errorlevel%"=="0" exit /b %errorlevel%
call bun --smol scripts/prebuild.ts
if not "%errorlevel%"=="0" exit /b %errorlevel%
if "%NOVACLAW_CHANNEL%"=="prod" goto :standalone
if "%NOVACLAW_CHANNEL%"=="beta" goto :standalone
if "%NOVACLAW_CHANNEL%"=="latest" goto :standalone
goto :sidecar
:standalone
cd /d "%~dp0..\..\app"
call node --expose-gc node_modules/vite/bin/vite.js build
if not "%errorlevel%"=="0" exit /b %errorlevel%
cd /d "%~dp0..\..\novaclaw"
call script/build-server.bat --single --skip-install --reuse-web-ui
if not "%errorlevel%"=="0" exit /b %errorlevel%
:sidecar
cd /d "%~dp0..\..\novaclaw"
call script/build-node.bat
if not "%errorlevel%"=="0" exit /b %errorlevel%
cd /d "%~dp0.."
set "NOVACLAW_ELECTRON_BUILD_STAGE=main"
call node --expose-gc node_modules/electron-vite/bin/electron-vite.js build
if not "%errorlevel%"=="0" exit /b %errorlevel%
set "NOVACLAW_ELECTRON_BUILD_STAGE=preload"
call node --expose-gc node_modules/electron-vite/bin/electron-vite.js build
if not "%errorlevel%"=="0" exit /b %errorlevel%
set "NOVACLAW_ELECTRON_BUILD_STAGE=renderer"
call node --expose-gc node_modules/electron-vite/bin/electron-vite.js build
if not "%errorlevel%"=="0" exit /b %errorlevel%
call bun --smol scripts/sanitize-build-output.ts
exit /b %errorlevel%
