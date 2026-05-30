#!/usr/bin/env python3
"""LoRA fine-tune the Nemotron-Nano-8B student on the Toronto demand-forecast set.

This is the GPU step of the GX10 runbook (docs/GX10-NEMOTRON.md §3). It trains a
small LoRA adapter on top of a frozen `Llama-3.1-Nemotron-Nano-8B` base, using the
chat-format JSONL produced by scripts/backfill_location.py
(`data/forecast-loc-train.jsonl` / `forecast-loc-val.jsonl`).

It requires an NVIDIA GPU and the HF training stack; it does NOT run on this Mac.
Run it on the ASUS GX10 (GB10) or any CUDA box:

    pip install "transformers>=4.44" "trl>=0.9" "peft>=0.12" \
                "datasets>=2.20" "accelerate>=0.33" bitsandbytes

    python3 scripts/train_lora.py \
        --train data/forecast-loc-train.jsonl \
        --val   data/forecast-loc-val.jsonl \
        --base  nvidia/Llama-3.1-Nemotron-Nano-8B-v1 \
        --out   out/toronto-forecaster-lora

The output adapter mounts straight into a Nano-8B NIM (runbook §4):
    -v "$PWD/out/toronto-forecaster-lora":/opt/loras/toronto -e NIM_PEFT_SOURCE=/opt/loras

Validate the data first (no GPU needed):
    python3 scripts/validate_dataset.py data/forecast-loc-train.jsonl
"""
import argparse
import inspect
import sys


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--train", default="data/forecast-loc-train.jsonl")
    p.add_argument("--val", default="data/forecast-loc-val.jsonl")
    p.add_argument("--base", default="nvidia/Llama-3.1-Nemotron-Nano-8B-v1",
                   help="Base model id (HF hub or local path).")
    p.add_argument("--out", default="out/toronto-forecaster-lora")
    p.add_argument("--epochs", type=float, default=1.0)
    p.add_argument("--max-steps", type=int, default=-1,
                   help="Override epochs with a fixed step count (-1 = use epochs).")
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--batch-size", type=int, default=4, help="Per-device batch size.")
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--max-seq-len", type=int, default=1024)
    p.add_argument("--lora-rank", type=int, default=16)
    p.add_argument("--lora-alpha", type=int, default=32)
    p.add_argument("--lora-dropout", type=float, default=0.05)
    p.add_argument("--load-4bit", action="store_true",
                   help="QLoRA: load the base in 4-bit (needs bitsandbytes).")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)

    # Imports are deferred so --help works without the GPU stack installed.
    try:
        import torch
        from datasets import load_dataset
        from peft import LoraConfig
        from transformers import (AutoModelForCausalLM, AutoTokenizer,
                                  BitsAndBytesConfig)
        from trl import SFTConfig, SFTTrainer
    except ImportError as e:
        print(f"Missing training dependency: {e}\n"
              "Install on a CUDA box:\n"
              "  pip install transformers trl peft datasets accelerate bitsandbytes",
              file=sys.stderr)
        return 1

    if not torch.cuda.is_available():
        print("ERROR: no CUDA GPU detected. Run this on the GX10 / a CUDA host.",
              file=sys.stderr)
        return 1

    print(f"GPU: {torch.cuda.get_device_name(0)}  |  base: {args.base}")

    tokenizer = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    quant = None
    if args.load_4bit:
        quant = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

    # transformers>=5 renamed `torch_dtype` -> `dtype`; pick whichever the
    # installed version accepts so this runs on old and new stacks.
    _fp_params = inspect.signature(AutoModelForCausalLM.from_pretrained).parameters
    _dtype_kw = "dtype" if ("dtype" in _fp_params or "torch_dtype" not in _fp_params) else "torch_dtype"
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        device_map="auto",
        quantization_config=quant,
        trust_remote_code=True,
        **{_dtype_kw: torch.bfloat16},
    )
    model.config.use_cache = False

    lora = LoraConfig(
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )

    # The JSONL is already in chat format: {"messages":[system,user,assistant]}.
    # SFTTrainer applies the tokenizer's chat template to each row.
    data_files = {"train": args.train, "validation": args.val}
    ds = load_dataset("json", data_files=data_files)

    def to_text(row):
        return {"text": tokenizer.apply_chat_template(
            row["messages"], tokenize=False, add_generation_prompt=False)}

    ds = ds.map(to_text, remove_columns=ds["train"].column_names)

    sft_kwargs = dict(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=20,
        eval_strategy="steps",
        eval_steps=200,
        save_steps=200,
        save_total_limit=2,
        bf16=True,
        packing=False,
        dataset_text_field="text",
        seed=args.seed,
        report_to="none",
    )
    # trl>=1 renamed SFTConfig.max_seq_length -> max_length.
    _sft_params = inspect.signature(SFTConfig.__init__).parameters
    if "max_length" in _sft_params:
        sft_kwargs["max_length"] = args.max_seq_len
    elif "max_seq_length" in _sft_params:
        sft_kwargs["max_seq_length"] = args.max_seq_len
    sft = SFTConfig(**sft_kwargs)

    # trl>=0.12 deprecated `tokenizer=` in favor of `processing_class=`
    # (removed entirely in trl>=0.20).
    _trainer_params = inspect.signature(SFTTrainer.__init__).parameters
    _tok_kw = "processing_class" if "processing_class" in _trainer_params else "tokenizer"
    trainer = SFTTrainer(
        model=model,
        args=sft,
        train_dataset=ds["train"],
        eval_dataset=ds["validation"],
        peft_config=lora,
        **{_tok_kw: tokenizer},
    )

    print("Starting LoRA fine-tune...")
    trainer.train()
    trainer.save_model(args.out)
    tokenizer.save_pretrained(args.out)
    print(f"Done. LoRA adapter written to {args.out}")
    print("Serve it (runbook §4):")
    print(f'  -v "$PWD/{args.out}":/opt/loras/toronto -e NIM_PEFT_SOURCE=/opt/loras')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
