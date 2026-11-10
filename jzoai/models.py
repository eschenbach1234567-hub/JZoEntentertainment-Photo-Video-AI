"""KI-Modelle: Download, Laden (über spandrel) und Inferenz.

Die Modelle stammen aus Open-Source-Projekten (Real-ESRGAN, SCUNet/KAIR, spandrel).
Nach meinem Kenntnisstand erlauben deren Lizenzen auch geschäftliche Nutzung - bitte
die Lizenztexte der jeweiligen Projekte vor kommerziellem Einsatz selbst prüfen.
"""
from __future__ import annotations

import os
import urllib.request
from pathlib import Path

import numpy as np

from .device import get_device

MODELS_DIR = Path(os.environ.get("JZOAI_MODELS", Path(__file__).resolve().parent.parent / "models"))

REGISTRY: dict[str, dict] = {
    # Schnelles, kompaktes Upscaling-Modell (gut für CPU-Betrieb)
    "general": {
        "file": "realesr-general-x4v3.pth",
        "url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth",
        "multiple": 1,
        "desc": "Real-ESRGAN general x4v3 (schnell)",
    },
    # Größeres Modell, bessere Details, deutlich langsamer
    "x4plus": {
        "file": "RealESRGAN_x4plus.pth",
        "url": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
        "multiple": 1,
        "desc": "Real-ESRGAN x4plus (beste Qualität, langsam)",
    },
    # KI-Entrauschen für echte Kamerarauschen
    "scunet": {
        "file": "scunet_color_real_psnr.pth",
        "url": "https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth",
        "multiple": 64,
        "desc": "SCUNet color real (Entrauschen)",
    },
}


def model_path(key: str) -> Path:
    return MODELS_DIR / REGISTRY[key]["file"]


def is_downloaded(key: str) -> bool:
    return model_path(key).exists()


def download(key: str, log=print) -> Path:
    info = REGISTRY[key]
    dest = model_path(key)
    if dest.exists():
        return dest
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    log(f"Lade {info['desc']} ...")
    tmp = dest.with_suffix(".part")
    urllib.request.urlretrieve(info["url"], tmp)
    tmp.rename(dest)
    return dest


class ModelStore:
    """Hält geladene Modelle im Speicher und führt Inferenz auf Bildausschnitten aus."""

    def __init__(self, device=None, auto_download: bool = True, log=print):
        self.device = device if device is not None else get_device()
        self.auto_download = auto_download
        self.log = log
        self._cache: dict[str, object] = {}

    def available(self, key: str) -> bool:
        return self.device is not None and (is_downloaded(key) or self.auto_download)

    def _load(self, key: str):
        if key in self._cache:
            return self._cache[key]
        from spandrel import ModelLoader

        path = model_path(key)
        if not path.exists():
            download(key, self.log)
        desc = ModelLoader().load_from_file(path)
        desc.to(self.device).eval()
        self._cache[key] = desc
        return desc

    def scale_of(self, key: str) -> int:
        return int(self._load(key).scale)

    def run(self, key: str, patch: np.ndarray) -> np.ndarray:
        """patch: HxWx3 float32 (0..1) -> (H*scale)x(W*scale)x3 float32."""
        import torch
        import torch.nn.functional as F

        desc = self._load(key)
        h, w, _ = patch.shape
        mult = REGISTRY[key]["multiple"]
        t = torch.from_numpy(np.ascontiguousarray(patch)).permute(2, 0, 1)[None].to(self.device)
        pad_h, pad_w = (-h) % mult, (-w) % mult
        if pad_h or pad_w:
            t = F.pad(t, (0, pad_w, 0, pad_h), mode="replicate")
        with torch.inference_mode():
            out = desc(t)
        s = int(desc.scale)
        out = out[:, :, : h * s, : w * s]
        return out[0].permute(1, 2, 0).clamp(0, 1).cpu().numpy().astype(np.float32)
