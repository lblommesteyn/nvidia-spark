# GX10 "Toronto City Brain" — Nemotron NIM + LoRA Fine-Tune Runbook

This runbook turns an **ASUS GX10** (NVIDIA **GB10** Grace‑Blackwell Superchip,
128 GB unified memory, ~1 petaFLOP FP4) into the on‑device reasoning engine for
Toronto Monitor. Everything the dashboard does — the conversational agent and the
**Demand Forecast** tile — runs locally against a Nemotron NIM, no cloud
round‑trip and no data leaving the box.

Two models, split by job:

| Role | Model | Why |
|---|---|---|
| **Reasoner** (agent + teacher) | `Llama-3.3-Nemotron-Super-49B-v1` | Strong reasoning, fits in 128 GB unified memory; produces high‑quality forecasts and **distillation labels**. |
| **Fast student** (forecast tile) | `Llama-3.1-Nemotron-Nano-8B-v1` | Low latency for the 90‑second polling loop; the **LoRA fine‑tune target**. |

The app is **provider‑agnostic** — point one env var at the NIM and it switches
over with zero code changes (see `server/ai/provider.ts`).

---

## 0. Prerequisites

- ASUS GX10 with NVIDIA driver + Container Toolkit installed.
- Docker (with `--gpus all` support) or Podman.
- An **NGC API key**: <https://org.ngc.nvidia.com/setup/api-key>.
- ~150 GB free disk for model weights/cache.

```bash
export NGC_API_KEY=nvapi-xxxxxxxx
echo "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
mkdir -p ~/.cache/nim
```

---

## 1. Serve a Nemotron NIM (OpenAI‑compatible)

NIMs expose `/v1/chat/completions`, which is exactly what this app speaks.

```bash
docker run -d --name nemotron-super --gpus all \
  --shm-size=16g \
  -e NGC_API_KEY \
  -v ~/.cache/nim:/opt/nim/.cache \
  -p 8000:8000 \
  nvcr.io/nim/nvidia/llama-3.3-nemotron-super-49b-v1:latest
```

Smoke‑test it:

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "nvidia/llama-3.3-nemotron-super-49b-v1",
    "messages": [
      {"role":"system","content":"detailed thinking on"},
      {"role":"user","content":"Say hello to Toronto in one line."}
    ]
  }' | jq -r '.choices[0].message.content'
```

> **Reasoning toggle.** Nemotron uses a system directive `detailed thinking on|off`.
> This app sets it automatically via the `reasoning` flag in `chat()` and strips
> any `<think>…</think>` trace before returning the answer
> (`server/ai/provider.ts`). Forecasts call with `reasoning:false` for speed;
> the teacher pass for dataset generation uses `reasoning:true` for quality.

### Point the app at the NIM

```bash
# .env (gitignored)
NEMOTRON_BASE_URL=http://localhost:8000/v1
NEMOTRON_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1
# NEMOTRON_API_KEY=        # only for hosted endpoints; omit for the local NIM
```

Restart the server and confirm:

```bash
curl -s localhost:8787/api/health        # → {"provider":"nemotron", ...}
curl -s "localhost:8787/api/forecast?lon=-79.3839&lat=43.6535"   # → method:"llm"
```

The provider badge in the dashboard header now reads **agent: nemotron**, and the
Demand Forecast tile footer shows `model-reasoned · nemotron/…`.

---

## 2. Build the fine‑tuning dataset (distillation)

We fine‑tune the **Nano‑8B student** to reproduce the **Super‑49B teacher's**
demand forecasts from live Toronto signals. The generator already wires this up:

- `server/ai/dataset.ts` — builds `{messages|prompt, completion}` rows from a
  context snapshot. When a NIM is active, the teacher (Super‑49B, thinking on)
  supplies the label; otherwise the deterministic heuristic does.
- `scripts/gen-forecast-dataset.ts` — samples representative neighbourhoods.

With the Super‑49B NIM running:

```bash
# One pass over the sample locations, teacher-labelled, OpenAI "messages" JSONL
npm run gen:dataset -- --out data/forecast-train.jsonl --format messages

