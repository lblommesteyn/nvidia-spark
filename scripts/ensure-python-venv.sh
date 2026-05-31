#!/usr/bin/env bash
# Use the repo's single Python env at .venv/ (same as gx10-nemotron.sh).
# Creates .venv only if missing; never makes a second env or renames it.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/.venv"
PY="$VENV/bin/python"

if [[ ! -x "$PY" ]]; then
  echo "[.venv] Creating project virtualenv at $VENV …" >&2
  python3 -m venv "$VENV"
  "$PY" -m pip install --upgrade pip --quiet
else
  echo "[.venv] Using existing $VENV" >&2
fi

if ! "$PY" -c "import flask" 2>/dev/null; then
  echo "[.venv] Installing ml/requirements.txt …" >&2
  "$PY" -m pip install -r "$ROOT/ml/requirements.txt" --quiet
fi

# stdout must be only the python path (run-ml.sh / run-parakeet.sh capture this)
echo "$PY"
