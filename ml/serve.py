"""
CityFlow ML microservice — thin Flask wrapper around pg1012's demand model.

Endpoints:
  GET  /health          -> {"ok": true, "models": [...]}
  POST /predict         -> {business_type, conditions} -> {predictions, model}
  GET  /profile         -> ?type=cafe|restaurant -> 7x24 weekly demand grid
  POST /train           -> {type, csv_path} -> trains + saves model

Run: python ml/serve.py          (from project root)
     PORT=8788 python ml/serve.py
"""

from __future__ import annotations

import os
import sys
import json
import logging
from pathlib import Path

# Ensure the ML module root is importable
ROOT = Path(__file__).resolve().parent.parent / "cityflow_ML_model"
sys.path.insert(0, str(ROOT))

from flask import Flask, request, jsonify, abort
import joblib
import numpy as np
import pandas as pd

from cityflow.model.features import build_features, single_row_features, FEATURE_COLUMNS
from cityflow.model.train import train
from cityflow.sim.ground_truth import (
    CAFE_BASE_HOURLY, RESTAURANT_BASE_HOURLY,
    CAFE_DOW_MULT, RESTAURANT_DOW_MULT,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cityflow-ml")

app = Flask(__name__)

# ── Model registry ────────────────────────────────────────────────────────────
MODEL_DIR = ROOT  # joblib files live next to the zip

SUPPORTED = ["cafe", "restaurant", "bar", "retail", "gym", "salon", "convenience"]

# Map our 7 business types to the two trained archetypes
TYPE_MAP = {
    "cafe":         "cafe",
    "restaurant":   "restaurant",
    "bar":          "restaurant",   # bar peaks like restaurant (evening)
    "retail":       "cafe",         # retail has a daytime rhythm like cafe
    "gym":          "cafe",
    "salon":        "cafe",
    "convenience":  "cafe",
}

# Base hourly demand arrays per archetype (normalized 0-1 by their own max)
def _norm(arr):
    mx = max(arr)
    return [v / mx if mx > 0 else 0.0 for v in arr]

BASE_PROFILES = {
    "cafe":       (_norm(CAFE_BASE_HOURLY),       CAFE_DOW_MULT),
    "restaurant": (_norm(RESTAURANT_BASE_HOURLY), RESTAURANT_DOW_MULT),
}

models: dict[str, object] = {}

def load_models():
    for archetype in ("cafe", "restaurant"):
        path = MODEL_DIR / f"{archetype}_model.joblib"
        if path.exists():
            try:
                bundle = joblib.load(str(path))
                models[archetype] = bundle["model"]
                log.info("Loaded %s model from %s", archetype, path)
            except Exception as e:
                log.warning("Could not load %s model: %s", archetype, e)
        else:
            log.info("No model at %s — will use heuristic profile", path)


def _archetype(business_type: str) -> str:
    return TYPE_MAP.get(business_type.lower(), "cafe")


def _predict_conditions(archetype: str, conditions: list[dict]) -> list[float]:
    """Use ML model if available; fall back to deterministic profile."""
    model = models.get(archetype)
    if model is not None:
        df = pd.DataFrame(conditions)
        # Ensure required columns present
        for col in ("weather", "event_nearby", "transit_disruption"):
            if col not in df.columns:
                df[col] = "clear" if col == "weather" else False
        feats = build_features(df)
        preds = model.predict(feats).clip(min=0).tolist()
        return [round(p, 1) for p in preds]

    # Fallback: deterministic hourly profile scaled to ~50 peak customers
    base_arr, dow_mult = BASE_PROFILES[archetype]
    out = []
    for c in conditions:
        hour = int(c.get("hour", 12))
        dow  = int(c.get("dow", 0))
        val  = base_arr[hour] * dow_mult[dow] * 50
        # simple weather dampening
        wx = str(c.get("weather", "clear")).lower()
        if wx in ("rain", "snow"):
            val *= 0.70
        elif wx == "heat":
            val *= 0.90
        if c.get("event_nearby"):
            val *= 1.40
        if c.get("transit_disruption"):
            val *= 0.85
        out.append(round(max(0.0, val), 1))
    return out


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "models": list(models.keys()),
        "features": FEATURE_COLUMNS,
    })


