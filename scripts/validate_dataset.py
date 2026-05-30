#!/usr/bin/env python3
"""Validate a forecast instruction-tuning JSONL file before LoRA fine-tuning.

Checks, per line:
  - parses as JSON and has a `messages` list
  - roles are exactly system, user, assistant (in order)
  - the assistant content parses as JSON and matches the forecast contract:
      score: float in [0, 1]
      level: one of {low, moderate, elevated, surge}
      headline: non-empty string
      drivers / windows / actions: lists

Reports total/valid/invalid counts, the level distribution, and the first few
errors. Exit code is non-zero if any line is invalid, so it can gate training.

Pure stdlib (Python 3.9+). Usage:
    python3 scripts/validate_dataset.py data/forecast-loc-train.jsonl
    python3 scripts/validate_dataset.py data/forecast-loc-train.jsonl data/forecast-loc-val.jsonl
"""
import json
import sys
from collections import Counter

LEVELS = {"low", "moderate", "elevated", "surge"}
EXPECTED_ROLES = ["system", "user", "assistant"]
MAX_ERRORS_SHOWN = 20


def validate_assistant(payload):
    """Return a list of error strings for the parsed assistant JSON (empty = ok)."""
    errs = []
    if not isinstance(payload, dict):
        return ["assistant content is not a JSON object"]
    score = payload.get("score")
    if not isinstance(score, (int, float)) or isinstance(score, bool):
        errs.append("score missing or not a number")
    elif not (0.0 <= float(score) <= 1.0):
        errs.append(f"score {score} out of [0,1]")
    level = payload.get("level")
    if level not in LEVELS:
        errs.append(f"level {level!r} not in {sorted(LEVELS)}")
    if not isinstance(payload.get("headline"), str) or not payload.get("headline"):
        errs.append("headline missing or empty")
    for key in ("drivers", "windows", "actions"):
        if not isinstance(payload.get(key), list):
            errs.append(f"{key} missing or not a list")
    return errs


def validate_line(raw):
    """Return (errors, level) for one raw JSONL line."""
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        return [f"line is not valid JSON: {e}"], None
    msgs = obj.get("messages")
    if not isinstance(msgs, list) or len(msgs) != 3:
        return ["missing `messages` list of length 3"], None
    roles = [m.get("role") for m in msgs]
    if roles != EXPECTED_ROLES:
        return [f"roles {roles} != {EXPECTED_ROLES}"], None
    for m in msgs:
        if not isinstance(m.get("content"), str) or not m.get("content"):
            return [f"empty content for role {m.get('role')}"], None
    try:
        payload = json.loads(msgs[2]["content"])
    except json.JSONDecodeError as e:
        return [f"assistant content not valid JSON: {e}"], None
    errs = validate_assistant(payload)
    return errs, payload.get("level")


def validate_file(path):
    total = valid = 0
    levels = Counter()
    errors = []
    with open(path, "r", encoding="utf-8") as fh:
        for i, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw:
                continue
            total += 1
            errs, level = validate_line(raw)
            if errs:
                if len(errors) < MAX_ERRORS_SHOWN:
                    errors.append((i, errs[0]))
            else:
                valid += 1
                if level:
                    levels[level] += 1
    return total, valid, levels, errors


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    overall_ok = True
    for path in argv[1:]:
        print(f"\n=== {path} ===")
        try:
            total, valid, levels, errors = validate_file(path)
        except FileNotFoundError:
            print(f"  ERROR: file not found")
            overall_ok = False
            continue
        invalid = total - valid
        print(f"  rows:    {total:,}")
        print(f"  valid:   {valid:,}")
        print(f"  invalid: {invalid:,}")
        if levels:
            denom = sum(levels.values())
            print("  level distribution:")
            for lvl in ("low", "moderate", "elevated", "surge"):
                c = levels.get(lvl, 0)
                pct = (100.0 * c / denom) if denom else 0.0
                print(f"    {lvl:<9} {c:>8,}  ({pct:4.1f}%)")
        if errors:
            print(f"  first {len(errors)} error(s):")
            for ln, msg in errors:
                print(f"    line {ln}: {msg}")
        if invalid:
            overall_ok = False
    print()
    if not overall_ok:
        print("RESULT: FAILED — fix invalid rows before training.")
        return 1
    print("RESULT: OK — dataset is ready for LoRA fine-tuning.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
