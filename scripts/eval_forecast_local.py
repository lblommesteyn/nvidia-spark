#!/usr/bin/env python3
"""Evaluate a LoRA forecast adapter by LOCAL inference (no served NIM needed).

Same metrics as scripts/eval_forecast.py (level accuracy, score MAE, JSON
validity, confusion table), but instead of POSTing to an OpenAI-compatible
endpoint it loads the base model + the trained PEFT adapter directly with
transformers/peft and generates on the held-out split. Use this on a CUDA box
(e.g. the GX10) when you have the adapter on disk but no NIM running.

  python3 scripts/eval_forecast_local.py \
      --val data/forecast-val.jsonl \
      --base nvidia/Llama-3.1-Nemotron-Nano-8B-v1 \
      --adapter out/toronto-forecaster-lora \
      --n 300

Pass --base "" to evaluate the raw base model with no adapter (baseline).
"""
import argparse
import json
import sys
from collections import Counter

LEVELS = ["low", "moderate", "elevated", "surge"]


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
    p.add_argument("--val", default="data/forecast-val.jsonl")
    p.add_argument("--base", default="nvidia/Llama-3.1-Nemotron-Nano-8B-v1",
                   help="Base model id/path. Tokenizer is loaded from --adapter if present.")
    p.add_argument("--adapter", default="out/toronto-forecaster-lora",
                   help='PEFT adapter dir. Pass "" to evaluate the base alone.')
    p.add_argument("--n", type=int, default=300)
    p.add_argument("--max-new-tokens", type=int, default=320)
    args = p.parse_args(argv)

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok_src = args.adapter or args.base
    tokenizer = AutoTokenizer.from_pretrained(tok_src, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    print(f"Loading base {args.base} ...", file=sys.stderr)
    fp_kw = {"dtype": torch.bfloat16}
    try:
        model = AutoModelForCausalLM.from_pretrained(
            args.base, device_map="auto", trust_remote_code=True, **fp_kw)
    except TypeError:
        model = AutoModelForCausalLM.from_pretrained(
            args.base, device_map="auto", trust_remote_code=True,
            torch_dtype=torch.bfloat16)
    if args.adapter:
        from peft import PeftModel
        print(f"Attaching adapter {args.adapter} ...", file=sys.stderr)
        model = PeftModel.from_pretrained(model, args.adapter)
    model.eval()

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
    tag = args.adapter or f"{args.base} (base, no adapter)"
    print(f"Scoring {n} rows from {args.val} against {tag}\n")

    level_hits = abs_err = scored = valid_json = 0
    confusion = Counter()

    for idx, row in enumerate(rows, 1):
        msgs = row["messages"]
        prompt_msgs = [msgs[0], msgs[1]]
        truth = json.loads(msgs[2]["content"])
        enc = tokenizer.apply_chat_template(
            prompt_msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)
        enc = {k: v.to(model.device) for k, v in enc.items()}
        prompt_len = enc["input_ids"].shape[1]
        with torch.no_grad():
            out = model.generate(
                **enc, max_new_tokens=args.max_new_tokens, do_sample=False,
                pad_token_id=tokenizer.pad_token_id)
        text = tokenizer.decode(out[0][prompt_len:], skip_special_tokens=True)
        pred = extract_json(text)
        if not isinstance(pred, dict) or "level" not in pred or "score" not in pred:
            confusion[(truth.get("level"), None)] += 1
        else:
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
            print(f"  ...{idx}/{n}  (level acc so far {100.0*level_hits/idx:.1f}%)",
                  file=sys.stderr)

    print("\n=== Results ===")
    print(f"  rows scored:   {n}")
    print(f"  JSON validity: {valid_json}/{n}  ({100.0*valid_json/n:.1f}%)")
    print(f"  level accuracy:{level_hits}/{n}  ({100.0*level_hits/n:.1f}%)")
    if scored:
        print(f"  score MAE:     {abs_err/scored:.4f}  (n={scored})")
    print("\n  confusion (true -> pred):")
    header = "  ".join(f"{pl or 'BAD':>8}" for pl in LEVELS + [None])
    print(f"    {'true/pred':<10} | {header}")
    for tl in LEVELS:
        line = "  ".join(f"{confusion.get((tl, pl), 0):>8}" for pl in LEVELS + [None])
        print(f"    {tl:<10} | {line}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
