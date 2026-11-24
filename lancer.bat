@echo off
rem Lance QR StudiUM dans le navigateur (necessite Node.js).
cd /d "%~dp0"
if not exist node_modules call npm install
call npm start
