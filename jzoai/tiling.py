"""Kachelweise Verarbeitung großer Bilder mit weichem Überblenden der Ränder."""
from __future__ import annotations

from typing import Callable

import numpy as np

PatchFn = Callable[[np.ndarray], np.ndarray]


def _ramp(n: int, ov: int) -> np.ndarray:
    idx = np.arange(1, n + 1)
    w = np.minimum(np.minimum(idx, idx[::-1]), max(ov, 1)) / max(ov, 1)
    return w.astype(np.float32)


def _starts(length: int, tile: int, step: int) -> list[int]:
    if length <= tile:
        return [0]
    s = list(range(0, length - tile + 1, step))
    if s[-1] + tile < length:
        s.append(length - tile)
    return s


def tiled_apply(fn: PatchFn, img: np.ndarray, tile: int = 512, overlap: int = 32,
                scale: int = 1, progress: Callable[[float], None] | None = None
                ) -> np.ndarray:
    """Wendet fn auf überlappende Kacheln an. fn: HxWx3 -> (H*scale)x(W*scale)x3."""
    h, w, _ = img.shape
    out = np.zeros((h * scale, w * scale, 3), np.float32)
    acc = np.zeros((h * scale, w * scale, 1), np.float32)
    step = max(tile - 2 * overlap, 16)
    ys, xs = _starts(h, tile, step), _starts(w, tile, step)
    total, done = len(ys) * len(xs), 0
    for y in ys:
        for x in xs:
            th, tw = min(tile, h - y), min(tile, w - x)
            patch = fn(np.ascontiguousarray(img[y:y + th, x:x + tw]))
            ph, pw = patch.shape[:2]
            wy = _ramp(ph, overlap * scale)[:, None]
            wx = _ramp(pw, overlap * scale)[None, :]
            win = (wy * wx)[..., None]
            oy, ox = y * scale, x * scale
            out[oy:oy + ph, ox:ox + pw] += patch * win
            acc[oy:oy + ph, ox:ox + pw] += win
            done += 1
            if progress:
                progress(done / total)
    return out / np.maximum(acc, 1e-6)
