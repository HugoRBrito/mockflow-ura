@echo off
title Parando MockFlow URA
echo Parando o servidor MockFlow URA...
echo.

:: Mata o processo do Node.js
taskkill /F /IM node.exe >nul 2>nul

if %errorlevel% equ 0 (
    echo [OK] Servidor parado com sucesso!
) else (
    echo [INFO] Nenhum servidor Node.js em execucao.
)

echo.
pause