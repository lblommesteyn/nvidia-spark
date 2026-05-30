#!/usr/bin/env python3
"""
CityFlow bootstrap script.

Use:
    python bootstrap_cityflow.py

It checks/install essential packages for:
- Toronto open data ingestion
- GTFS-RT parsing
- LoRA fine-tuning
- local LLM inference API
- GPU logging
- benchmark plotting
"""

import importlib.util
import os
import subprocess
import sys
import platform
from pathlib import Path


VENV_DIR = Path(__file__).resolve().parent / ".venv"

ESSENTIAL_PACKAGES = [
    "requests",
    "pandas",
    "numpy",
    "pyarrow",
    "duckdb",
    "protobuf",
    "gtfs-realtime-bindings",
    "feedparser",
    "beautifulsoup4",
    "lxml",
    "matplotlib",
    "scikit-learn",
    "tqdm",
    "pynvml",
    "fastapi",
    "uvicorn",
    "pydantic",
    "prometheus-client",
    "openai",
    "datasets",
    "transformers",
    "accelerate",
    "peft",
    "trl",
    "mlflow",
    "wandb",
]

# Optional; some can be heavy or platform-sensitive.
OPTIONAL_PACKAGES = [
    "evidently",
]


IMPORT_NAME_OVERRIDES = {
    "gtfs-realtime-bindings": "google.transit.gtfs_realtime_pb2",
    "protobuf": "google.protobuf",
    "beautifulsoup4": "bs4",
    "scikit-learn": "sklearn",
    "prometheus-client": "prometheus_client",
}


def ensure_venv() -> None:
    """Use a project venv so pip installs work on PEP 668 systems."""
    if Path(sys.prefix).resolve() == VENV_DIR.resolve():
        return

    if not VENV_DIR.exists():
        print(f"Creating virtual environment at {VENV_DIR}")
        subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], check=True)

    venv_python = VENV_DIR / "bin" / "python"
    os.execv(str(venv_python), [str(venv_python), *sys.argv])


def has_package(pip_name: str) -> bool:
    import_name = IMPORT_NAME_OVERRIDES.get(pip_name, pip_name.replace("-", "_"))
    try:
        return importlib.util.find_spec(import_name) is not None
    except ModuleNotFoundError:
        return False


def pip_install(package: str) -> bool:
    print(f"\nInstalling: {package}")
    cmd = [sys.executable, "-m", "pip", "install", "-U", package]
    result = subprocess.run(cmd)
    return result.returncode == 0


def check_cuda():
    print("\nSystem info")
    print("Python:", sys.version)
    print("Platform:", platform.platform())
    print("Executable:", sys.executable)

    try:
        import torch
        print("Torch:", torch.__version__)
        print("CUDA available:", torch.cuda.is_available())
        if torch.cuda.is_available():
            print("GPU:", torch.cuda.get_device_name(0))
            print("CUDA version:", torch.version.cuda)
    except Exception as e:
        print("Torch check failed:", repr(e))


def main():
    ensure_venv()

    Path("data").mkdir(exist_ok=True)
    Path("outputs").mkdir(exist_ok=True)
    Path("adapters").mkdir(exist_ok=True)

    missing = [p for p in ESSENTIAL_PACKAGES if not has_package(p)]
    print("Missing essential packages:", missing)

    for package in missing:
        ok = pip_install(package)
        if not ok:
            print(f"Could not install {package}. Continue, but this may break later.")

    print("\nOptional packages")
    for package in OPTIONAL_PACKAGES:
        if not has_package(package):
            print(f"Optional missing: {package}")
            # Do not force optional installs unless wanted.
            # pip_install(package)

    check_cuda()

    print("\nDone. Next:")
    print(f"  {sys.executable} cityflow_mvp.py ingest")
    print(f"  {sys.executable} cityflow_mvp.py build_sft")
    print(f"  {sys.executable} cityflow_mvp.py train_lora")
    print(f"  {sys.executable} cityflow_mvp.py api")


if __name__ == "__main__":
    main()