"""
CityFlow — demand model trainer.

Fits a HistGradientBoostingRegressor on the (calibrated+synthetic) demand
history, evaluates it on a held-out split, and saves the model to disk so the
run-time predictor can load the SAME artifact. CPU-only, trains in seconds —
no GPU contention with NeMo.

    pip install scikit-learn pandas numpy joblib

Usage:
    python -m cityflow.model.train synthetic_demand_cafe_730d.csv cafe_model.joblib
"""

from __future__ import annotations

import sys

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score

from .features import build_features, FEATURE_COLUMNS, TARGET_COLUMN


def train(csv_path: str, model_out: str = "demand_model.joblib"):
    df = pd.read_csv(csv_path)
    X = build_features(df)
    y = df[TARGET_COLUMN].astype(float)

    # Time-aware-ish split: we shuffle, but because each row carries its full
    # context this is a fair test of "given these conditions, predict demand".
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.2, random_state=0)

    model = HistGradientBoostingRegressor(
        max_iter=400, learning_rate=0.06, max_depth=6,
        l2_regularization=1.0, random_state=0)
    model.fit(X_tr, y_tr)

    pred = model.predict(X_te)
    mae = mean_absolute_error(y_te, pred)
    r2 = r2_score(y_te, pred)
    # MAE relative to mean demand on open hours, a more honest accuracy read
    open_mean = y_te[y_te > 0].mean()

    print(f"Trained on {len(X_tr)} rows, tested on {len(X_te)}.")
    print(f"  MAE:           {mae:.2f} customers/hour")
    print(f"  R^2:           {r2:.3f}")
    print(f"  MAE vs mean:   {mae/open_mean*100:.1f}% of avg open-hour demand")

    joblib.dump({"model": model, "feature_columns": FEATURE_COLUMNS}, model_out)
    print(f"  saved -> {model_out}")
    return model


if __name__ == "__main__":
    csv = sys.argv[1] if len(sys.argv) > 1 else "synthetic_demand_cafe_730d.csv"
    out = sys.argv[2] if len(sys.argv) > 2 else "demand_model.joblib"
    train(csv, out)
