# CityFlow — demand simulator (runs on your MacBook)

Monte Carlo generator of synthetic hourly demand for one business, plus a
ground-truth recovery check that proves a model learns the injected effects.

This is the DATA-GENERATION sim (laptop, seconds). It is NOT the inference-time
optimization sim that runs on the Spark with cuOpt.

## Files
- `ground_truth.py`      — every injected effect (base curves, weather, events,
                           transit, interactions, noise). The "where did your
                           numbers come from" answer. Fully quotable.
- `simulator.py`         — the Monte Carlo engine. Outputs a CSV: conditions -> customers.
- `validate_recovery.py` — trains a model, checks recovered vs injected effects.

## Run
    pip install numpy pandas scikit-learn
    python -m cityflow.sim.simulator cafe          # or: restaurant
    python -m cityflow.sim.validate_recovery cafe  # the demo table

## The framing that scores
- LIVE signals (weather, events, transit) are REAL via the ingestion layer.
- Only the business's historical CUSTOMER COUNTS are synthetic — because no one
  publishes a real restaurant's private hourly sales. A real user supplies this
  from their POS on day one. That is the integration point.
- Recovery check = anti-circularity proof. Interactions + noise mean the model
  can't just echo the injected numbers; recovering them is real signal.
