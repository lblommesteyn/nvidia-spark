"""
CityFlow — feature builder (the schema-locking piece).

This is the SINGLE definition of what the demand model takes as input. Both
train time (synthetic CSV) and run time (live CityEvents) pass through here, so
the model never sees a different feature shape than it trained on. If you only
read one file in the model package, read this one.

Add a new feature? You add it here once, and both paths get it automatically.

    pip install numpy pandas
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# The weather categories the model knows about. Must match what the simulator
# emits and what the live weather->feature converter will produce. Order is
# fixed so the one-hot columns are stable across train and run.
WEATHER_CATEGORIES = ["clear", "cloudy", "rain", "snow", "heat"]

# The exact, ordered list of feature columns the model consumes. Locking this
# guarantees train/serve consistency. Anything not in this list is ignored.
FEATURE_COLUMNS = (
    ["hour_sin", "hour_cos", "dow", "is_weekend",
     "event_nearby", "transit_disruption"]
    + [f"wx_{c}" for c in WEATHER_CATEGORIES]
)

TARGET_COLUMN = "customers"


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Take a frame with raw columns (hour, dow, weather, event_nearby,
    transit_disruption, [is_weekend]) and return a frame with EXACTLY
    FEATURE_COLUMNS, in order. Works identically for training rows and a
    single live row.
    """
    out = pd.DataFrame(index=df.index)

    # Cyclical encoding of hour: 23:00 and 00:00 are adjacent, which a raw
    # integer 0..23 can't express. sin/cos puts hours on a circle.
    hour = df["hour"].astype(float)
    out["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    out["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)

    out["dow"] = df["dow"].astype(int)
    if "is_weekend" in df.columns:
        out["is_weekend"] = df["is_weekend"].astype(int)
    else:
        out["is_weekend"] = (df["dow"].astype(int) >= 5).astype(int)

    out["event_nearby"] = df["event_nearby"].astype(int)
    out["transit_disruption"] = df["transit_disruption"].astype(int)

    # Stable one-hot for weather: every category always gets a column, even if
    # absent in this batch — otherwise a live row with only "rain" would
    # produce a different column set than training.
    wx = pd.Categorical(df["weather"], categories=WEATHER_CATEGORIES)
    for c in WEATHER_CATEGORIES:
        out[f"wx_{c}"] = (wx == c).astype(int)

    return out[FEATURE_COLUMNS]


def single_row_features(hour: int, dow: int, weather: str,
                        event_nearby: bool, transit_disruption: bool) -> pd.DataFrame:
    """Convenience: build the feature vector for ONE (hour, conditions) point.
    This is what the run-time predictor calls per forecast hour."""
    row = pd.DataFrame([{
        "hour": hour, "dow": dow, "weather": weather,
        "event_nearby": bool(event_nearby),
        "transit_disruption": bool(transit_disruption),
    }])
    return build_features(row)
