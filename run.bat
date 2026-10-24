@echo off
REM RoborDriveSim: opens it in your browser from a small local web server (game controllers are most reliable this
REM way). Needs Python (python.org). Without Python, just double-click index.html: everything but some controllers works.
cd /d "%~dp0"
where python >nul 2>&1 || goto :nopy
start "" http://localhost:8765/index.html
python -m http.server 8765 --bind 127.0.0.1
exit /b
:nopy
echo Python not found: opening index.html directly instead.
start "" "%~dp0index.html"
