"""
CityFlow — ground-truth recovery check.

Trains a simple gradient-boosted model on the synthetic data, then measures
whether it RECOVERED the effects we injected in ground_truth.py. This is the
anti-circularity proof: because the simulator mixes interactions + noise, the
model can't trivially echo our numbers — recovering them is real signal.

Output is the demo table:
    injected rain effect  -30%   |  model-implied  -28%   ✓

    pip install numpy pandas scikit-learn
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from . import ground_truth as gt
from .simulator import DemandSimulator


def _prep(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["weather"] = pd.Categorical(
        df["weather"], categories=list(gt.WEATHER_EFFECT.keys()))
    df = pd.get_dummies(df, columns=["weather"], prefix="wx")
    df["event_nearby"] = df["event_nearby"].astype(int)
    df["transit_disruption"] = df["transit_disruption"].astype(int)
    df["is_weekend"] = df["is_weekend"].astype(int)
    return df


def _measure_effect(model, X_template: pd.DataFrame, feature_cols: list,
                    toggle: dict) -> float:
    """Counterfactual: take a baseline feature set, predict, then flip the
    factor and predict again. The ratio is the model-IMPLIED multiplicative
    effect — directly comparable to the injected ground-truth multiplier."""
    base = X_template.copy()
    alt = X_template.copy()
    for col, val in toggle.items():
        alt[col] = val
    p_base = model.predict(base[feature_cols]).mean()
    p_alt = model.predict(alt[feature_cols]).mean()
    return p_alt / p_base if p_base > 0 else float("nan")


def run(business_type: str = "cafe", n_days: int = 240):
    sim = DemandSimulator(business_type=business_type, seed=7)
    df = _prep(sim.generate(n_days=n_days))

    feature_cols = [c for c in df.columns
                    if c not in ("date", "customers", "dow")]
    X, y = df[feature_cols], df["customers"]

    model = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.08,
                                          max_depth=6, random_state=0)
    model.fit(X, y)

    # Build a baseline template at a busy, open hour so multipliers are visible.
    open_hours = df[df["customers"] > 0]
    template = open_hours.sample(2000, replace=True, random_state=1).copy()
    # reset to a clean baseline: clear weather, no event, no disruption, weekday
    wx_cols = [c for c in feature_cols if c.startswith("wx_")]
    for c in wx_cols:
        template[c] = (c == "wx_clear")
    template["event_nearby"] = 0
    template["transit_disruption"] = 0
    template["is_weekend"] = 0

    print(f"\n{'='*58}")
    print(f"GROUND-TRUTH RECOVERY  —  {business_type}")
    print(f"{'='*58}")
    print(f"{'factor':<28}{'injected':>12}{'recovered':>14}")
    print("-" * 58)

    checks = [
        ("rain (weekday)", gt.WEATHER_EFFECT["rain"],
         {"wx_clear": False, "wx_rain": True}),
        ("snow (weekday)", gt.WEATHER_EFFECT["snow"],
         {"wx_clear": False, "wx_snow": True}),
        ("event nearby", gt.EVENT_EFFECT_NEARBY,
         {"event_nearby": 1}),
        ("transit disruption", gt.TRANSIT_DISRUPTION_EFFECT,
         {"transit_disruption": 1}),
    ]

    for name, injected, toggle in checks:
        recovered = _measure_effect(model, template, feature_cols, toggle)
        inj_pct = f"{(injected-1)*100:+.0f}%"
        rec_pct = f"{(recovered-1)*100:+.0f}%"
        ok = "OK" if abs(recovered - injected) < 0.10 else "~"
        print(f"{name:<28}{inj_pct:>12}{rec_pct:>14}  {ok}")

    # interaction check: rain on weekend should be WORSE than rain on weekday
    wk = template.copy(); wk["is_weekend"] = 1
    rain_weekday = _measure_effect(model, template, feature_cols,
                                   {"wx_clear": False, "wx_rain": True})
    rain_weekend = _measure_effect(model, wk, feature_cols,
                                   {"wx_clear": False, "wx_rain": True})
    print("-" * 58)
    print("INTERACTION: rain effect weekday vs weekend")
    print(f"  weekday rain: {(rain_weekday-1)*100:+.0f}%   "
          f"weekend rain: {(rain_weekend-1)*100:+.0f}%")
    print(f"  injected: weekends should be worse "
          f"(extra x{gt.RAIN_WEEKEND_EXTRA})")
    print(f"{'='*58}\n")


if __name__ == "__main__":
    import sys
    run(sys.argv[1] if len(sys.argv) > 1 else "cafe")
