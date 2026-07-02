#!/usr/bin/env bash
# Serve Nemotron-3-Nano-30B on Linux DGX Spark for cloud deploys (Vercel + Railway).
#
# Run every command ON the DGX Spark. You host the LLM; teammates host Vercel + Railway.
# Recommended public exposure (no ngrok bandwidth limits):
#   1. Generate a shared secret (keygen)
#   2. start Ollama (localhost only)
#   3. proxy — Bearer-auth gateway on :11435
#   4. expose-tunnel — free Cloudflare Tunnel → HTTPS URL
#      OR expose-ip — your public IP + firewall (HTTP + Bearer key)
#
#   scripts/serve-dgx-nemotron-30b.sh check
#   scripts/serve-dgx-nemotron-30b.sh keygen
#   NEMOTRON_API_KEY=<secret> scripts/serve-dgx-nemotron-30b.sh start
#   NEMOTRON_API_KEY=<secret> scripts/serve-dgx-nemotron-30b.sh proxy
#   NEMOTRON_API_KEY=<secret> scripts/serve-dgx-nemotron-30b.sh expose-tunnel
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
PROXY_PORT="${PROXY_PORT:-11435}"
MODEL="${MODEL:-nemotron-3-nano:30b}"
CF_HOSTNAME="${CF_HOSTNAME:-}"   # optional stable hostname for named Cloudflare tunnel

OLLAMA_PID_FILE="/tmp/dgx-nemotron-30b-ollama.pid"
PROXY_PID_FILE="/tmp/dgx-nemotron-30b-proxy.pid"
CF_PID_FILE="/tmp/dgx-nemotron-30b-cloudflared.pid"
NGROK_PID_FILE="/tmp/dgx-nemotron-30b-ngrok.pid"
OLLAMA_LOG="/tmp/dgx-nemotron-30b-ollama.log"
PROXY_LOG="/tmp/dgx-nemotron-30b-proxy.log"
CF_LOG="/tmp/dgx-nemotron-30b-cloudflared.log"
NGROK_LOG="/tmp/dgx-nemotron-30b-ngrok.log"
KEY_FILE="${KEY_FILE:-$HOME/.nemotron-api-key}"
NGROK_DOMAIN="${NGROK_DOMAIN:-}"

PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"

usage() {
  cat <<EOF
Usage: scripts/serve-dgx-nemotron-30b.sh <command>

  check          Linux / GPU prerequisites
  keygen         Create ~/.nemotron-api-key (share with Railway only)
  start          Ollama on 127.0.0.1:${OLLAMA_PORT} + pull ${MODEL}
  proxy          Bearer-auth proxy on 0.0.0.0:${PROXY_PORT} → Ollama
  expose-tunnel  Cloudflare Tunnel → HTTPS (free, recommended)
  expose-ip      Print public-IP + firewall steps (HTTP + Bearer key)
  expose-ngrok   ngrok fallback (bandwidth limits on free tier)
  stop           Stop tunnel/proxy/Ollama started by this script
  restart        stop + start (+ proxy if NEMOTRON_API_KEY set)
  status         Health of Ollama, proxy, tunnel
  smoke          Test via proxy (needs NEMOTRON_API_KEY)
  env            Railway vars for teammates

Env: NEMOTRON_API_KEY, PROXY_PORT, OLLAMA_PORT, MODEL, CF_HOSTNAME, NGROK_DOMAIN
Docs: docs/DGX-SPARK-SERVE-NEMOTRON-30B.md
EOF
}

require_linux() {
  case "$(uname -s)" in
    Linux) ;;
    *) echo "ERROR: run on the DGX Spark (Linux), not $(uname -s)." >&2; exit 1 ;;
  esac
}

