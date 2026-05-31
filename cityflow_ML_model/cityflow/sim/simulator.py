"""
CityFlow — demand simulator engine (Monte Carlo).

Generates a synthetic hourly demand history for ONE business at one location.
Pure NumPy, runs in seconds on a laptop — this is the data-generation sim, NOT
the inference-time optimization sim (that one runs on the Spark with cuOpt).

Pipeline per (day, hour):
    base[hour] * dow_mult[day]              # rhythm
        * weather_effect                    # single factors
        * event_effect
        * transit_effect
        * interaction_adjustments           # the joint-condition terms
        * noise                             # stochastic
    -> customers (rounded, >= 0)

Each row also records the exogenous conditions that produced it, so the file is
a ready-made training set: features (conditions) -> label (customers).

    pip install numpy pandas
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import ground_truth as gt


class DemandSimulator:
    def __init__(self, business_type: str = "cafe", seed: int | None = 42):
        if business_type not in ("cafe", "restaurant"):
            raise ValueError("business_type must be 'cafe' or 'restaurant'")
        self.business_type = business_type
        self.rng = np.random.default_rng(seed)

        if business_type == "cafe":
            self.base = np.array(gt.CAFE_BASE_HOURLY, dtype=float)
            self.dow_mult = np.array(gt.CAFE_DOW_MULT, dtype=float)
        else:
            self.base = np.array(gt.RESTAURANT_BASE_HOURLY, dtype=float)
            self.dow_mult = np.array(gt.RESTAURANT_DOW_MULT, dtype=float)

    # --- sampling exogenous conditions for one day --------------------------
    def _sample_day_conditions(self) -> dict:
        r = self.rng.random()
        if r < gt.P_SNOW:
            weather = "snow"
        elif r < gt.P_SNOW + gt.P_RAIN:
            weather = "rain"
        elif r < gt.P_SNOW + gt.P_RAIN + gt.P_HEAT:
            weather = "heat"
        else:
            weather = self.rng.choice(["clear", "cloudy"], p=[0.7, 0.3])

        return {
            "weather": weather,
            "event_nearby": self.rng.random() < gt.P_EVENT_NEARBY,
            "transit_disruption": self.rng.random() < gt.P_TRANSIT_DISRUPTION,
        }

    # --- the core effect computation for a single hour ----------------------
    def _hour_multiplier(self, hour: int, dow: int, cond: dict) -> float:
        is_weekend = dow >= 5

        # weather
        w = gt.WEATHER_EFFECT[cond["weather"]]
        # interaction: rain hurts more on weekends
        if cond["weather"] == "rain" and is_weekend:
            w *= gt.RAIN_WEEKEND_EXTRA

        # event
        e = 1.0
        if cond["event_nearby"]:
            e = gt.EVENT_EFFECT_NEARBY
            # interaction: dinner-hour bonus for restaurants
            if self.business_type == "restaurant" and 18 <= hour <= 21:
                e *= gt.EVENT_DINNER_BONUS
            # interaction: event dampened if you can't get there
            if cond["transit_disruption"]:
                e *= gt.EVENT_WHEN_DISRUPTED

        # transit (independent suppression of walk-in approach)
        t = gt.TRANSIT_DISRUPTION_EFFECT if cond["transit_disruption"] else 1.0

        return w * e * t

    # --- generate the full history ------------------------------------------
    def generate(self, n_days: int = 120, start_date: str = "2026-01-01") -> pd.DataFrame:
        dates = pd.date_range(start=start_date, periods=n_days, freq="D")
        rows = []
        for d in dates:
            dow = d.dayofweek
            cond = self._sample_day_conditions()
            for hour in range(24):
                base = self.base[hour] * self.dow_mult[dow]
                if base <= 0:
                    customers = 0
                else:
                    mult = self._hour_multiplier(hour, dow, cond)
                    noise = self.rng.lognormal(mean=0.0, sigma=gt.NOISE_SIGMA)
                    customers = max(0, int(round(base * mult * noise)))
                rows.append({
                    "date": d.date().isoformat(),
                    "hour": hour,
                    "dow": dow,
                    "is_weekend": dow >= 5,
                    "weather": cond["weather"],
                    "event_nearby": cond["event_nearby"],
                    "transit_disruption": cond["transit_disruption"],
                    "customers": customers,
                })
        return pd.DataFrame(rows)


if __name__ == "__main__":
    import sys
    btype = sys.argv[1] if len(sys.argv) > 1 else "cafe"
    sim = DemandSimulator(business_type=btype)
    df = sim.generate(n_days=120)
    out = f"synthetic_demand_{btype}.csv"
    df.to_csv(out, index=False)
    print(f"Generated {len(df)} rows -> {out}")
    print(f"\nDaily totals (first 7 days):")
    daily = df.groupby('date')['customers'].sum().head(7)
    print(daily.to_string())
    print(f"\nMean customers/day: {df.groupby('date')['customers'].sum().mean():.0f}")
