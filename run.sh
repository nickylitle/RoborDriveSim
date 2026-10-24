#!/bin/sh
# RoborDriveSim from a small local web server (macOS / Linux). Or just open index.html in Chrome or Edge.
cd "$(dirname "$0")"
( sleep 1; (xdg-open http://localhost:8765/index.html || open http://localhost:8765/index.html) >/dev/null 2>&1 ) &
python3 -m http.server 8765 --bind 127.0.0.1