load_api_key() {
  if [[ -n "${NEMOTRON_API_KEY:-}" ]]; then
    return 0
  fi
  if [[ -n "${FORECAST_API_KEY:-}" ]]; then
    NEMOTRON_API_KEY="$FORECAST_API_KEY"
    return 0
  fi
  if [[ -f "$KEY_FILE" ]]; then
    NEMOTRON_API_KEY="$(tr -d '[:space:]' <"$KEY_FILE")"
    export NEMOTRON_API_KEY
    return 0
  fi
  echo "ERROR: set NEMOTRON_API_KEY or run: scripts/serve-dgx-nemotron-30b.sh keygen" >&2
  exit 1
}

require_ollama() {
  require_linux
  if ! command -v ollama >/dev/null 2>&1; then
    echo "Install Ollama: curl -fsSL https://ollama.com/install.sh | sh" >&2
    exit 1
  fi
}

ollama_up() {
  curl -sf "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1
}

proxy_up() {
  curl -sf "http://127.0.0.1:${PROXY_PORT}/v1/models" \
    -H "Authorization: Bearer ${NEMOTRON_API_KEY}" >/dev/null 2>&1
}

model_present() {
  ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$MODEL"
}

cmd_keygen() {
  require_linux
  if [[ -f "$KEY_FILE" ]]; then
    echo "[dgx] key already exists: $KEY_FILE"
    echo "[dgx] to rotate: rm $KEY_FILE && scripts/serve-dgx-nemotron-30b.sh keygen"
    exit 0
  fi
  umask 077
  openssl rand -hex 32 >"$KEY_FILE"
  echo "[dgx] wrote shared secret to $KEY_FILE"
  echo "[dgx] export before other commands:"
  echo "       export NEMOTRON_API_KEY=\$(cat $KEY_FILE)"
  echo "[dgx] give the same value to teammates as Railway NEMOTRON_API_KEY"
}

cmd_check() {
  require_linux
  echo "[dgx] uname: $(uname -a)"
  command -v nvidia-smi >/dev/null 2>&1 \
    && nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
  for bin in curl python3 openssl; do
    command -v "$bin" >/dev/null 2>&1 && echo "[dgx] $bin: ok" \
      || { echo "[dgx] ERROR: missing $bin" >&2; exit 1; }
  done
  command -v ollama >/dev/null 2>&1 \
    && echo "[dgx] ollama: ok" \
    || echo "[dgx] ollama: install with curl -fsSL https://ollama.com/install.sh | sh"
  command -v cloudflared >/dev/null 2>&1 \
    && echo "[dgx] cloudflared: ok (recommended expose)" \
    || echo "[dgx] cloudflared: optional — see expose-tunnel install hint"
  [[ -f "$KEY_FILE" ]] && echo "[dgx] api key file: $KEY_FILE" || echo "[dgx] api key: run keygen"
}

cmd_start() {
  require_ollama
  if ollama_up; then
    echo "[dgx] Ollama already on 127.0.0.1:${OLLAMA_PORT}"
  else
    echo "[dgx] starting Ollama (localhost only, log: ${OLLAMA_LOG})"
    nohup env OLLAMA_HOST="127.0.0.1:${OLLAMA_PORT}" ollama serve >"$OLLAMA_LOG" 2>&1 &
    echo $! >"$OLLAMA_PID_FILE"
    for _ in $(seq 1 45); do ollama_up && break; sleep 1; done
    ollama_up || { tail -20 "$OLLAMA_LOG" >&2; exit 1; }
  fi
  if ! model_present; then
    echo "[dgx] pulling ${MODEL} (~24 GB, one-time) ..."
    ollama pull "$MODEL"
  fi
  echo "[dgx] Ollama ready — ${MODEL} at http://127.0.0.1:${OLLAMA_PORT}"
  echo "[dgx] next: NEMOTRON_API_KEY=\$(cat $KEY_FILE) scripts/serve-dgx-nemotron-30b.sh proxy"
}

