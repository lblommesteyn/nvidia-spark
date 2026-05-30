#!/usr/bin/env python3
"""
CityFlow MVP ML backend.

Core commands:

1. Ingest Toronto city signals:
    python cityflow_mvp.py ingest

2. Build synthetic fine-tuning data:
    python cityflow_mvp.py build_sft

3. Fine-tune one NVIDIA model with LoRA:
    BASE_MODEL=nvidia/Llama-3.1-Nemotron-Nano-8B-v1 python cityflow_mvp.py train_lora

4. Run local API for React dashboard:
    python cityflow_mvp.py api

5. Benchmark local vLLM/Nemotron endpoint:
    python cityflow_mvp.py benchmark

Expected local optimized model endpoint:
    http://localhost:8000/v1

This file intentionally avoids too much preprocessing.
It creates a normalized event store with:
    source, event_type, title, body, where, when, severity, raw
"""

import argparse
import csv
import datetime as dt
import json
import math
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
import pandas as pd
import numpy as np
from tqdm import tqdm


DATA_DIR = Path("data")
OUT_DIR = Path("outputs")
ADAPTER_DIR = Path("adapters")

DATA_DIR.mkdir(exist_ok=True)
OUT_DIR.mkdir(exist_ok=True)
ADAPTER_DIR.mkdir(exist_ok=True)

CKAN_BASE = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action"

# Main model for first fine-tune.
BASE_MODEL = os.getenv("BASE_MODEL", "nvidia/Llama-3.1-Nemotron-Nano-8B-v1")

# Main local serving model name if using vLLM/OpenAI-compatible endpoint.
SERVED_MODEL = os.getenv(
    "SERVED_MODEL",
    "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning-NVFP4",
)

LOCAL_LLM_BASE_URL = os.getenv("LOCAL_LLM_BASE_URL", "http://localhost:8000/v1")
LOCAL_LLM_API_KEY = os.getenv("LOCAL_LLM_API_KEY", "EMPTY")


