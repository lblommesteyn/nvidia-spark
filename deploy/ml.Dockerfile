# CityFlow ML (Flask demand model) — Railway service.
# Trains the gradient-boosting models at build time so the service starts
# model-backed (falls back to the deterministic profile if a model is missing).
FROM python:3.11-slim

WORKDIR /app

COPY ml/requirements.txt ml/requirements.txt
RUN pip install --no-cache-dir -r ml/requirements.txt

COPY cityflow_ML_model ./cityflow_ML_model
COPY ml ./ml

# Generate synthetic data + train cafe/restaurant models into cityflow_ML_model/.
RUN python ml/build_models.py

ENV PORT=8788
EXPOSE 8788

# serve.py honors $PORT (Railway injects it).
CMD ["python", "ml/serve.py"]
