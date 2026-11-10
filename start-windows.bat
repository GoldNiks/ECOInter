@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required. & pause & exit /b 1)
where corepack >nul 2>nul || (echo Corepack was not found. Install Node.js 20+ with Corepack. & pause & exit /b 1)
if not exist .env copy .env.example .env >nul
call corepack pnpm install
if errorlevel 1 exit /b %errorlevel%
call corepack pnpm dev