cmd_proxy() {
  load_api_key
  cmd_start >/dev/null
  if proxy_up; then
    echo "[dgx] auth proxy already on :${PROXY_PORT}"
    return 0
  fi
  chmod +x "$ROOT/scripts/ollama_auth_proxy.py"
  echo "[dgx] starting auth proxy 0.0.0.0:${PROXY_PORT} → 127.0.0.1:${OLLAMA_PORT}"
  nohup env \
    NEMOTRON_API_KEY="$NEMOTRON_API_KEY" \
    OLLAMA_UPSTREAM="http://127.0.0.1:${OLLAMA_PORT}" \
    PROXY_PORT="$PROXY_PORT" \
    python3 "$ROOT/scripts/ollama_auth_proxy.py" >"$PROXY_LOG" 2>&1 &
  echo $! >"$PROXY_PID_FILE"
  for _ in $(seq 1 20); do proxy_up && break; sleep 1; done
  proxy_up || { tail -20 "$PROXY_LOG" >&2; exit 1; }
  echo "[dgx] proxy ready — Bearer auth required on :${PROXY_PORT}"
}

cf_public_url() {
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | tail -1 || true
}

require_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then return 0; fi
  cat >&2 <<'EOF'
cloudflared not found. On DGX Spark (Linux aarch64):

  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb \
    -o /tmp/cloudflared.deb
  sudo dpkg -i /tmp/cloudflared.deb

No account needed for quick tunnels (free, no ngrok-style bandwidth cap).
EOF
  exit 1
}

cmd_expose_tunnel() {
  load_api_key
  cmd_proxy >/dev/null
  require_cloudflared

  if [[ -f "$CF_PID_FILE" ]] && kill -0 "$(cat "$CF_PID_FILE")" 2>/dev/null; then
    echo "[dgx] cloudflared already running"
  else
    echo "[dgx] starting Cloudflare quick tunnel → localhost:${PROXY_PORT} (log: ${CF_LOG})"
    nohup cloudflared tunnel --url "http://127.0.0.1:${PROXY_PORT}" >"$CF_LOG" 2>&1 &
    echo $! >"$CF_PID_FILE"
    sleep 4
  fi

  local url=""
  for _ in $(seq 1 20); do
    url="$(cf_public_url)"
    [[ -n "$url" ]] && break
    sleep 1
  done
  if [[ -z "$url" ]]; then
    echo "[dgx] tunnel starting — check URL in: tail -f $CF_LOG" >&2
    exit 1
  fi
  PUBLIC_BASE_URL="$url"
  echo "[dgx] public HTTPS endpoint: ${url}/v1  (Bearer auth required)"
  echo "[dgx] keep tmux/screen session alive (Ollama + proxy + cloudflared)."
  cmd_env
}

cmd_expose_ip() {
  load_api_key
  cmd_proxy >/dev/null
  local ip=""
  ip="$(curl -4 -sf ifconfig.me 2>/dev/null || curl -4 -sf icanhazip.com 2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    echo "[dgx] could not detect public IPv4 — set PUBLIC_BASE_URL manually" >&2
    ip="<YOUR_PUBLIC_IP>"
  fi
  PUBLIC_BASE_URL="http://${ip}:${PROXY_PORT}"
  cat <<EOF
[dgx] Direct public IP exposure (no tunnel, no ngrok limits)

1. On your router/firewall, forward TCP ${PROXY_PORT} → this DGX Spark.
2. Allow the port (if ufw is enabled):
     sudo ufw allow ${PROXY_PORT}/tcp
3. Proxy is already listening on 0.0.0.0:${PROXY_PORT} with Bearer auth.

Public endpoint: ${PUBLIC_BASE_URL}/v1
Auth header:     Authorization: Bearer <NEMOTRON_API_KEY>

WARN: HTTP is not encrypted — prefer expose-tunnel (HTTPS) when possible.
EOF
  cmd_env
}

