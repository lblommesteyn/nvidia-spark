# CityFlow — demand model (scikit-learn, CPU, trains in seconds)

The numerical brain. Predicts hourly customer demand from structured features.
Separate from the NeMo LLM (which is the reasoning/analyst layer).

## Files
- `features.py`  — THE feature schema. Shared by train + run time so the model
                   never sees a different shape than it trained on. Edit features here only.
- `train.py`     — fits HistGradientBoostingRegressor, evaluates, saves to .joblib
- `predict.py`   — loads the saved model; weekly profile + live forecast

## Run
    pip install scikit-learn pandas numpy joblib
    python -m cityflow.model.train synthetic_demand_restaurant_730d.csv restaurant_model.joblib
    python -m cityflow.model.predict restaurant_model.joblib

## Why this stack
- Gradient boosting beats a neural net on tabular regression: faster, less data,
  interpretable, validatable. Trains on CPU in seconds -> zero GPU contention with NeMo.
- The SAME .joblib artifact is used at train and run time (train/serve consistency).

## How it connects
- TRAIN: calibrated+synthetic history -> features.py -> train.py -> model.joblib
- RUN:   live CityEvents -> features.py -> predict.py -> hourly forecast
         -> feeds the LLM (explanation) and cuOpt (staffing/inventory optimization)

## The demo moment
predict.py's scenario contrast shows the learned INTERACTION: a nearby event
lifts demand, but a co-occurring transit disruption cancels it (customers can't
reach you). That business-specific, condition-specific insight is the value story.
