#!/bin/sh
# Try Screen Relay on this computer before deploying (default port 8765).
cd "$(dirname "$0")"
exec python3 -m http.server "${1:-8765}"
