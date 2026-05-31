"""
Parakeet ASR microservice — nvidia/parakeet-tdt-0.6b-v2 via NeMo.

Endpoints:
  GET  /health      -> {"ok": true, "loaded": bool, "model": "..."}
  POST /transcribe  -> multipart field "audio" -> {"text": "..."}

Run: python ml/parakeet_serve.py
     PARAKEET_PORT=8789 python ml/parakeet_serve.py

Requires: pip install "nemo_toolkit[asr]"  (+ ffmpeg for webm/opus from the browser)
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from flask import Flask, abort, jsonify, request

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("parakeet-asr")

app = Flask(__name__)

MODEL_NAME = os.environ.get("PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v2")
_asr_model = None
_load_error: str | None = None


def _ensure_model():
    global _asr_model, _load_error
    if _asr_model is not None:
        return
    if _load_error:
        abort(503, _load_error)
    try:
        import nemo.collections.asr as nemo_asr

        log.info("Loading Parakeet ASR model %s (first request may take a few minutes)…", MODEL_NAME)
        _asr_model = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL_NAME)
        log.info("Parakeet model loaded.")
    except Exception as e:
        _load_error = str(e)
        log.error("Failed to load Parakeet: %s", e)
        abort(503, f"Parakeet load failed: {e}")


def _extract_text(item) -> str:
    """NeMo transcribe() may return str, Hypothesis, or objects with .text."""
    if item is None:
        return ""
    if isinstance(item, str):
        return item.strip()
    text = getattr(item, "text", None)
    if text:
        return str(text).strip()
    hyps = getattr(item, "hypotheses", None)
    if hyps:
        h0 = hyps[0]
        t = getattr(h0, "text", None) or (h0 if isinstance(h0, str) else None)
        if t:
            return str(t).strip()
    # Some versions return a list/tuple of token strings
    if isinstance(item, (list, tuple)) and item and isinstance(item[0], str):
        return " ".join(item).strip()
    raw = str(item).strip()
    # Avoid returning useless object reprs
    if raw.startswith("<") and "object at" in raw:
        return ""
    return raw


def _to_wav16k(src: Path, dst: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found — install ffmpeg to convert browser audio (webm) to wav")
    subprocess.run(
        [ffmpeg, "-y", "-i", str(src), "-ar", "16000", "-ac", "1", str(dst)],
        check=True,
        capture_output=True,
    )


@app.get("/health")
def health():
    eager = os.environ.get("PARAKEET_EAGER", "").lower() in ("1", "true", "yes")
    if eager and _asr_model is None and _load_error is None:
        try:
            _ensure_model()
        except Exception:
            pass
    return jsonify({
        "ok": _load_error is None,
        "loaded": _asr_model is not None,
        "model": MODEL_NAME,
        "error": _load_error,
    })


@app.post("/transcribe")
def transcribe():
    if "audio" not in request.files:
        abort(400, "multipart field 'audio' required")
    upload = request.files["audio"]
    if not upload.filename:
        abort(400, "empty upload")

    _ensure_model()

    suffix = Path(upload.filename).suffix or ".webm"
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / f"input{suffix}"
        wav = Path(tmp) / "audio.wav"
        upload.save(str(raw))
        if suffix.lower() == ".wav":
            if raw != wav:
                shutil.copy(raw, wav)
        else:
            _to_wav16k(raw, wav)

        output = _asr_model.transcribe([str(wav)])
        if not output:
            log.warning("transcribe returned empty output for %s", wav)
            text = ""
        else:
            text = _extract_text(output[0])
        log.info("transcribed %d chars from %s", len(text), upload.filename)

    if not text:
        return jsonify({"text": "", "model": MODEL_NAME, "warning": "empty transcript"}), 200

    return jsonify({"text": text, "model": MODEL_NAME})


if __name__ == "__main__":
    if os.environ.get("PARAKEET_EAGER", "").lower() in ("1", "true", "yes"):
        try:
            _ensure_model()
        except Exception:
            pass
    port = int(os.environ.get("PARAKEET_PORT", "8789"))
    log.info("Parakeet ASR service on port %d (model=%s)", port, MODEL_NAME)
    app.run(host="0.0.0.0", port=port, debug=False)