# Capture time-of-day variation: schedule this hourly (cron) with --repeat
npm run gen:dataset -- --out data/forecast-$(date +%H).jsonl --repeat 1
```

Each line looks like:

```json
{"messages":[
  {"role":"system","content":"You are a Toronto demand-forecasting model..."},
  {"role":"user","content":"...SIGNALS (JSON): {localHour, weather, counts:{events,aviation,...}}..."},
  {"role":"assistant","content":"{\"score\":0.71,\"level\":\"elevated\",\"headline\":\"...\",\"drivers\":[...],\"windows\":[...],\"actions\":[...]}"}
]}
```

Tips for a good dataset:

- Run the generator **across the day and week** (cron) so the student learns
  meal rushes, weekend lift, and weather effects — not one frozen snapshot.
- Aim for **a few hundred to a few thousand** rows. Concatenate the hourly files.
- Hold out ~10% as a validation split (`data/forecast-val.jsonl`).

> Quick preview without writing files: `curl "localhost:8787/api/forecast/dataset?n=3"`
> (add `&jsonl=1` for raw JSONL).

---

## 3. LoRA fine‑tune the Nano‑8B student

Use **NeMo** (or the NIM PEFT/LoRA customization flow). LoRA keeps the base
weights frozen and trains a small adapter — fast and memory‑light on the GB10.

```bash
docker run --rm -it --gpus all \
  -v "$PWD/data":/data \
  -v "$PWD/out":/out \
  nvcr.io/nvidia/nemo:24.07 \
  python -m nemo.collections.llm.peft.lora \
    --model nvidia/llama-3.1-nemotron-nano-8b-v1 \
    --train_ds /data/forecast-train.jsonl \
    --valid_ds /data/forecast-val.jsonl \
    --scheme lora --lora_dim 16 --lora_alpha 32 \
    --lr 1e-4 --global_batch_size 32 --max_steps 400 \
    --save_path /out/toronto-forecaster-lora
```

> Exact entrypoint/flags vary by NeMo release — treat the above as the shape of
> the job (base model, JSONL train/val, LoRA rank/alpha, LR, steps, output dir).
> The dataset JSONL produced in §2 is the contract that matters.

---

## 4. Serve the fine‑tuned student

Mount the LoRA adapter into a Nano‑8B NIM and expose it on a second port:

```bash
docker run -d --name nemotron-nano-toronto --gpus all \
  -e NGC_API_KEY \
  -v "$PWD/out/toronto-forecaster-lora":/opt/loras/toronto \
  -e NIM_PEFT_SOURCE=/opt/loras \
  -v ~/.cache/nim:/opt/nim/.cache \
  -p 8001:8000 \
  nvcr.io/nim/nvidia/llama-3.1-nemotron-nano-8b-v1:latest
```

Repoint the **forecast** workload at the fast, fine‑tuned student (keep the big
model for the agent if you like, on `:8000`):

```bash
NEMOTRON_BASE_URL=http://localhost:8001/v1
NEMOTRON_MODEL=toronto-forecaster      # the served LoRA adapter name
```

---

## 5. Evaluate

Compare student vs. teacher (and vs. the heuristic baseline) on the held‑out
split:

- **Level accuracy** — does the student pick the same `level` bucket?
- **Score MAE** — mean absolute error on the 0–1 `score`.
- **JSON validity** — % of outputs that parse (the app already falls back to the
  heuristic on parse failure, so this only affects quality, never uptime).

A simple loop: read `data/forecast-val.jsonl`, send each `user` message to the
student NIM, parse the JSON, and diff `level`/`score` against the stored
`assistant` label.

---

## Architecture recap

```
                ┌────────────────────────── ASUS GX10 (GB10, 128 GB) ──────────────────────────┐
                │                                                                               │
 live Toronto   │   Super-49B NIM (:8000)  ──teacher labels──►  data/*.jsonl  ──LoRA──►  Nano-8B │
 civic signals ─┼─►  buildContext()  ─►  signalDigest()                          fine-tuned NIM  │
 (events, YYZ,  │        │                                                          (:8001)       │
  weather, TTC, │        └──────────────────────────────────────────────────────────► forecast  │
  311, permits) │                          server/ai/forecast.ts  (chat → JSON, heuristic fallbk) │
                └───────────────────────────────────────────────────────────────────────────────┘
                                   Toronto Monitor dashboard (Preact)  ◄── /api/forecast, /api/agent
```

- No key set → deterministic heuristic + mock agent (fully demoable).
- NIM set → on‑device Nemotron reasoning for both the agent and forecasts.
- Fine‑tuned → a Toronto‑specialized student running the real‑time loop.
