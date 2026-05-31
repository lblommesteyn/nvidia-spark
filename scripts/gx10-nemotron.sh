#!/usr/bin/env bash
# Start / stop / check Nemotron-Nano-8B (+ Toronto LoRA) on the GX10.
#
# Run ON the GX10 (or any machine with the GPU + adapter):
#   scripts/gx10-nemotron.sh start
#   scripts/gx10-nemotron.sh status
#
# From your laptop (SSH port-forward so the app can reach the model):
#   GX10_HOST=10.10.25.20 scripts/gx10-nemotron.sh tunnel
#   # then in .env on the laptop:
#   #   NEMOTRON_BASE_URL=http://localhost:8001/v1
#   #   NEMOTRON_MODEL=toronto-forecaster
#   #   NEMOTRON_API_KEY=<same as FORECAST_API_KEY on GX10>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"
PORT="${PORT:-8001}"
MODEL_NAME="${MODEL_NAME:-toronto-forecaster}"
PID_FILE="/tmp/nemotron-serve.pid"
LOG_FILE="/tmp/nemotron-serve.log"
GX10_HOST="${GX10_HOST:-}"
GX10_USER="${GX10_USER:-$USER}"

auth_header() {
  if [[ -n "${FORECAST_API_KEY:-${NEMOTRON_API_KEY:-}}" ]]; then
    echo "Authorization: Bearer ${FORECAST_API_KEY:-${NEMOTRON_API_KEY}}"
  fi
}

usage() {
  cat <<EOF
Usage: scripts/gx10-nemotron.sh {start|stop|restart|status|tunnel|env}

  start    Launch Nemotron-Nano-8B + Toronto LoRA on port ${PORT}
  stop     Stop the local forecast server
  restart  stop + start
  status   Check port ${PORT} and /v1/models
  tunnel   SSH -L ${PORT}:localhost:${PORT} (set GX10_HOST)
  env      Print .env lines for the Toronto Monitor app

Optional env: FORECAST_API_KEY, NEMOTRON_API_KEY, VENV, PORT, MODEL_NAME, GX10_HOST
EOF
}

wait_ready() {
  local hdr
  hdr="$(auth_header)"
  for _ in $(seq 1 90); do
    if [[ -n "$hdr" ]]; then
      curl -sf -H "$hdr" "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1 && return 0
    else
      curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1 && return 0
    fi
    sleep 2
  done
  return 1
}

cmd_start() {
  cd "$ROOT"
  if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
    echo "Port ${PORT} already in use. Run: scripts/gx10-nemotron.sh status"
    exit 1
  fi
  if [[ -f "$VENV/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$VENV/bin/activate"
  fi
  echo "[gx10] loading Nemotron-Nano-8B + LoRA on :${PORT} (log: ${LOG_FILE}) ..."
  nohup python3 scripts/serve_forecast.py \
    --port "$PORT" \
    --model-name "$MODEL_NAME" \
    >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  if wait_ready; then
    echo "[gx10] ready — model=${MODEL_NAME} pid=$(cat "$PID_FILE")"
    cmd_env
  else
    echo "[gx10] timed out waiting for :${PORT}. Tail log:" >&2
    tail -20 "$LOG_FILE" >&2 || true
    exit 1
  fi
}

cmd_stop() {
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  pkill -f "scripts/serve_forecast.py --port ${PORT}" 2>/dev/null || true
  echo "[gx10] stopped (port ${PORT})"
}

cmd_status() {
  if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
    echo "[gx10] port ${PORT}: listening"
  else
    echo "[gx10] port ${PORT}: not listening"
    exit 1
  fi
  local hdr
  hdr="$(auth_header)"
  if [[ -n "$hdr" ]]; then
    curl -sf -H "$hdr" "http://127.0.0.1:${PORT}/v1/models" | python3 -m json.tool 2>/dev/null || true
  else
    curl -sf "http://127.0.0.1:${PORT}/v1/models" | python3 -m json.tool 2>/dev/null || true
  fi
}

cmd_tunnel() {
  if [[ -z "$GX10_HOST" ]]; then
    echo "Set GX10_HOST (e.g. 10.10.25.20 or gx10-f2c9) and re-run." >&2
    exit 1
  fi
  echo "[gx10] forwarding localhost:${PORT} → ${GX10_USER}@${GX10_HOST}:${PORT}"
  echo "Keep this terminal open. App .env: NEMOTRON_BASE_URL=http://localhost:${PORT}/v1"
  exec ssh -N -L "${PORT}:127.0.0.1:${PORT}" "${GX10_USER}@${GX10_HOST}"
}

cmd_env() {
  cat <<EOF

Add to .env (then restart npm run dev:all — tsx does not reload .env on its own):

NEMOTRON_BASE_URL=http://localhost:${PORT}/v1
NEMOTRON_MODEL=${MODEL_NAME}
NEMOTRON_API_KEY=${FORECAST_API_KEY:-${NEMOTRON_API_KEY:-<set FORECAST_API_KEY on GX10>}}
TOMTOM_API_KEY=<your TomTom key>
EOF
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  tunnel) cmd_tunnel ;;
  env) cmd_env ;;
  *) usage; exit 1 ;;
esac
