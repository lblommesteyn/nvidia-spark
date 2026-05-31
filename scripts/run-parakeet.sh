#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$("$ROOT/scripts/ensure-python-venv.sh")"
exec "$PY" "$ROOT/ml/parakeet_serve.py"