cmd_expose_ngrok() {
  load_api_key
  cmd_proxy >/dev/null
  if ! command -v ngrok >/dev/null 2>&1; then
    echo "ngrok not installed — use expose-tunnel instead (free, no bandwidth cap)." >&2
    exit 1
  fi
  [[ -n "$NGROK_DOMAIN" ]] || { echo "Set NGROK_DOMAIN=your-name.ngrok-free.dev" >&2; exit 1; }
  nohup ngrok http "${PROXY_PORT}" --domain="${NGROK_DOMAIN}" >"$NGROK_LOG" 2>&1 &
  echo $! >"$NGROK_PID_FILE"
  sleep 2
  PUBLIC_BASE_URL="https://${NGROK_DOMAIN}"
  echo "[dgx] ngrok: ${PUBLIC_BASE_URL}/v1"
  cmd_env
}

cmd_stop() {
  for f in "$CF_PID_FILE" "$NGROK_PID_FILE" "$PROXY_PID_FILE" "$OLLAMA_PID_FILE"; do
    [[ -f "$f" ]] && kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  echo "[dgx] stopped tunnel/proxy/Ollama started by this script"
}

cmd_status() {
  ollama_up && echo "[dgx] Ollama 127.0.0.1:${OLLAMA_PORT}: up" \
    || echo "[dgx] Ollama: down"
  if [[ -f "$KEY_FILE" ]] || [[ -n "${NEMOTRON_API_KEY:-}" ]]; then
    load_api_key 2>/dev/null && proxy_up && echo "[dgx] auth proxy :${PROXY_PORT}: up" \
      || echo "[dgx] auth proxy :${PROXY_PORT}: down"
  fi
  local url
  url="$(cf_public_url)"
  [[ -n "$url" ]] && echo "[dgx] cloudflare: ${url}/v1"
}

cmd_smoke() {
  load_api_key
  cmd_proxy >/dev/null
  echo "[dgx] POST http://127.0.0.1:${PROXY_PORT}/v1/chat/completions (with Bearer)"
  curl -sf "http://127.0.0.1:${PROXY_PORT}/v1/chat/completions" \
    -H "Authorization: Bearer ${NEMOTRON_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(python3 - <<PY
import json
print(json.dumps({
  "model": "$MODEL",
  "messages": [{"role": "user", "content": "Reply with one word: ready."}],
  "max_tokens": 16, "temperature": 0,
}))
PY
)" | python3 -m json.tool
}

cmd_env() {
  load_api_key 2>/dev/null || true
  local base="${PUBLIC_BASE_URL:-https://YOUR-TUNNEL-OR-IP:${PROXY_PORT}}"
  cat <<EOF

── Railway cityflow-api variables (NOT on Vercel) ──────────────────────────

NEMOTRON_BASE_URL=${base}/v1
NEMOTRON_MODEL=${MODEL}
NEMOTRON_API_KEY=${NEMOTRON_API_KEY:-<same secret as on DGX — cat ${KEY_FILE}>}

# ML + CORS still required — see docs/DEPLOY.md
# ML_URL=https://cityflow-ml-production.up.railway.app
# CORS_ORIGIN=https://your-app.vercel.app

Verify:
  curl -s https://YOUR-API.up.railway.app/api/health
  # → {"provider":"nemotron", ...}

Remote smoke test (replace URL + key):
  curl -s ${base}/v1/chat/completions \\
    -H "Authorization: Bearer \${NEMOTRON_API_KEY}" \\
    -H "Content-Type: application/json" \\
    -d '{"model":"${MODEL}","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'
EOF
}

case "${1:-}" in
  check) cmd_check ;;
  keygen) cmd_keygen ;;
  start) cmd_start ;;
  proxy) cmd_proxy ;;
  expose-tunnel|expose) cmd_expose_tunnel ;;
  expose-ip) cmd_expose_ip ;;
  expose-ngrok) cmd_expose_ngrok ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start; [[ -n "${NEMOTRON_API_KEY:-}" || -f "$KEY_FILE" ]] && cmd_proxy || true ;;
  status) cmd_status ;;
  smoke) cmd_smoke ;;
  env) cmd_env ;;
  *) usage; exit 1 ;;
esac
