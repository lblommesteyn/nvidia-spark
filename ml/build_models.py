"""
Build the CityFlow demand models for deployment.

Generates synthetic demand data for each archetype (cafe, restaurant) from the
transparent simulator (cityflow/sim), trains a HistGradientBoostingRegressor on
each, and writes `<archetype>_model.joblib` into the model dir that serve.py
loads from. Idempotent: skips an archetype whose model already exists unless
FORCE_RETRAIN=1.

Run from the project root:
    python ml/build_models.py
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "cityflow_ML_model"
sys.path.insert(0, str(ROOT))

from cityflow.sim.simulator import DemandSimulator   # noqa: E402
from cityflow.model.train import train               # noqa: E402

ARCHETYPES = ("cafe", "restaurant")
N_DAYS = int(os.environ.get("SIM_DAYS", "730"))
FORCE = os.environ.get("FORCE_RETRAIN") == "1"


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for archetype in ARCHETYPES:
        out = ROOT / f"{archetype}_model.joblib"
        if out.exists() and not FORCE:
            print(f"[build_models] {out.name} exists — skipping (FORCE_RETRAIN=1 to rebuild)")
            continue

        print(f"[build_models] generating {N_DAYS}d of synthetic demand for '{archetype}'…")
        df = DemandSimulator(business_type=archetype).generate(n_days=N_DAYS)

        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as tmp:
            csv_path = tmp.name
        df.to_csv(csv_path, index=False)
        try:
            print(f"[build_models] training '{archetype}' model -> {out}")
            train(csv_path, str(out))
        finally:
            os.unlink(csv_path)

    print("[build_models] done.")


if __name__ == "__main__":
    main()