@app.post("/predict")
def predict():
    """
    Body: {
      "business_type": "cafe" | "restaurant" | ...,
      "conditions": [
        {"hour": 12, "dow": 1, "weather": "clear",
         "event_nearby": false, "transit_disruption": false},
        ...
      ]
    }
    Returns: {"predictions": [customers_per_hour, ...], "archetype": "cafe", "model": "ml"|"heuristic"}
    """
    body = request.get_json(force=True, silent=True) or {}
    btype = str(body.get("business_type", "cafe")).lower()
    conditions = body.get("conditions", [])
    if not isinstance(conditions, list) or not conditions:
        abort(400, "conditions must be a non-empty list")

    archetype = _archetype(btype)
    predictions = _predict_conditions(archetype, conditions)
    used_model = "ml" if archetype in models else "heuristic"

    return jsonify({
        "predictions": predictions,
        "archetype": archetype,
        "model": used_model,
        "feature_count": len(FEATURE_COLUMNS),
    })


@app.get("/profile")
def profile():
    """
    Returns a 7x24 demand grid for a business type under given conditions.
    ?type=cafe&weather=clear&event=false&disruption=false

    Response: {
      "type": "cafe",
      "archetype": "cafe",
      "model": "ml" | "heuristic",
      "grid": [[mon_h0, mon_h1, ...24], [tue_h0, ...], ..., [sun_h0, ...]]  // 7 rows x 24 cols
      "peak_hour": 9,
      "peak_dow": 4,
    }
    """
    btype     = request.args.get("type", "cafe").lower()
    weather   = request.args.get("weather", "clear").lower()
    event     = request.args.get("event", "false").lower() in ("1", "true")
    disruption = request.args.get("disruption", "false").lower() in ("1", "true")

    archetype = _archetype(btype)

    # Build all 7x24 conditions
    conditions = [
        {"hour": h, "dow": d, "weather": weather,
         "event_nearby": event, "transit_disruption": disruption}
        for d in range(7)
        for h in range(24)
    ]
    flat = _predict_conditions(archetype, conditions)

    # Reshape to 7 rows x 24 cols
    grid = []
    for d in range(7):
        row = flat[d * 24: (d + 1) * 24]
        grid.append(row)

    # Find peak
    peak_val = 0.0
    peak_hour, peak_dow = 0, 0
    for d, row in enumerate(grid):
        for h, v in enumerate(row):
            if v > peak_val:
                peak_val, peak_hour, peak_dow = v, h, d

    used_model = "ml" if archetype in models else "heuristic"
    return jsonify({
        "type": btype,
        "archetype": archetype,
        "model": used_model,
        "grid": grid,
        "peak_hour": peak_hour,
        "peak_dow": peak_dow,
    })


@app.post("/train")
def train_model():
    """
    Train (or retrain) a model for a given archetype.
    Body: {"type": "cafe" | "restaurant", "days": 730}  -> uses bundled CSV
    """
    body = request.get_json(force=True, silent=True) or {}
    btype = str(body.get("type", "cafe")).lower()
    archetype = _archetype(btype)
    days = int(body.get("days", 730))

    csv_candidates = [
        MODEL_DIR / f"cityflow_demand_{archetype}_{days}d.csv",
        MODEL_DIR / f"cityflow_demand_{archetype}_730d.csv",
        MODEL_DIR / f"cityflow_demand_{archetype}_365d.csv",
        MODEL_DIR / f"cityflow_demand_{archetype}.csv",
    ]
    csv_path = next((p for p in csv_candidates if p.exists()), None)
    if csv_path is None:
        abort(404, f"No training CSV found for {archetype}")

    model_out = MODEL_DIR / f"{archetype}_model.joblib"
    try:
        train(str(csv_path), str(model_out))
        bundle = joblib.load(str(model_out))
        models[archetype] = bundle["model"]
        return jsonify({"ok": True, "archetype": archetype, "csv": str(csv_path)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


if __name__ == "__main__":
    load_models()
    # Honor PORT (Railway/Render/Heroku inject it) and fall back to ML_PORT/8788.
    port = int(os.environ.get("PORT") or os.environ.get("ML_PORT") or "8788")
    log.info("CityFlow ML service starting on port %d", port)
    app.run(host="0.0.0.0", port=port, debug=False)
