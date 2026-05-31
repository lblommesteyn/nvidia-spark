#!/usr/bin/env bash
# Run Toronto Monitor with Nemotron-3-Nano-30B via local Ollama (OpenAI-compatible /v1).
# Prerequisites: ollama pull nemotron-3-nano:30b && ollama serve
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "Ollama is not running. Start it with: ollama serve"
  exit 1
fi

if ! ollama list 2>/dev/null | grep -q 'nemotron-3-nano:30b'; then
  echo "Pulling nemotron-3-nano:30b (one-time, ~24GB)..."
  ollama pull nemotron-3-nano:30b
fi

export NEMOTRON_BASE_URL="${NEMOTRON_BASE_URL:-http://localhost:11434/v1}"
export NEMOTRON_MODEL="${NEMOTRON_MODEL:-nemotron-3-nano:30b}"
export PORT="${PORT:-8787}"

# Optional: fast Ollama model for street-research synthesis (omit for rule-based briefing only)
# export OLLAMA_WEB_AGENT_HOST=http://localhost:11434
# export OLLAMA_WEB_AGENT_MODEL=llama3.2:3b

echo "Nemotron agent: $NEMOTRON_BASE_URL  model=$NEMOTRON_MODEL"
echo "API : http://localhost:$PORT"
echo "UI  : http://localhost:3100/app  (run 'npm run dev:all' from $ROOT)"

if [[ "${1:-}" == "--api-only" ]]; then
  exec npm run dev:server
fi

exec npm run dev:all
