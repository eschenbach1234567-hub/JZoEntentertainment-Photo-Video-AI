"""Klassische Bildverarbeitung (ohne KI): Fallback und Hilfsfunktionen."""
from __future__ import annotations

import cv2
import numpy as np


def _to_ycc(img: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(img, cv2.COLOR_RGB2YCrCb)


def _from_ycc(ycc: np.ndarray) -> np.ndarray:
    return np.clip(cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB), 0.0, 1.0)


def denoise(img: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Non-Local-Means-Entrauschen (nur 8 Bit intern, daher nur Fallback)."""
    strength = float(np.clip(strength, 0.0, 1.0))
    if strength <= 0.0:
        return img
    u8 = (np.clip(img, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    bgr = cv2.cvtColor(u8, cv2.COLOR_RGB2BGR)
    h = 2.0 + 10.0 * strength
    out = cv2.fastNlMeansDenoisingColored(bgr, None, h, h * 1.2, 7, 21)
    rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    return rgb


def unsharp(img: np.ndarray, amount: float = 0.5, radius: float = 1.0,
            noise_floor: float = 0.004) -> np.ndarray:
    """Schärfen nur auf der Helligkeit; sehr feines Rauschen wird nicht verstärkt."""
    if amount <= 0:
        return img
    ycc = _to_ycc(img)
    y = ycc[..., 0]
    blur = cv2.GaussianBlur(y, (0, 0), radius)
    detail = y - blur
    # weiches Rausch-Gate: kleine Differenzen werden abgeschwächt
    gate = np.clip((np.abs(detail) - noise_floor) / (noise_floor * 2.0), 0.0, 1.0)
    ycc[..., 0] = y + amount * 1.5 * detail * gate
    return _from_ycc(ycc)


def clarity(img: np.ndarray, amount: float = 0.2, radius: float = 20.0) -> np.ndarray:
    """Mikrokontrast auf mittleren Strukturen."""
    if amount <= 0:
        return img
    ycc = _to_ycc(img)
    y = ycc[..., 0]
    ycc[..., 0] = y + amount * (y - cv2.GaussianBlur(y, (0, 0), radius))
    return _from_ycc(ycc)


def resize(img: np.ndarray, scale: float) -> np.ndarray:
    h, w = img.shape[:2]
    size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    interp = cv2.INTER_LANCZOS4 if scale > 1 else cv2.INTER_AREA
    return cv2.resize(img, size, interpolation=interp)


def resize_to(img: np.ndarray, width: int, height: int) -> np.ndarray:
    h, w = img.shape[:2]
    interp = cv2.INTER_LANCZOS4 if (width * height) > (w * h) else cv2.INTER_AREA
    return cv2.resize(img, (width, height), interpolation=interp)
