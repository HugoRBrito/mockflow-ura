@echo off
title MockFlow URA - Simulador de API
color 0A

echo ========================================
echo    MockFlow URA - NICE CXone Simulator
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado!
    echo Por favor, instale o Node.js em: https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo [INFO] Instalando dependencias...
    call npm install
    echo.
)

echo [OK] Iniciando servidor...
echo.

:: Abre o navegador depois de 2 segundos
start http://localhost:3000
timeout /t 2 /nobreak >nul

npm start

pause