@dataclass
class CityEvent:
    source: str
    event_type: str
    title: str
    body: str
    where: Optional[str]
    when: str
    severity: int
    raw: Dict[str, Any]


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def save_jsonl(path: Path, rows: List[Dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


# ---------------------------------------------------------------------
# Toronto Open Data / CKAN helpers
# ---------------------------------------------------------------------

def ckan_get(action: str, params: Dict[str, Any], timeout: int = 60) -> Dict[str, Any]:
    url = f"{CKAN_BASE}/{action}"
    r = requests.get(url, params=params, timeout=timeout)
    r.raise_for_status()
    data = r.json()
    if not data.get("success", False):
        raise RuntimeError(f"CKAN action failed: {action} {params} -> {data}")
    return data["result"]


def ckan_search_packages(query: str, rows: int = 5) -> List[Dict[str, Any]]:
    result = ckan_get("package_search", {"q": query, "rows": rows})
    return result.get("results", [])


def ckan_package_show(package_id_or_slug: str) -> Dict[str, Any]:
    return ckan_get("package_show", {"id": package_id_or_slug})


def download_resource_url(url: str, out_path: Path, timeout: int = 120) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with out_path.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
    return out_path


def first_downloadable_resource(package: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    resources = package.get("resources", [])
    preferred = []
    for res in resources:
        fmt = str(res.get("format", "")).lower()
        url = res.get("url") or ""
        if not url:
            continue
        score = 0
        if res.get("datastore_active"):
            score += 5
        if fmt in {"json", "geojson", "csv", "xlsx", "zip", "txt"}:
            score += 3
        if "realtime" in res.get("name", "").lower():
            score += 2
        preferred.append((score, res))
    preferred.sort(key=lambda x: x[0], reverse=True)
    return preferred[0][1] if preferred else None


def load_ckan_dataset_minimal(query_or_slug: str, limit: int = 5000) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Minimal no-preprocessing loader:
    - try package_show(slug)
    - else package_search(query)
    - if datastore_active, use datastore_search
    - else download resource and read using pandas where possible
    """
    try:
        package = ckan_package_show(query_or_slug)
    except Exception:
        results = ckan_search_packages(query_or_slug, rows=3)
        if not results:
            raise RuntimeError(f"No CKAN package found for: {query_or_slug}")
        package = ckan_package_show(results[0]["id"])

    res = first_downloadable_resource(package)
    if not res:
        raise RuntimeError(f"No downloadable resources found in {package.get('name')}")

    if res.get("datastore_active"):
        ds = ckan_get("datastore_search", {"id": res["id"], "limit": limit})
        df = pd.DataFrame(ds.get("records", []))
        return df, {"package": package, "resource": res, "mode": "datastore_search"}

    url = res.get("url")
    fmt = str(res.get("format", "")).lower()
    suffix = "." + (fmt if fmt else "dat")
    path = DATA_DIR / "raw" / f"{package.get('name', 'dataset')}_{res.get('id', 'res')}{suffix}"
    download_resource_url(url, path)

    if fmt == "csv":
        df = pd.read_csv(path)
    elif fmt in {"xlsx", "xls"}:
        df = pd.read_excel(path)
    elif fmt in {"json", "geojson"}:
        try:
            df = pd.read_json(path)
        except ValueError:
            df = pd.DataFrame(json.loads(path.read_text()))
    else:
        df = pd.DataFrame([{"downloaded_file": str(path), "format": fmt, "url": url}])

    return df, {"package": package, "resource": res, "mode": "download"}


# ---------------------------------------------------------------------
# Realtime feeds
# ---------------------------------------------------------------------

def fetch_bikeshare_gbfs() -> List[CityEvent]:
    """
    Bike Share Toronto GBFS v3 auto-discovery.
    """
    events: List[CityEvent] = []
    gbfs_url = "https://toronto.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json"

    try:
        gbfs = requests.get(gbfs_url, timeout=30).json()
        feeds = gbfs.get("data", {}).get("feeds", [])
        feed_urls = {f["name"]: f["url"] for f in feeds if "name" in f and "url" in f}

        status_url = feed_urls.get("station_status")
        info_url = feed_urls.get("station_information")

        if not status_url:
            raise RuntimeError("station_status missing from GBFS auto-discovery.")

        status = requests.get(status_url, timeout=30).json()
        stations = status.get("data", {}).get("stations", [])

        info_by_id = {}
        if info_url:
            info = requests.get(info_url, timeout=30).json()
            for s in info.get("data", {}).get("stations", []):
                info_by_id[str(s.get("station_id"))] = s

        for s in stations:
            station_id = str(s.get("station_id"))
            info = info_by_id.get(station_id, {})
            bikes = int(s.get("num_bikes_available", 0) or 0)
            docks = int(s.get("num_docks_available", 0) or 0)
            disabled = bool(s.get("is_installed", 1) == 0 or s.get("is_renting", 1) == 0)

            severity = 1
            if disabled:
                severity = 4
            elif bikes == 0 or docks == 0:
                severity = 3

            title = f"Bike station {info.get('name', station_id)}: {bikes} bikes, {docks} docks"
            body = f"Realtime bike availability at station {station_id}. Bikes={bikes}, docks={docks}."

            events.append(CityEvent(
                source="bike_share_gbfs",
                event_type="bike_availability",
                title=title,
                body=body,
                where=info.get("name") or station_id,
                when=now_iso(),
                severity=severity,
                raw={"status": s, "info": info},
            ))
    except Exception as e:
        events.append(CityEvent(
            source="bike_share_gbfs",
            event_type="loader_error",
            title="Bike Share GBFS load failed",
            body=repr(e),
            where="Toronto",
            when=now_iso(),
            severity=2,
            raw={},
        ))

    return events


def fetch_ttc_gtfs_rt_from_open_data() -> List[CityEvent]:
    """
    Search Toronto Open Data for TTC GTFS-RT and parse FeedMessage.
    This avoids hardcoding the protobuf URL.
    """
    events: List[CityEvent] = []

    try:
        packages = ckan_search_packages("TTC GTFS realtime GTFS-RT", rows=5)
        if not packages:
            raise RuntimeError("Could not find TTC GTFS realtime package.")

        package = ckan_package_show(packages[0]["id"])
        resources = package.get("resources", [])

        # GTFS-RT resources are protobuf URLs. Try resources with relevant names.
        candidates = []
        for res in resources:
            name = str(res.get("name", "")).lower()
            url = res.get("url", "")
            if not url:
                continue
            if any(k in name for k in ["alert", "trip", "vehicle", "gtfs", "realtime"]):
                candidates.append(res)

        if not candidates:
            candidates = [r for r in resources if r.get("url")]

        from google.transit import gtfs_realtime_pb2

        for res in candidates[:3]:
            url = res["url"]
            name = res.get("name", "ttc_gtfs_rt")
            try:
                content = requests.get(url, timeout=30).content
                feed = gtfs_realtime_pb2.FeedMessage()
                feed.ParseFromString(content)

                count = 0
                for entity in feed.entity:
                    if entity.HasField("alert"):
                        alert = entity.alert
                        header = ""
                        desc = ""
                        if alert.header_text.translation:
                            header = alert.header_text.translation[0].text
                        if alert.description_text.translation:
                            desc = alert.description_text.translation[0].text

                        events.append(CityEvent(
                            source="ttc_gtfs_rt",
                            event_type="transit_alert",
                            title=header or f"TTC alert from {name}",
                            body=desc or "GTFS-RT alert detected.",
                            where="Toronto TTC",
                            when=now_iso(),
                            severity=4,
                            raw={"resource": name, "entity_id": entity.id},
                        ))
                        count += 1

                    elif entity.HasField("trip_update"):
                        tu = entity.trip_update
                        route = tu.trip.route_id
                        delay = 0
                        for stu in tu.stop_time_update:
                            if stu.arrival and stu.arrival.delay:
                                delay = max(delay, int(stu.arrival.delay))
                        if delay > 0:
                            events.append(CityEvent(
                                source="ttc_gtfs_rt",
                                event_type="transit_delay",
                                title=f"TTC route {route} delay {delay}s",
                                body=f"GTFS-RT trip update reports max delay of {delay} seconds.",
                                where=f"TTC route {route}",
                                when=now_iso(),
                                severity=3 if delay > 600 else 2,
                                raw={"resource": name, "entity_id": entity.id, "route_id": route, "delay_s": delay},
                            ))
                            count += 1

                if count > 0:
                    break

            except Exception:
                continue

        if not events:
            events.append(CityEvent(
                source="ttc_gtfs_rt",
                event_type="heartbeat",
                title="TTC GTFS-RT loaded",
                body="Feed loaded but no alert/delay events were extracted in this minimal parser.",
                where="Toronto TTC",
                when=now_iso(),
                severity=1,
                raw={"package": package.get("name")},
            ))

    except Exception as e:
        events.append(CityEvent(
            source="ttc_gtfs_rt",
            event_type="loader_error",
            title="TTC GTFS-RT load failed",
            body=repr(e),
            where="Toronto TTC",
            when=now_iso(),
            severity=2,
            raw={},
        ))

    return events


def fetch_environment_canada_alerts() -> List[CityEvent]:
    """
    Very simple ECCC alerts loader through api.weather.gc.ca.
    It filters around Toronto's approximate bbox.
    """
    events: List[CityEvent] = []
    url = "https://api.weather.gc.ca/collections/weather-alerts/items"
    params = {
        "lang": "en",
        "limit": 20,
        # Toronto approximate point query via bbox.
        "bbox": "-79.7,43.5,-79.1,43.9",
    }

    try:
        data = requests.get(url, params=params, timeout=30).json()
        features = data.get("features", [])
        for feat in features:
            props = feat.get("properties", {})
            title = props.get("headline") or props.get("event") or "Weather alert"
            severity_text = str(props.get("severity", "")).lower()
            severity = 4 if "severe" in severity_text or "extreme" in severity_text else 3

            events.append(CityEvent(
                source="eccc_weather_alerts",
                event_type="weather_alert",
                title=title,
                body=props.get("description") or props.get("instruction") or title,
                where=props.get("areaDesc") or "Toronto",
                when=props.get("sent") or now_iso(),
                severity=severity,
                raw=props,
            ))

        if not events:
            events.append(CityEvent(
                source="eccc_weather_alerts",
                event_type="heartbeat",
                title="No active weather alerts in Toronto bbox",
                body="No active ECCC alert features returned for Toronto bbox.",
                where="Toronto",
                when=now_iso(),
                severity=1,
                raw={},
            ))

    except Exception as e:
        events.append(CityEvent(
            source="eccc_weather_alerts",
            event_type="loader_error",
            title="ECCC weather alert load failed",
            body=repr(e),
            where="Toronto",
            when=now_iso(),
            severity=2,
            raw={},
        ))

    return events


def fetch_open_data_search_snapshot() -> List[CityEvent]:
    """
    Pull a few relevant Toronto Open Data datasets with almost no preprocessing.
    These are snapshots, not perfect realtime feeds.
    """
    events: List[CityEvent] = []
    queries = [
        "permanent bicycle counters",
        "road restrictions closures",
        "311 service requests",
        "library branch programs and events feed",
        "noise exemption permits",
    ]

    for q in queries:
        try:
            df, meta = load_ckan_dataset_minimal(q, limit=50)
            package_name = meta["package"].get("name", q)
            title = meta["package"].get("title", package_name)

            events.append(CityEvent(
                source="toronto_open_data_ckan",
                event_type="dataset_snapshot",
                title=f"Loaded dataset: {title}",
                body=f"Query={q}; rows={len(df)}; cols={len(df.columns)}; mode={meta['mode']}",
                where="Toronto",
                when=now_iso(),
                severity=1,
                raw={
                    "query": q,
                    "package": package_name,
                    "columns": list(map(str, df.columns[:30])),
                    "sample": df.head(3).astype(str).to_dict(orient="records"),
                },
            ))

            out_csv = DATA_DIR / f"snapshot_{re.sub('[^a-zA-Z0-9]+', '_', q).strip('_')}.csv"
            df.head(5000).to_csv(out_csv, index=False)

        except Exception as e:
            events.append(CityEvent(
                source="toronto_open_data_ckan",
                event_type="loader_error",
                title=f"Open Data load failed: {q}",
                body=repr(e),
                where="Toronto",
                when=now_iso(),
                severity=2,
                raw={"query": q},
            ))

    return events


def ingest_all() -> None:
    all_events: List[CityEvent] = []

    loaders = [
        fetch_bikeshare_gbfs,
        fetch_ttc_gtfs_rt_from_open_data,
        fetch_environment_canada_alerts,
        fetch_open_data_search_snapshot,
    ]

    for loader in loaders:
        print(f"Running loader: {loader.__name__}")
        events = loader()
        print(f"  -> {len(events)} events")
        all_events.extend(events)

    rows = [asdict(e) for e in all_events]
    out = DATA_DIR / "normalized_events.jsonl"
    save_jsonl(out, rows)
    print(f"Saved {len(rows)} normalized events to {out}")

    # Also save CSV for React/debugging.
    pd.DataFrame(rows).to_csv(DATA_DIR / "normalized_events.csv", index=False)


# ---------------------------------------------------------------------
# Synthetic SFT dataset
# ---------------------------------------------------------------------

BUSINESS_PROFILES = [
    {
        "business_type": "coffee shop",
        "area": "downtown Toronto near TTC station",
        "constraints": "limited staff, morning rush dependent, small inventory room",
    },
    {
        "business_type": "quick-service restaurant",
        "area": "near office towers and bike lanes",
        "constraints": "delivery-heavy lunch demand, food spoilage risk",
    },
    {
        "business_type": "retail clothing store",
        "area": "Queen West",
        "constraints": "foot traffic sensitive, promotion-driven",
    },
    {
        "business_type": "bakery",
        "area": "residential-commercial mixed neighbourhood",
        "constraints": "fresh inventory must be planned before morning",
    },
]


def rule_based_recommendation(event: Dict[str, Any], business: Dict[str, Any]) -> str:
    etype = event.get("event_type", "")
    sev = int(event.get("severity", 1) or 1)
    title = event.get("title", "")

    recs = []

    if "transit" in etype:
        recs.append("Increase delivery readiness and reduce dependence on walk-in commuter traffic.")
        recs.append("Delay staffing increases until transit reliability improves.")
        recs.append("Post a local update explaining alternate access routes.")
    elif "weather" in etype:
        recs.append("Shift demand forecast toward delivery and pickup instead of walk-ins.")
        recs.append("Prepare weather-linked promotion copy for nearby customers.")
        recs.append("Avoid overproducing highly perishable inventory.")
    elif "bike" in etype:
        recs.append("Expect local micro-foot-traffic changes near bike stations.")
        recs.append("If bikes are unavailable nearby, reduce assumptions about cyclist-driven visits.")
        recs.append("If docks are unavailable, expect short stops from riders searching for parking.")
    elif "dataset_snapshot" in etype:
        recs.append("Treat this as weak context, not a direct operational trigger.")
        recs.append("Use the dataset as a background feature for the demand model.")
    else:
        recs.append("Monitor the signal but do not change operations unless severity increases.")

    if sev >= 4:
        priority = "High"
        recs.insert(0, "Trigger immediate owner/operator alert.")
    elif sev == 3:
        priority = "Medium"
    else:
        priority = "Low"

    output = {
        "priority": priority,
        "causal_chain": [
            f"City signal detected: {title}",
            f"Likely impact depends on business type: {business['business_type']}",
            "Recommendation chosen based on access, foot traffic, delivery, and inventory risk.",
        ],
        "ranked_recommendations": recs[:3],
        "confidence": 0.72 if sev >= 3 else 0.55,
    }

    return json.dumps(output, ensure_ascii=False, indent=2)


def build_sft_dataset() -> None:
    events = load_jsonl(DATA_DIR / "normalized_events.jsonl")
    if not events:
        raise RuntimeError("No normalized_events.jsonl found. Run: python cityflow_mvp.py ingest")

    samples = []
    for event in events:
        for business in BUSINESS_PROFILES:
            instruction = (
                "You are CityFlow, an autonomous AI operating system for small businesses in Toronto. "
                "Given a city event and a business profile, produce ranked operational recommendations. "
                "Always include priority, causal_chain, ranked_recommendations, and confidence as JSON."
            )

            user = {
                "city_event": {
                    "source": event.get("source"),
                    "event_type": event.get("event_type"),
                    "title": event.get("title"),
                    "body": event.get("body"),
                    "where": event.get("where"),
                    "when": event.get("when"),
                    "severity": event.get("severity"),
                },
                "business_profile": business,
            }

            output = rule_based_recommendation(event, business)

            samples.append({
                "instruction": instruction,
                "input": json.dumps(user, ensure_ascii=False, indent=2),
                "output": output,
            })

    out = DATA_DIR / "cityflow_sft.jsonl"
    save_jsonl(out, samples)
    print(f"Saved {len(samples)} SFT examples to {out}")


# ---------------------------------------------------------------------
# LoRA fine-tune
# ---------------------------------------------------------------------

def format_training_text(tokenizer, row: Dict[str, Any]) -> str:
    messages = [
        {"role": "system", "content": row["instruction"]},
        {"role": "user", "content": row["input"]},
        {"role": "assistant", "content": row["output"]},
    ]

    if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
        return tokenizer.apply_chat_template(messages, tokenize=False)

    # Fallback plain format.
    return (
        f"### System\n{row['instruction']}\n\n"
        f"### User\n{row['input']}\n\n"
        f"### Assistant\n{row['output']}"
    )


def train_lora() -> None:
    """
    Hackathon-safe first fine-tune.

    Default model:
        nvidia/Llama-3.1-Nemotron-Nano-8B-v1

    You can switch:
        BASE_MODEL=some-model python cityflow_mvp.py train_lora
    """
    import torch
    from datasets import Dataset
    from transformers import (
        AutoTokenizer,
        AutoModelForCausalLM,
        TrainingArguments,
        Trainer,
        DataCollatorForLanguageModeling,
    )
    from peft import LoraConfig, get_peft_model

    data_path = DATA_DIR / "cityflow_sft.jsonl"
    rows = load_jsonl(data_path)
    if not rows:
        raise RuntimeError("No SFT data found. Run: python cityflow_mvp.py build_sft")

    print(f"Loading tokenizer: {BASE_MODEL}")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    texts = [format_training_text(tokenizer, r) for r in rows]
    ds = Dataset.from_dict({"text": texts})

    print(f"Loading model: {BASE_MODEL}")
    model_kwargs = {
        "trust_remote_code": True,
        "torch_dtype": torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        "device_map": "auto" if torch.cuda.is_available() else None,
    }

    try:
        model = AutoModelForCausalLM.from_pretrained(
            BASE_MODEL,
            attn_implementation="flash_attention_2",
            **model_kwargs,
        )
        print("Loaded with flash_attention_2.")
    except Exception as e:
        print("flash_attention_2 load failed, falling back:", repr(e))
        model = AutoModelForCausalLM.from_pretrained(BASE_MODEL, **model_kwargs)

    model.gradient_checkpointing_enable()

    # Print MoE/router-ish modules if the architecture exposes them.
    print("\nPotential MoE/router/expert modules:")
    shown = 0
    for name, module in model.named_modules():
        lname = name.lower()
        if any(k in lname for k in ["moe", "expert", "router", "gate"]):
            print(" ", name, "->", module.__class__.__name__)
            shown += 1
            if shown >= 50:
                break
    if shown == 0:
        print("  No obvious MoE modules visible in this first fine-tune model.")

    lora_config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        # Common Llama/Nemotron target names. If model complains, inspect module names above.
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )

    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    max_length = int(os.getenv("MAX_LENGTH", "2048"))

    def tokenize(batch):
        return tokenizer(
            batch["text"],
            truncation=True,
            max_length=max_length,
            padding=False,
        )

    tokenized = ds.map(tokenize, batched=True, remove_columns=["text"])

    collator = DataCollatorForLanguageModeling(
        tokenizer=tokenizer,
        mlm=False,
    )

    run_name = os.getenv("RUN_NAME", f"cityflow-lora-{int(time.time())}")
    out_dir = ADAPTER_DIR / run_name

    args = TrainingArguments(
        output_dir=str(out_dir),
        per_device_train_batch_size=int(os.getenv("BATCH_SIZE", "1")),
        gradient_accumulation_steps=int(os.getenv("GRAD_ACCUM", "8")),
        learning_rate=float(os.getenv("LR", "2e-4")),
        num_train_epochs=float(os.getenv("EPOCHS", "1")),
        logging_steps=5,
        save_steps=50,
        save_total_limit=2,
        bf16=torch.cuda.is_available(),
        fp16=False,
        report_to=os.getenv("REPORT_TO", "none"),  # set REPORT_TO=wandb if wanted
        optim="adamw_torch",
        warmup_ratio=0.05,
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=tokenized,
        data_collator=collator,
    )

    print("Starting LoRA fine-tune...")
    trainer.train()

    print(f"Saving adapter to {out_dir}")
    trainer.model.save_pretrained(out_dir)
    tokenizer.save_pretrained(out_dir)

    print("Done.")
    print(f"Adapter path: {out_dir}")


# ---------------------------------------------------------------------
# Local LLM recommendation client
# ---------------------------------------------------------------------

def call_local_llm(messages: List[Dict[str, str]], model: str = SERVED_MODEL) -> str:
    from openai import OpenAI

    client = OpenAI(
        base_url=LOCAL_LLM_BASE_URL,
        api_key=LOCAL_LLM_API_KEY,
    )

    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.2,
        max_tokens=700,
    )
    return resp.choices[0].message.content


def build_cityflow_prompt(business_profile: Dict[str, Any], max_events: int = 20) -> List[Dict[str, str]]:
    events = load_jsonl(DATA_DIR / "normalized_events.jsonl")
    events = sorted(events, key=lambda x: int(x.get("severity", 1) or 1), reverse=True)[:max_events]

    compact_events = []
    for e in events:
        compact_events.append({
            "source": e.get("source"),
            "type": e.get("event_type"),
            "title": e.get("title"),
            "where": e.get("where"),
            "when": e.get("when"),
            "severity": e.get("severity"),
        })

    system = (
        "You are CityFlow, an autonomous AI operating system for Toronto small businesses. "
        "You monitor transit, weather, road, event, 311, and bike signals. "
        "Return JSON only with: priority, summary, causal_chain, ranked_recommendations, confidence."
    )

    user = {
        "business_profile": business_profile,
        "latest_city_events": compact_events,
        "task": "Predict likely demand/access impact and recommend concrete operational actions.",
    }

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(user, ensure_ascii=False, indent=2)},
    ]


# ---------------------------------------------------------------------
# GPU logging and benchmark
# ---------------------------------------------------------------------

def get_gpu_snapshot() -> Dict[str, Any]:
    try:
        import pynvml
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
        util = pynvml.nvmlDeviceGetUtilizationRates(handle)

        try:
            power_w = pynvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
        except Exception:
            power_w = None

        try:
            temp_c = pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU)
        except Exception:
            temp_c = None

        name = pynvml.nvmlDeviceGetName(handle)
        if isinstance(name, bytes):
            name = name.decode("utf-8")

        return {
            "gpu_name": name,
            "gpu_util_pct": util.gpu,
            "mem_util_pct": util.memory,
            "mem_used_gb": mem.used / 1e9,
            "mem_total_gb": mem.total / 1e9,
            "power_w": power_w,
            "temp_c": temp_c,
        }
    except Exception as e:
        return {"gpu_error": repr(e)}


def benchmark_local_llm() -> None:
    prompts = [
        {
            "business_type": "coffee shop",
            "area": "Union Station / Financial District",
            "constraints": "commuter-dependent, 4 staff max, limited baked goods inventory",
        },
        {
            "business_type": "quick-service restaurant",
            "area": "Queen West",
            "constraints": "delivery-heavy, lunch rush, high spoilage risk",
        },
        {
            "business_type": "retail store",
            "area": "Bloor-Yonge",
            "constraints": "foot traffic sensitive, promotion-driven",
        },
    ]

    rows = []
    for i, biz in enumerate(prompts):
        messages = build_cityflow_prompt(biz)
        before = get_gpu_snapshot()
        t0 = time.perf_counter()
        try:
            text = call_local_llm(messages)
            ok = True
        except Exception as e:
            text = repr(e)
            ok = False
        t1 = time.perf_counter()
        after = get_gpu_snapshot()

        output_tokens_rough = len(text.split())
        latency = t1 - t0

        row = {
            "i": i,
            "ok": ok,
            "latency_s": latency,
            "rough_output_words": output_tokens_rough,
            "rough_words_per_s": output_tokens_rough / max(latency, 1e-6),
            "before_gpu_util_pct": before.get("gpu_util_pct"),
            "after_gpu_util_pct": after.get("gpu_util_pct"),
            "before_mem_used_gb": before.get("mem_used_gb"),
            "after_mem_used_gb": after.get("mem_used_gb"),
            "after_power_w": after.get("power_w"),
            "response_preview": text[:500],
        }
        print(json.dumps(row, indent=2))
        rows.append(row)

    df = pd.DataFrame(rows)
    csv_path = OUT_DIR / "benchmark_results.csv"
    df.to_csv(csv_path, index=False)

    plot_benchmark(csv_path)
    print(f"Saved benchmark to {csv_path}")


def plot_benchmark(csv_path: Path) -> None:
    import matplotlib.pyplot as plt

    df = pd.read_csv(csv_path)

    for metric in ["latency_s", "rough_words_per_s", "after_mem_used_gb", "after_gpu_util_pct"]:
        if metric not in df.columns:
            continue

        plt.figure()
        plt.bar(df["i"].astype(str), df[metric])
        plt.xlabel("request_id")
        plt.ylabel(metric)
        plt.title(f"CityFlow benchmark: {metric}")
        out = OUT_DIR / f"plot_{metric}.png"
        plt.savefig(out, bbox_inches="tight", dpi=160)
        plt.close()
        print(f"Saved plot: {out}")


# ---------------------------------------------------------------------
# Simple drift logging
# ---------------------------------------------------------------------

def simple_drift_report() -> None:
    """
    Lightweight drift check:
    Compare older half vs newer half of event titles/bodies using TF-IDF centroid distance.
    """
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_distances

    events = load_jsonl(DATA_DIR / "normalized_events.jsonl")
    if len(events) < 4:
        print("Not enough events for drift report.")
        return

    texts = [
        f"{e.get('source')} {e.get('event_type')} {e.get('title')} {e.get('body')}"
        for e in events
    ]

    mid = len(texts) // 2
    ref = texts[:mid]
    cur = texts[mid:]

    vectorizer = TfidfVectorizer(max_features=2000)
    X = vectorizer.fit_transform(ref + cur)

    ref_centroid = X[:mid].mean(axis=0)
    cur_centroid = X[mid:].mean(axis=0)

    dist = float(cosine_distances(ref_centroid, cur_centroid)[0, 0])
    report = {
        "timestamp": now_iso(),
        "method": "tfidf_centroid_cosine_distance",
        "drift_score": dist,
        "interpretation": "higher means current city-event text distribution is farther from reference",
        "n_reference": len(ref),
        "n_current": len(cur),
    }

    out = OUT_DIR / "drift_report.json"
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"Saved {out}")


# ---------------------------------------------------------------------
# FastAPI for React dashboard
# ---------------------------------------------------------------------

def run_api() -> None:
    from fastapi import FastAPI
    from pydantic import BaseModel
    from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
    from fastapi.responses import Response
    import uvicorn

    app = FastAPI(title="CityFlow ML API")

    REQUESTS = Counter("cityflow_requests_total", "Total CityFlow recommendation requests")
    LATENCY = Histogram("cityflow_request_latency_seconds", "CityFlow request latency")

    class BusinessProfile(BaseModel):
        business_type: str = "coffee shop"
        area: str = "downtown Toronto"
        constraints: str = "limited staff and inventory"

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "served_model": SERVED_MODEL,
            "local_llm_base_url": LOCAL_LLM_BASE_URL,
            "gpu": get_gpu_snapshot(),
        }

    @app.get("/events")
    def events():
        return load_jsonl(DATA_DIR / "normalized_events.jsonl")[:200]

    @app.post("/recommend")
    def recommend(profile: BusinessProfile):
        REQUESTS.inc()
        t0 = time.perf_counter()

        business_profile = profile.model_dump()
        messages = build_cityflow_prompt(business_profile)

        try:
            answer = call_local_llm(messages)
            ok = True
        except Exception as e:
            answer = json.dumps({
                "priority": "Unknown",
                "summary": "Local LLM endpoint failed.",
                "error": repr(e),
                "fallback": "Run the vLLM server or use the rule-based fallback.",
            }, indent=2)
            ok = False

        latency = time.perf_counter() - t0
        LATENCY.observe(latency)

        log_row = {
            "timestamp": now_iso(),
            "ok": ok,
            "latency_s": latency,
            "business_profile": business_profile,
            "answer": answer,
            "gpu": get_gpu_snapshot(),
        }

        log_path = OUT_DIR / "api_recommendation_logs.jsonl"
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(log_row, ensure_ascii=False) + "\n")

        return log_row

    @app.get("/metrics")
    def metrics():
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("CITYFLOW_API_PORT", "8080")))


# ---------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "command",
        choices=[
            "ingest",
            "build_sft",
            "train_lora",
            "api",
            "benchmark",
            "drift",
        ],
    )
    args = parser.parse_args()

    if args.command == "ingest":
        ingest_all()
    elif args.command == "build_sft":
        build_sft_dataset()
    elif args.command == "train_lora":
        train_lora()
    elif args.command == "api":
        run_api()
    elif args.command == "benchmark":
        benchmark_local_llm()
    elif args.command == "drift":
        simple_drift_report()


if __name__ == "__main__":
    main()