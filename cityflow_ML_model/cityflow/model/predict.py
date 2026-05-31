"""
CityFlow — demand predictor (run time).

Loads the trained model and produces forecasts. Two modes:
  - weekly_profile(): the hour-by-hour x day-of-week grid you described, under
    a given set of conditions (e.g. baseline, or "rainy weekend").
  - forecast_next_hours(): given live conditions per upcoming hour, predict the
    customer count for each — this is what feeds the LLM and cuOpt.

The model artifact is the SAME one train.py saved. This module never retrains.

    pip install scikit-learn pandas numpy joblib
"""

from __future__ import annotations

import joblib
import numpy as np
import pandas as pd

from .features import build_features, single_row_features


class DemandPredictor:
    def __init__(self, model_path: str = "demand_model.joblib"):
        bundle = joblib.load(model_path)
        self.model = bundle["model"]
        self.feature_columns = bundle["feature_columns"]

    def predict_one(self, hour: int, dow: int, weather: str = "clear",
                    event_nearby: bool = False,
                    transit_disruption: bool = False) -> float:
        X = single_row_features(hour, dow, weather, event_nearby, transit_disruption)
        return max(0.0, float(self.model.predict(X)[0]))

    def weekly_profile(self, weather: str = "clear", event_nearby: bool = False,
                       transit_disruption: bool = False) -> pd.DataFrame:
        """7x24 grid of predicted customers under fixed conditions.
        Rows = day of week (0=Mon), cols = hour."""
        rows = []
        for dow in range(7):
            for hour in range(24):
                rows.append({
                    "dow": dow, "hour": hour,
                    "weather": weather,
                    "event_nearby": event_nearby,
                    "transit_disruption": transit_disruption,
                })
        df = pd.DataFrame(rows)
        df["predicted"] = self.model.predict(build_features(df)).clip(min=0)
        return df.pivot(index="dow", columns="hour", values="predicted").round(0)

    def forecast_next_hours(self, conditions: list[dict]) -> pd.DataFrame:
        """conditions: list of dicts, each with hour, dow, weather,
        event_nearby, transit_disruption. Returns the same list + predicted
        customers. This is the live path: build the per-hour condition list
        from CityEvents + the clock, get a forecast back."""
        df = pd.DataFrame(conditions)
        df["predicted"] = self.model.predict(build_features(df)).clip(min=0).round(0)
        return df


if __name__ == "__main__":
    import sys
    mp = sys.argv[1] if len(sys.argv) > 1 else "demand_model.joblib"
    p = DemandPredictor(mp)

    print("Baseline weekly profile (clear weather, no event/disruption):")
    prof = p.weekly_profile()
    # show a compact view: total per day, and the peak hour
    for dow, label in enumerate(["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]):
        row = prof.loc[dow]
        peak_hour = int(row.idxmax())
        print(f"  {label}: total {int(row.sum()):>4}  peak {peak_hour:02d}:00 "
              f"({int(row.max())} cust)")

    print("\nScenario contrast for Saturday 19:00 (restaurant dinner):")
    base = p.predict_one(19, 5, "clear", False, False)
    event = p.predict_one(19, 5, "clear", True, False)
    event_disrupt = p.predict_one(19, 5, "clear", True, True)
    rain = p.predict_one(19, 5, "rain", False, False)
    print(f"  baseline:            {base:.0f}")
    print(f"  + nearby event:      {event:.0f}")
    print(f"  + event & disruption:{event_disrupt:.0f}")
    print(f"  rainy, no event:     {rain:.0f}")
