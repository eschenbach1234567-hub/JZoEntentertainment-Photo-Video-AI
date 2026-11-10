"""Die Verarbeitungskette: Objektivkorrektur -> Vogelerkennung -> Entrauschen ->
Upscaling -> Schärfen -> Vogel-Detailpass."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import cv2
import numpy as np

from . import birds as B
from . import classic, lens
from .device import default_tile, get_device, torch_available
from .models import ModelStore, is_downloaded
from .tiling import tiled_apply

PRESETS: dict[str, dict] = {
    "standard": dict(denoise=0.4, sharpen=0.3),
    "hohe-iso": dict(denoise=0.8, sharpen=0.35),
    "voegel": dict(denoise=0.5, sharpen=0.3, birds=True, bird_detail=0.7,
                   bird_bg_denoise=0.4, bird_target_px=1200),
    "voegel-klein": dict(denoise=0.6, sharpen=0.3, birds=True, bird_mode="thorough",
                         bird_detail=0.8, bird_bg_denoise=0.5, bird_target_px=1400),
}


@dataclass
class Settings:
    engine: str = "auto"            # auto | ai | classic
    denoise: float = 0.4            # 0..1
    sharpen: float = 0.3            # 0..1
    upscale: int = 1                # 1, 2 oder 4
    upscale_model: str = "general"  # general (schnell) | x4plus (beste Qualität)
    fast_denoise: bool = False      # True: klassisches Entrauschen (ca. 10x schneller als KI auf CPU)
    lens: bool = True
    tile: int | None = None
    # Vogel-Modus
    birds: bool = False
    bird_mode: str = "fast"         # fast | thorough
    bird_boxes: list = field(default_factory=list)   # manuell: [(x0, y0, x1, y1), ...]
    bird_detail: float = 0.7        # 0..1 Federdetail
    bird_bg_denoise: float = 0.4    # 0..1 zusätzliches Entrauschen des Hintergrunds
    bird_target_px: int = 1200      # Arbeitsgröße (lange Kante) für den Vogel
    bird_eye: float = 0.0           # experimentell
    max_output_mp: float = 250.0

    def apply_preset(self, name: str) -> "Settings":
        for k, v in PRESETS[name].items():
            setattr(self, k, v)
        return self


ProgressFn = Callable[[float, str], None]


class Pipeline:
    def __init__(self, settings: Settings | None = None, log=print):
        self.s = settings or Settings()
        self.log = log
        self.device = get_device()
        self.store: ModelStore | None = None
        self.detector: B.BirdDetector | None = None
        self.last_birds: list[B.Bird] = []
        self.bird_crops: list[np.ndarray] = []
        self.ai = self._resolve_engine()
        if self.ai:
            self.store = ModelStore(self.device, log=log)
        self.tile = self.s.tile or default_tile(self.device)

    # ------------------------------------------------------------------ Hilfen
    def _resolve_engine(self) -> bool:
        if self.s.engine == "classic":
            return False
        if not torch_available():
            if self.s.engine == "ai":
                raise RuntimeError("Engine 'ai' gewählt, aber PyTorch ist nicht installiert.")
            self.log("PyTorch nicht gefunden -> klassischer Modus.")
            return False
        return True

    def _progress(self, cb: ProgressFn | None, lo: float, hi: float, text: str):
        if cb is None:
            return lambda f: None
        return lambda f: cb(lo + (hi - lo) * f, text)

    # ------------------------------------------------------------------ Schritte
    def _denoise_full(self, img: np.ndarray, prog) -> np.ndarray:
        if self.ai and not self.s.fast_denoise:
            return tiled_apply(lambda p: self.store.run("scunet", p), img,
                               tile=self.tile, overlap=16, progress=prog)
        return classic.denoise(img, 1.0)

    def _upscale(self, img: np.ndarray, scale: int, prog) -> np.ndarray:
        if scale == 1:
            return img
        if not self.ai:
            return classic.resize(img, scale)
        key = self.s.upscale_model

        def fn(p: np.ndarray) -> np.ndarray:
            out = self.store.run(key, p)               # x4
            if scale != 4:
                out = classic.resize_to(out, p.shape[1] * scale, p.shape[0] * scale)
            return out

        return tiled_apply(fn, img, tile=self.tile, overlap=16, scale=scale, progress=prog)

    def _upscale_crop(self, crop: np.ndarray, f: int) -> np.ndarray:
        """Ausschnitt um Faktor f (1..4, auch 3) vergrößern."""
        if f == 1:
            return crop
        if not self.ai:
            return classic.resize(crop, f)
        # Vogel-Ausschnitte sind klein -> hier lohnt sich das große, detailreichere Modell.
        # Bei großen Ausschnitten (> 1,5 MP) wäre es auf der CPU zu langsam.
        key = "x4plus" if crop.shape[0] * crop.shape[1] <= 1.5e6 else self.s.upscale_model

        def fn(p: np.ndarray) -> np.ndarray:
            out = self.store.run(key, p)
            return out if f == 4 else classic.resize_to(out, p.shape[1] * f, p.shape[0] * f)

        return tiled_apply(fn, crop, tile=self.tile, overlap=16, scale=f)

    # ------------------------------------------------------------------ Vogelerkennung
    def _find_birds(self, img: np.ndarray, cb: ProgressFn | None) -> list[B.Bird]:
        found: list[B.Bird] = []
        if self.s.bird_boxes:
            for box in self.s.bird_boxes:
                found.append(B.bird_from_box(img, tuple(int(v) for v in box)))
            return found
        if not torch_available():
            self.log("Vogelerkennung braucht PyTorch - übersprungen.")
            return found
        if self.detector is None:
            self.detector = B.BirdDetector(self.device, log=self.log)
        prog = self._progress(cb, 0.05, 0.25, "Vögel suchen")
        found = self.detector.detect(img, mode=self.s.bird_mode, progress=prog)
        self.log(f"{len(found)} Vogel/Vögel erkannt.")
        return found

    @staticmethod
    def _union_mask(shape_hw, found: list[B.Bird]) -> np.ndarray:
        m = np.zeros(shape_hw, np.float32)
        for b in found:
            x0, y0, x1, y1 = b.box
            m[y0:y1, x0:x1] = np.maximum(m[y0:y1, x0:x1], b.mask)
        k = max(3, int(0.004 * max(shape_hw)) | 1)
        return cv2.GaussianBlur(m, (0, 0), k)

    # ------------------------------------------------------------------ Hauptablauf
    def run(self, img: np.ndarray, exif: dict | None = None,
            cb: ProgressFn | None = None) -> np.ndarray:
        s = self.s
        if s.upscale not in (1, 2, 4):
            raise ValueError("upscale muss 1, 2 oder 4 sein.")
        H, W = img.shape[:2]
        if H * W * s.upscale ** 2 / 1e6 > s.max_output_mp:
            raise ValueError(
                f"Ergebnis wäre {H * W * s.upscale ** 2 / 1e6:.0f} MP (Limit {s.max_output_mp:.0f} MP). "
                "Kleineren Upscale-Faktor wählen.")
        self.bird_crops = []

        if s.lens and exif:
            img = lens.correct(img, exif, self.log)

        # 1) Vögel finden
        found: list[B.Bird] = []
        if s.birds:
            found = self._find_birds(img, cb)
        self.last_birds = found
        bird_mask = self._union_mask(img.shape[:2], found) if found else None

        # 2) Entrauschen (Stärke ortsabhängig: Hintergrund stärker, Vogel schonender)
        base = float(s.denoise)
        if found:
            bg_strength = min(1.0, base + s.bird_bg_denoise)
            bird_strength = base * 0.6
            smap = bird_strength * bird_mask + bg_strength * (1.0 - bird_mask)
        else:
            smap = None
        if max(base, float(smap.max()) if smap is not None else 0.0) > 0.01:
            den = self._denoise_full(img, self._progress(cb, 0.25, 0.55, "Entrauschen"))
            w = smap[..., None] if smap is not None else base
            img = img + w * (den - img)
        else:
            self.log("Entrauschen übersprungen (Stärke 0).")
        base_img = img  # entrauscht, noch in Originalgröße

        # 3) Upscaling
        scale = s.upscale
        out = self._upscale(img, scale, self._progress(cb, 0.55, 0.8, "Upscaling"))

        # 4) Schärfen (Hintergrund etwas weniger, Vogel bekommt den Extra-Pass unten)
        if s.sharpen > 0:
            sharp = classic.unsharp(out, amount=s.sharpen, radius=0.8 * math.sqrt(scale))
            if bird_mask is not None:
                wm = cv2.resize(bird_mask, (out.shape[1], out.shape[0]), interpolation=cv2.INTER_LINEAR)
                wmap = (0.5 + 0.5 * wm)[..., None]
                out = out + wmap * (sharp - out)
            else:
                out = sharp
        if cb:
            cb(0.82, "Vögel bearbeiten" if found else "Fertigstellen")

        # 5) Vogel-Detailpass
        for i, bird in enumerate(found):
            out = self._bird_pass(base_img, out, bird, scale)
            if cb:
                cb(0.82 + 0.16 * (i + 1) / len(found), f"Vogel {i + 1}/{len(found)}")

        if cb:
            cb(1.0, "Fertig")
        return np.clip(out, 0.0, 1.0).astype(np.float32)

    # ------------------------------------------------------------------ Vogel-Pass
    def _bird_pass(self, base_img: np.ndarray, out: np.ndarray, bird: B.Bird, scale: int) -> np.ndarray:
        s = self.s
        H, W = base_img.shape[:2]
        x0, y0, x1, y1 = bird.box
        m = int(0.12 * bird.size) + 4
        region = (max(0, x0 - m), max(0, y0 - m), min(W, x1 + m), min(H, y1 + m))
        rx0, ry0, rx1, ry1 = region
        crop = np.ascontiguousarray(base_img[ry0:ry1, rx0:rx1])
        mask = B.full_mask(bird, region)

        # Arbeitsvergrößerung: mindestens der globale Faktor, bei kleinen Vögeln mehr
        need = math.ceil(s.bird_target_px / max(bird.size, 1))
        f = int(min(4, max(scale, need)))
        crop_up = self._upscale_crop(crop, f)
        mask_up = cv2.resize(mask, (crop_up.shape[1], crop_up.shape[0]), interpolation=cv2.INTER_LINEAR)
        soft = B.feather(mask_up, bird.size * f)

        enhanced = B.enhance_detail(crop_up, soft, s.bird_detail)
        if s.bird_eye > 0:
            eye = B.find_eye(enhanced, mask_up)
            enhanced = B.boost_eye(enhanced, eye, s.bird_eye)

        # Arbeitsstück (mit Rand) für den Export einzelner Vogelbilder merken
        self.bird_crops.append(np.clip(enhanced, 0, 1).copy())

        # zurück auf die Ausgabegröße und mit weicher Maske einsetzen
        tw, th = (rx1 - rx0) * scale, (ry1 - ry0) * scale
        enh_t = classic.resize_to(enhanced, tw, th) if (enhanced.shape[1], enhanced.shape[0]) != (tw, th) else enhanced
        soft_t = cv2.resize(soft, (tw, th), interpolation=cv2.INTER_LINEAR)[..., None]
        sl = (slice(ry0 * scale, ry1 * scale), slice(rx0 * scale, rx1 * scale))
        out[sl] = out[sl] * (1.0 - soft_t) + enh_t * soft_t
        return out
