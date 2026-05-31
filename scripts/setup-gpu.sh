#!/usr/bin/env bash
# CityFlow — one-shot setup for the DGX Spark / GPU server.
# Run once after cloning. Then use: npm run dev:all
set -e

echo "=== CityFlow GPU Setup ==="

# ── 1. Node deps ───────────────────────────────────────────────────────────────
echo "[1/4] Installing Node dependencies..."
npm install

# ── 2. Python deps ─────────────────────────────────────────────────────────────
echo "[2/4] Installing Python ML dependencies..."
pip install flask scikit-learn pandas numpy joblib --quiet

# ── 3. Train ML models from bundled demand data ────────────────────────────────
echo "[3/4] Training CityFlow demand models..."
python ml/serve.py &
ML_PID=$!
sleep 4

# Train both archetypes
curl -s -X POST http://localhost:8788/train \
     -H "content-type: application/json" \
     -d '{"type":"cafe","days":730}' | python -c "import sys,json; d=json.load(sys.stdin); print('  cafe model:', 'OK' if d.get('ok') else d.get('error'))"

curl -s -X POST http://localhost:8788/train \
     -H "content-type: application/json" \
     -d '{"type":"restaurant","days":730}' | python -c "import sys,json; d=json.load(sys.stdin); print('  restaurant model:', 'OK' if d.get('ok') else d.get('error'))"

kill $ML_PID 2>/dev/null || true

# ── 4. .env check ──────────────────────────────────────────────────────────────
echo "[4/4] Checking .env..."
if [ ! -f .env ]; then
  cat > .env << 'ENV'
# Point at the Nemotron NIM running on this machine (DGX Spark default port).
# Adjust the host/port if the NIM container is on a different address.
NEMOTRON_BASE_URL=http://localhost:8000/v1
NEMOTRON_MODEL=nvidia/nemotron-super-49b-instruct

# Optional — leave blank to run in city-signals-only mode.
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# OPENWEATHER_API_KEY=
# TOMTOM_API_KEY=
ENV
  echo "  Created .env — edit NEMOTRON_BASE_URL if needed."
else
  echo "  .env exists — skipping."
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "  Start everything:  npm run dev:all"
echo "  Frontend:          http://localhost:3100"
echo "  API:               http://localhost:8787"
echo "  ML service:        http://localhost:8788"
echo ""
echo "  If Nemotron NIM is running on this machine, the agent will use it"
echo "  automatically via NEMOTRON_BASE_URL in .env."
