"""Geräteauswahl.

Standard ist die CPU: Auf Intel-Macs gibt es nur PyTorch <= 2.2.2, und die
Metal-Beschleunigung (MPS) ist dort mit AMD-Grafikkarten unzuverlässig.
Mit der Umgebungsvariable JZOAI_DEVICE=mps|cuda|cpu lässt sich das ändern.
"""
from __future__ import annotations

import os
import platform

# Einzelne Operatoren fehlen auf MPS -> automatisch auf CPU ausweichen.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def torch_available() -> bool:
    try:
        import torch  # noqa: F401
        return True
    except ImportError:
        return False


def is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def get_device():
    """Gibt ein torch.device zurück oder None, falls torch fehlt."""
    if not torch_available():
        return None
    import torch

    wanted = os.environ.get("JZOAI_DEVICE", "").lower()
    if wanted == "mps" and torch.backends.mps.is_available():
        return torch.device("mps")
    if wanted == "cuda" and torch.cuda.is_available():
        return torch.device("cuda")
    if wanted == "cpu":
        return torch.device("cpu")

    # Automatik: nur auf Apple Silicon bzw. NVIDIA eine GPU nehmen.
    if is_apple_silicon() and torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def default_tile(device) -> int:
    """Kachelgröße: auf der CPU kleiner, damit der Speicher ruhig bleibt."""
    if device is None or device.type == "cpu":
        return 384
    return 512


def describe() -> str:
    dev = get_device()
    if dev is None:
        return "PyTorch nicht installiert -> nur klassischer Modus (ohne KI)"
    return f"Rechengerät: {dev.type.upper()}"
