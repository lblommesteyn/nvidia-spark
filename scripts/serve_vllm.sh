#!/usr/bin/env bash
# Serve the Toronto forecaster (Nemotron-Nano-8B base + LoRA adapter) on the
# DGX Spark GPU using vLLM via the spark-vllm-docker launcher.
#
# This is a GPU-accelerated, OpenAI-compatible drop-in replacement for
# scripts/serve_forecast.py: same /v1 shape, same port (8001), same model
# name ("toronto-forecaster"), so the app and scripts/eval_forecast.py work
# unchanged (NEMOTRON_BASE_URL=http://localhost:8001/v1).
#
# Requirements:
#   - spark-vllm-docker cloned (default: ~/spark-vllm-docker) and image built
#     once with:  cd ~/spark-vllm-docker && ./build-and-copy.sh
#   - Docker usable by the current user (member of the `docker` group) OR run
#     this script under `sg docker -c ...` / sudo.
#
# Usage:
#   scripts/serve_vllm.sh            # foreground (Ctrl-C to stop)
#   scripts/serve_vllm.sh -d         # daemon/background mode
set -euo pipefail

# --- paths -------------------------------------------------------------------
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPARK_REPO="${SPARK_REPO:-$HOME/spark-vllm-docker}"
ADAPTER_DIR="${ADAPTER_DIR:-$PROJECT_DIR/out/toronto-forecaster-lora}"
IMAGE_TAG="${IMAGE_TAG:-vllm-node}"

# --- model / serving config --------------------------------------------------
BASE_MODEL="nvidia/Llama-3.1-Nemotron-Nano-8B-v1"
LORA_NAME="toronto-forecaster"          # clients request this model id
PORT="${PORT:-8001}"
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.7}"
MAX_LORA_RANK=16                        # matches adapter_config.json (r=16)
ADAPTER_MOUNT="/adapters/${LORA_NAME}"

# Pass through -d (daemon) etc. straight to launch-cluster.sh, before `exec`.
LAUNCH_FLAGS=("$@")

if [[ ! -d "$SPARK_REPO" ]]; then
  echo "ERROR: spark-vllm-docker not found at $SPARK_REPO" >&2
  echo "Clone it first: git clone https://github.com/eugr/spark-vllm-docker.git $SPARK_REPO" >&2
  exit 1
fi
if [[ ! -f "$ADAPTER_DIR/adapter_config.json" ]]; then
  echo "ERROR: LoRA adapter not found at $ADAPTER_DIR" >&2
  exit 1
fi

# Mount the local adapter dir into the container so vLLM can load it.
export VLLM_SPARK_EXTRA_DOCKER_ARGS="-v ${ADAPTER_DIR}:${ADAPTER_MOUNT}:ro"

cd "$SPARK_REPO"
exec ./launch-cluster.sh -t "$IMAGE_TAG" --solo "${LAUNCH_FLAGS[@]}" \
  -e HF_HUB_OFFLINE=1 \
  exec vllm serve "$BASE_MODEL" \
    --enable-lora \
    --lora-modules "${LORA_NAME}=${ADAPTER_MOUNT}" \
    --max-lora-rank "$MAX_LORA_RANK" \
    --chat-template "${ADAPTER_MOUNT}/chat_template.jinja" \
    --port "$PORT" --host 0.0.0.0 \
    --gpu-memory-utilization "$GPU_MEM_UTIL" \
    --load-format fastsafetensors
