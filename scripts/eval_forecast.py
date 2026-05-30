#!/usr/bin/env python3
"""Evaluate a forecast model on the held-out split (GX10 runbook §5).

Sends each `user` message from a validation JSONL to an OpenAI-compatible
endpoint (a Nemotron NIM, the LoRA-served student, or any /v1/chat/completions
host), parses the JSON the model returns, and scores it against the stored
`assistant` label:

  - level accuracy  — fraction of exact `level` bucket matches
  - score MAE       — mean absolute error on the 0-1 `score`
  - JSON validity   — fraction of model outputs that parse as the contract
  - confusion       — predicted-vs-true level counts

Pure stdlib (urllib/json) — no GPU, no extra installs. Usage:

  # against the fine-tuned student NIM (runbook §4, port 8001)
  python3 scripts/eval_forecast.py \
      --val data/forecast-loc-val.jsonl \
      --base-url http://localhost:8001/v1 \
      --model toronto-forecaster \
      --n 300

Compare runs by pointing --base-url/--model at the base NIM vs. the LoRA student
vs. the heuristic baseline (server /api/forecast).
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from collections import Counter

LEVELS = ["low", "moderate", "elevated", "surge"]


def call(base_url, model, api_key, system, user, timeout):
    body = json.dumps({
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }).encode()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(base_url.rstrip("/") + "/chat/completions",
                                 data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    return out["choices"][0]["message"]["content"]


def extract_json(text):
    """Best-effort: pull the first {...} block and parse it."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    i, j = text.find("{"), text.rfind("}")
    if i >= 0 and j > i:
        try:
            return json.loads(text[i:j + 1])
        except json.JSONDecodeError:
            return None
    return None


def main(argv):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--val", default="data/forecast-loc-val.jsonl")
    p.add_argument("--base-url", default="http://localhost:8001/v1")
    p.add_argument("--model", default="toronto-forecaster")
    p.add_argument("--api-key", default=None)
    p.add_argument("--n", type=int, default=200, help="Number of val rows to score.")
    p.add_argument("--timeout", type=float, default=60.0)
    args = p.parse_args(argv)

    rows = []
    with open(args.val, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
            if len(rows) >= args.n:
                break

    n = len(rows)
    print(f"Scoring {n} rows from {args.val} against {args.model} @ {args.base_url}\n")

    level_hits = 0
    abs_err = 0.0
    scored = 0
    valid_json = 0
    errors = 0
    confusion = Counter()  # (true, pred)

    for idx, row in enumerate(rows, 1):
        msgs = row["messages"]
        system = msgs[0]["content"]
        user = msgs[1]["content"]
        truth = json.loads(msgs[2]["content"])
        try:
            text = call(args.base_url, args.model, args.api_key, system, user, args.timeout)
        except (urllib.error.URLError, KeyError, TimeoutError) as e:
            errors += 1
            if errors <= 3:
                print(f"  request error on row {idx}: {e}", file=sys.stderr)
            continue
        pred = extract_json(text)
        if not isinstance(pred, dict) or "level" not in pred or "score" not in pred:
            confusion[(truth.get("level"), None)] += 1
            continue
        valid_json += 1
        tl, pl = truth.get("level"), pred.get("level")
        confusion[(tl, pl)] += 1
        if tl == pl:
            level_hits += 1
        try:
            abs_err += abs(float(truth["score"]) - float(pred["score"]))
            scored += 1
        except (TypeError, ValueError):
            pass
        if idx % 25 == 0:
            print(f"  ...{idx}/{n}")

    done = n - errors
    print("\n=== Results ===")
    print(f"  requests:      {n}  (errors: {errors})")
    if done:
        print(f"  JSON validity: {valid_json}/{done}  ({100.0*valid_json/done:.1f}%)")
        print(f"  level accuracy:{level_hits}/{done}  ({100.0*level_hits/done:.1f}%)")
    if scored:
        print(f"  score MAE:     {abs_err/scored:.4f}  (n={scored})")
    print("\n  confusion (true -> pred):")
    for tl in LEVELS:
        line = "  ".join(f"{pl or 'BAD'}:{confusion.get((tl, pl), 0):>4}"
                         for pl in LEVELS + [None])
        print(f"    {tl:<9} | {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
