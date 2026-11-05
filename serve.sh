#!/bin/sh
# Try Screen Relay on this computer before deploying (default port 8765).
cd "$(dirname "$0")"
exec python3 relay_server.py "${1:-8765}"  # only the TV page and the remote
