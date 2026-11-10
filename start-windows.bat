@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title ECOInter - Market Analyzer

echo.
echo  ==========================================
echo       ECOInter - MARKET ANALYZER
echo  ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :node_missing

node -e "const major=Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1)"
if errorlevel 1 goto :node_old

where corepack >nul 2>nul
if errorlevel 1 goto :corepack_missing

echo [1/3] Checking pnpm...
call corepack pnpm --version
if errorlevel 1 goto :pnpm_failed

if not exist ".env" (
  echo [2/3] Creating local .env...
  copy /Y ".env.example" ".env" >nul
  if errorlevel 1 goto :env_failed
) else (
  echo [2/3] Existing .env found.
)

echo.
echo [3/3] Installing dependencies...
echo This can take a few minutes on the first run.
call corepack pnpm install --reporter=append-only
if errorlevel 1 goto :install_failed

echo.
echo Starting ECOInter...
echo Frontend: http://127.0.0.1:5173
echo Backend:  http://127.0.0.1:3000/api/health
echo.
echo Keep this window open while using the app.
echo Press Ctrl+C to stop both processes.
echo.
call corepack pnpm run dev
if errorlevel 1 goto :runtime_failed

echo.
echo ECOInter has stopped.
pause
exit /b 0

:node_missing
echo ERROR: Node.js is not installed or is not in PATH.
echo Install Node.js 20 LTS or newer, then reopen this file.
goto :failed

:node_old
echo ERROR: Node.js 20 or newer is required.
node --version
goto :failed

:corepack_missing
echo ERROR: Corepack was not found. Reinstall Node.js 20+ with Corepack enabled.
goto :failed

:pnpm_failed
echo ERROR: Corepack could not start pnpm. Check your Internet connection and Corepack setup.
goto :failed

:env_failed
echo ERROR: Could not create .env from .env.example.
goto :failed

:install_failed
echo.
echo ERROR: Dependency installation failed.
echo Review the pnpm error above. The window will remain open.
goto :failed

:runtime_failed
echo.
echo ERROR: ECOInter failed to start. Exit code: %errorlevel%
echo Review the error above. The window will remain open.
goto :failed

:failed
echo.
echo Troubleshooting:
echo  1. Open Command Prompt in this folder.
echo  2. Run: node --version
echo  3. Run: corepack pnpm install
echo  4. Run: corepack pnpm run dev
echo.
pause
exit /b 1
