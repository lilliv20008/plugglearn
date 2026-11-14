@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 插头学堂启动中... http://127.0.0.1:8710
node --no-warnings server.js
pause