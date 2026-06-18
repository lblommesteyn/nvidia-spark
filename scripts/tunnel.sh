#!/usr/bin/env bash
#
# Publish the running app to a stable public URL via ngrok.
#
# The frontend (Vite, port 3100) is the only thing that needs to be exposed —
# it proxies /api to the backend on :8787, so the API can stay on localhost.
#
# Prereqs (one-time, on the DGX):
#   - ngrok installed and authed:  ngrok config add-authtoken <token>
#   - the reserved static domain below claimed in your ngrok dashboard
#   - the app already running:      npm run dev:all
#
# Usage:
#   bash scripts/tunnel.sh                 # uses the defaults below (prod :8787)
#   NGROK_DOMAIN=foo.ngrok-free.dev bash scripts/tunnel.sh
#   PORT=3100 bash scripts/tunnel.sh       # for dev mode (npm run dev:all)
#
set -euo pipefail

# Default targets the production single-port server (npm run start, :8787).
# Use PORT=3100 for dev mode (npm run dev:all).
PORT="${PORT:-8787}"
NGROK_DOMAIN="${NGROK_DOMAIN:-armband-ravioli-crayfish.ngrok-free.dev}"

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok not found. Install it from https://ngrok.com/download and run:" >&2
  echo "  ngrok config add-authtoken <your-token>" >&2
  exit 1
fi

# Warn (don't fail) if the web server isn't up yet.
if ! curl -fsS -o /dev/null "http://localhost:${PORT}/" 2>/dev/null; then
  echo "WARN: nothing answering on http://localhost:${PORT}/ — is 'npm run dev:all' running?" >&2
fi

echo "Publishing http://localhost:${PORT}  ->  https://${NGROK_DOMAIN}"
echo "Open:  https://${NGROK_DOMAIN}"
echo "(Ctrl-C to stop the tunnel; the app keeps running.)"
exec ngrok http "${PORT}" --domain="${NGROK_DOMAIN}"
