#!/usr/bin/env python3
"""Run a single forecast through the base model + trained LoRA adapter.

Loads `nvidia/Llama-3.1-Nemotron-Nano-8B-v1` + the PEFT adapter in
out/toronto-forecaster-lora and prints the model's JSON demand forecast.

Usage (from the repo root, with the training venv active):
    python3 scripts/infer.py                      # uses the first val row
    python3 scripts/infer.py --row 42             # a specific val row (shows truth)
    python3 scripts/infer.py --signals '{"localHour":18,"dayOfWeek":"Fri","isWeekend":false,"isHoliday":false,"season":"summer","weather":{"temperatureC":24,"precipMm":0,"windKph":10,"weatherCode":0,"description":"Clear sky"}}'
    python3 scripts/infer.py --base ""            # no adapter (raw base baseline)

Cache the GPU weights so you don't reload them every run:
    # Terminal 1 — load the model ONCE and keep it resident on the GPU:
    python3 scripts/infer.py --daemon
    # Terminal 2 — these now return instantly (no weight loading):
    python3 scripts/infer.py --row 42
    python3 scripts/infer.py --signals '{...}'

The daemon listens on a Unix socket (default /tmp/forecast-infer.sock, override
with --socket or $FORECAST_INFER_SOCKET). If no daemon is running, infer.py
falls back to loading the weights in-process (the old behaviour) and prints a
hint to start one.
"""
import argparse
import json
import os
import socket
import sys

SYSTEM = ("You are a Toronto demand-forecasting model for small businesses. "
          "Given live civic signals, output ONLY a JSON demand forecast for the next ~12 hours.")

DEFAULT_SOCKET = os.environ.get("FORECAST_INFER_SOCKET", "/tmp/forecast-infer.sock")


def resolve_prompt(args):
    """Build the user prompt (and ground truth, if any) from args. Cheap; no GPU."""
    if args.signals:
        user = ("Reason over the live signals below and forecast customer demand "
                "for the next ~12 hours.\n\nSIGNALS (JSON):\n" + args.signals)
        return user, None
    with open(args.val, encoding="utf-8") as fh:
        rows = [json.loads(l) for l in fh if l.strip()]
    row = rows[args.row]["messages"]
    return row[1]["content"], row[2]["content"]


def load_model(base, adapter):
    """Load tokenizer + base model (+ optional LoRA adapter) onto the GPU."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(adapter or base, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    print(f"loading {base} ...", file=sys.stderr)
    model = AutoModelForCausalLM.from_pretrained(
        base, device_map="auto", dtype=torch.bfloat16, trust_remote_code=True)
    if adapter:
        from peft import PeftModel
        print(f"attaching adapter {adapter} ...", file=sys.stderr)
        model = PeftModel.from_pretrained(model, adapter)
    model.eval()
    return tok, model


def generate(tok, model, user, max_new_tokens):
    """Run one greedy generation and return the decoded completion text."""
    import torch

    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
    enc = tok.apply_chat_template(
        msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)
    enc = {k: v.to(model.device) for k, v in enc.items()}
    prompt_len = enc["input_ids"].shape[1]
    with torch.no_grad():
        out = model.generate(**enc, max_new_tokens=max_new_tokens,
                             do_sample=False, pad_token_id=tok.pad_token_id)
    return tok.decode(out[0][prompt_len:], skip_special_tokens=True).strip()


# --- daemon / client wire protocol: one newline-terminated JSON object each way ---

def _send_json(sock, obj):
    sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))


def _recv_json(sock):
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = sock.recv(65536)
        if not chunk:
            break
        buf += chunk
    if not buf:
        return None
    return json.loads(buf.decode("utf-8"))


def run_daemon(args):
    """Load the model once and serve generate requests over a Unix socket."""
    tok, model = load_model(args.base, args.adapter)

    if os.path.exists(args.socket):
        os.unlink(args.socket)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(args.socket)
    srv.listen(8)
    print(f"[daemon] ready — weights resident, listening on {args.socket}\n"
          f"[daemon] run `python3 scripts/infer.py ...` in another shell for instant forecasts.\n"
          f"[daemon] Ctrl-C to stop.", file=sys.stderr, flush=True)
    try:
        while True:
            conn, _ = srv.accept()
            try:
                req = _recv_json(conn)
                if req is None:
                    continue
                try:
                    text = generate(tok, model, req["user"],
                                    int(req.get("max_new_tokens", 320)))
                    _send_json(conn, {"ok": True, "text": text})
                except Exception as e:  # don't let one bad request kill the daemon
                    _send_json(conn, {"ok": False, "error": repr(e)})
            finally:
                conn.close()
    except KeyboardInterrupt:
        print("\n[daemon] shutting down.", file=sys.stderr)
    finally:
        srv.close()
        if os.path.exists(args.socket):
            os.unlink(args.socket)
    return 0


def try_daemon(socket_path, user, max_new_tokens):
    """Return generated text via a running daemon, or None if none is reachable."""
    if not os.path.exists(socket_path):
        return None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(socket_path)
    except OSError:
        return None
    try:
        _send_json(sock, {"user": user, "max_new_tokens": max_new_tokens})
        resp = _recv_json(sock)
    finally:
        sock.close()
    if not resp:
        return None
    if not resp.get("ok"):
        print(f"daemon error: {resp.get('error')}", file=sys.stderr)
        return None
    return resp["text"]


def main(argv):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base", default="nvidia/Llama-3.1-Nemotron-Nano-8B-v1")
    p.add_argument("--adapter", default="out/toronto-forecaster-lora",
                   help='PEFT adapter dir. Pass "" to run the base with no adapter.')
    p.add_argument("--val", default="data/forecast-val.jsonl")
    p.add_argument("--row", type=int, default=0, help="Which val row to use as the prompt.")
    p.add_argument("--signals", default=None,
                   help="Inline signals JSON; overrides --row/--val.")
    p.add_argument("--max-new-tokens", type=int, default=320)
    p.add_argument("--daemon", action="store_true",
                   help="Load weights once and serve requests on --socket (keeps GPU warm).")
    p.add_argument("--socket", default=DEFAULT_SOCKET,
                   help="Unix socket path for the resident daemon.")
    p.add_argument("--no-daemon", action="store_true",
                   help="Force in-process weight loading; ignore any running daemon.")
    args = p.parse_args(argv)

    if args.daemon:
        return run_daemon(args)

    user, truth = resolve_prompt(args)

    text = None
    if not args.no_daemon:
        text = try_daemon(args.socket, user, args.max_new_tokens)

    if text is None:
        if not args.no_daemon:
            print("(no resident daemon — loading weights in-process. Start one with "
                  "`python3 scripts/infer.py --daemon` to avoid reloading.)",
                  file=sys.stderr)
        tok, model = load_model(args.base, args.adapter)
        text = generate(tok, model, user, args.max_new_tokens)

    print("\n=== PROMPT (user) ===")
    print(user)
    print("\n=== MODEL FORECAST ===")
    print(text)
    if truth is not None:
        print("\n=== GROUND TRUTH ===")
        print(truth)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
