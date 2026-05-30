#!/usr/bin/env python3
"""Minimal OpenAI-compatible server for the fine-tuned Toronto forecaster.

Loads the Nemotron base + the trained LoRA adapter ONCE and exposes the subset
of the OpenAI API the app and scripts/eval_forecast.py use:

    GET  /v1/models
    POST /v1/chat/completions      (messages, temperature, max_tokens)

This is the no-NGC alternative to the NIM in runbook §4: same /v1 shape, same
port (8001), so `NEMOTRON_BASE_URL=http://localhost:8001/v1` and the eval script
work unchanged. Throughput is modest (single HF model, greedy) but fine for the
forecast polling loop and for evaluation.

Run (training venv active, fastapi+uvicorn installed):
    python3 scripts/serve_forecast.py --port 8001 --model-name toronto-forecaster
"""
import argparse
import os
import time
import uuid

import torch
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer

# If FORECAST_API_KEY is set in the environment, clients must send
# `Authorization: Bearer <key>`; if unset, the endpoint is open (local-only).
API_KEY = os.environ.get("FORECAST_API_KEY")


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    temperature: float = 0.0
    max_tokens: int = 320


def build_app(base, adapter, model_name):
    tok = AutoTokenizer.from_pretrained(adapter or base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    print(f"[serve] loading base {base} ...", flush=True)
    model = AutoModelForCausalLM.from_pretrained(
        base, device_map="auto", dtype=torch.bfloat16, trust_remote_code=True)
    if adapter:
        from peft import PeftModel
        print(f"[serve] attaching adapter {adapter} ...", flush=True)
        model = PeftModel.from_pretrained(model, adapter)
    model.eval()
    print("[serve] ready.", flush=True)

    app = FastAPI()

    def require_key(authorization):
        if API_KEY and authorization != f"Bearer {API_KEY}":
            raise HTTPException(status_code=401, detail="invalid or missing API key")

    @app.get("/v1/models")
    def list_models(authorization: str | None = Header(default=None)):
        require_key(authorization)
        return {"object": "list",
                "data": [{"id": model_name, "object": "model", "owned_by": "local"}]}

    @app.post("/v1/chat/completions")
    def chat(req: ChatRequest, authorization: str | None = Header(default=None)):
        require_key(authorization)
        # The Nemotron/Llama chat template requires non-repeating roles. Callers
        # (e.g. the app prepends a "detailed thinking off" system directive on top
        # of its own system prompt) can produce consecutive same-role messages, so
        # merge adjacent same-role turns before templating.
        msgs: list[dict] = []
        for m in req.messages:
            if msgs and msgs[-1]["role"] == m.role:
                msgs[-1]["content"] += "\n\n" + m.content
            else:
                msgs.append({"role": m.role, "content": m.content})
        enc = tok.apply_chat_template(
            msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)
        enc = {k: v.to(model.device) for k, v in enc.items()}
        prompt_len = enc["input_ids"].shape[1]
        do_sample = req.temperature and req.temperature > 0
        with torch.no_grad():
            out = model.generate(
                **enc, max_new_tokens=req.max_tokens, do_sample=bool(do_sample),
                temperature=req.temperature if do_sample else None,
                pad_token_id=tok.pad_token_id)
        text = tok.decode(out[0][prompt_len:], skip_special_tokens=True).strip()
        completion_tokens = int(out.shape[1] - prompt_len)
        return {
            "id": "chatcmpl-" + uuid.uuid4().hex[:24],
            "object": "chat.completion",
            "created": int(time.time()),
            "model": req.model or model_name,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": int(prompt_len),
                "completion_tokens": completion_tokens,
                "total_tokens": int(prompt_len) + completion_tokens,
            },
        }

    return app


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="nvidia/Llama-3.1-Nemotron-Nano-8B-v1")
    p.add_argument("--adapter", default="out/toronto-forecaster-lora",
                   help='PEFT adapter dir. Pass "" to serve the base alone.')
    p.add_argument("--model-name", default="toronto-forecaster",
                   help="Model id clients request (matches eval_forecast.py --model).")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8001)
    args = p.parse_args()
    app = build_app(args.base, args.adapter, args.model_name)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
