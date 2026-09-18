@echo off
cd /d "%~dp0"
echo STEP7 Explorer: http://127.0.0.1:4173
if exist ".tools\runtime\node.exe" (
  ".tools\runtime\node.exe" server.mjs --open
) else (
  node server.mjs --open
)
pause
