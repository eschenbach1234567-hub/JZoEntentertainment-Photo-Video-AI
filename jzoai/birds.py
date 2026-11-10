"""Vogel-Modul: Erkennung, Freistellmaske und gezielte Detailarbeit.

Erkennung: Mask R-CNN (torchvision, BSD-Lizenz, COCO-Klasse "bird").
Für sehr kleine Vögel, die der Detektor übersieht, gibt es die manuelle Variante:
Rechteck aufziehen -> Maske per GrabCut (funktioniert in jeder Auflösung).
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from . import classic
from .device import get_device


@dataclass
class Bird:
    box: tuple[int, int, int, int]  # x0, y0, x1, y1 im Originalbild (x1/y1 exklusiv)
    mask: np.ndarray                # float32, Form (y1-y0, x1-x0), Werte 0..1
    score: float = 1.0

    @property
    def size(self) -> int:
        x0, y0, x1, y1 = self.box
        return max(x1 - x0, y1 - y0)


# --------------------------------------------------------------------------- Erkennung

class BirdDetector:
    def __init__(self, device=None, min_score: float = 0.5, log=print):
        import torch  # noqa: F401
        from torchvision.models.detection import (MaskRCNN_ResNet50_FPN_V2_Weights,
                                                  maskrcnn_resnet50_fpn_v2)
        self.device = device if device is not None else get_device()
        self.min_score = min_score
        self.log = log
        weights = MaskRCNN_ResNet50_FPN_V2_Weights.DEFAULT
        self.bird_id = weights.meta["categories"].index("bird")
        self.model = maskrcnn_resnet50_fpn_v2(weights=weights, box_score_thresh=0.3)
        self.model.eval().to(self.device)

    def _run(self, patch: np.ndarray, min_size: int, max_size: int):
        import torch

        self.model.transform.min_size = (min_size,)
        self.model.transform.max_size = max_size
        t = torch.from_numpy(np.ascontiguousarray(patch)).permute(2, 0, 1).to(self.device)
        with torch.inference_mode():
            out = self.model([t])[0]
        keep = (out["labels"] == self.bird_id) & (out["scores"] >= self.min_score)
        boxes = out["boxes"][keep].cpu().numpy()
        scores = out["scores"][keep].cpu().numpy()
        masks = out["masks"][keep, 0].cpu().numpy()
        return boxes, scores, masks

    @staticmethod
    def _to_bird(box, mask_full, score, ox=0, oy=0, sx=1.0, sy=1.0, full_hw=None) -> Bird | None:
        """Wandelt eine Detektion (in Patch-Koordinaten) in eine Bird im Originalbild."""
        H, W = full_hw
        x0, y0, x1, y1 = box
        x0, x1 = int(np.floor(x0 / sx)) + ox, int(np.ceil(x1 / sx)) + ox
        y0, y1 = int(np.floor(y0 / sy)) + oy, int(np.ceil(y1 / sy)) + oy
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None
        # Maske des Patches auf die Box im Originalbild bringen
        mh, mw = mask_full.shape
        mx0, mx1 = int(np.floor((x0 - ox) * sx)), int(np.ceil((x1 - ox) * sx))
        my0, my1 = int(np.floor((y0 - oy) * sy)), int(np.ceil((y1 - oy) * sy))
        mx0, my0 = max(0, mx0), max(0, my0)
        mx1, my1 = min(mw, max(mx1, mx0 + 1)), min(mh, max(my1, my0 + 1))
        m = mask_full[my0:my1, mx0:mx1]
        m = cv2.resize(m, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR)
        return Bird((x0, y0, x1, y1), np.clip(m, 0, 1).astype(np.float32), float(score))

    def detect(self, img: np.ndarray, mode: str = "fast", progress=None) -> list[Bird]:
        """mode='fast': ein Durchlauf auf verkleinertem Bild (findet mittelgroße/große Vögel).
        mode='thorough': zusätzlich Kacheln in Originalauflösung (findet auch kleine Vögel,
        auf der CPU deutlich langsamer)."""
        H, W = img.shape[:2]
        birds: list[Bird] = []

        # 1) Gesamtbild auf max. 1600 px
        s = min(1.0, 1600.0 / max(H, W))
        small = cv2.resize(img, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA) if s < 1 else img
        boxes, scores, masks = self._run(small, min_size=800, max_size=1333 if s < 1 else 1600)
        for b, sc, m in zip(boxes, scores, masks):
            bird = self._to_bird(b, m, sc, sx=s, sy=s, full_hw=(H, W))
            if bird:
                birds.append(bird)
        if progress:
            progress(0.3 if mode == "thorough" else 1.0)

        # 2) Kacheln in Originalauflösung für kleine Vögel
        if mode == "thorough":
            tile, step = 1024, 768
            ys = list(range(0, max(H - tile, 0) + 1, step)) or [0]
            xs = list(range(0, max(W - tile, 0) + 1, step)) or [0]
            if H > tile and ys[-1] + tile < H:
                ys.append(H - tile)
            if W > tile and xs[-1] + tile < W:
                xs.append(W - tile)
            total, done = len(ys) * len(xs), 0
            for y in ys:
                for x in xs:
                    patch = img[y:y + tile, x:x + tile]
                    ph, pw = patch.shape[:2]
                    b_, s_, m_ = self._run(patch, min_size=max(ph, pw), max_size=max(ph, pw))
                    for b, sc, m in zip(b_, s_, m_):
                        bird = self._to_bird(b, m, sc, ox=x, oy=y, full_hw=(H, W))
                        if bird:
                            birds.append(bird)
                    done += 1
                    if progress:
                        progress(0.3 + 0.7 * done / total)

        return self._merge(birds)

    @staticmethod
    def _merge(birds: list[Bird]) -> list[Bird]:
        """Doppelte Treffer (gleiche Box aus mehreren Durchläufen) entfernen."""
        if len(birds) < 2:
            return birds
        import torch
        from torchvision.ops import nms

        boxes = torch.tensor([b.box for b in birds], dtype=torch.float32)
        scores = torch.tensor([b.score for b in birds], dtype=torch.float32)
        keep = nms(boxes, scores, iou_threshold=0.4).tolist()
        return [birds[i] for i in keep]


# --------------------------------------------------------------------------- manuell

def bird_from_box(img: np.ndarray, box: tuple[int, int, int, int], iters: int = 4) -> Bird:
    """Maske für einen vom Nutzer markierten Vogel per GrabCut (auch für winzige Vögel)."""
    H, W = img.shape[:2]
    x0, y0, x1, y1 = box
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    bw, bh = x1 - x0, y1 - y0
    if bw < 4 or bh < 4:
        raise ValueError("Markierter Bereich ist zu klein.")
    pad = int(0.25 * max(bw, bh)) + 4
    rx0, ry0 = max(0, x0 - pad), max(0, y0 - pad)
    rx1, ry1 = min(W, x1 + pad), min(H, y1 + pad)
    region = np.ascontiguousarray((np.clip(img[ry0:ry1, rx0:rx1], 0, 1) * 255).astype(np.uint8)[:, :, ::-1])
    s = min(1.0, 1000.0 / max(region.shape[:2]))
    small = cv2.resize(region, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else region
    rect = (int((x0 - rx0) * s), int((y0 - ry0) * s), max(2, int(bw * s)), max(2, int(bh * s)))
    mask = np.zeros(small.shape[:2], np.uint8)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(small, mask, rect, bgd, fgd, iters, cv2.GC_INIT_WITH_RECT)
        fg = ((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD)).astype(np.float32)
    except cv2.error:
        fg = np.zeros(small.shape[:2], np.float32)
        fg[rect[1]:rect[1] + rect[3], rect[0]:rect[0] + rect[2]] = 1.0
    if fg.sum() < 0.05 * rect[2] * rect[3]:  # GrabCut hat versagt -> Ellipse als Notlösung
        fg[:] = 0
        cv2.ellipse(fg, (rect[0] + rect[2] // 2, rect[1] + rect[3] // 2),
                    (rect[2] // 2, rect[3] // 2), 0, 0, 360, 1.0, -1)
    fg = cv2.resize(fg, (region.shape[1], region.shape[0]), interpolation=cv2.INTER_LINEAR)
    return Bird((x0, y0, x1, y1), fg[y0 - ry0:y1 - ry0, x0 - rx0:x1 - rx0].copy(), 1.0)


# --------------------------------------------------------------------------- Maske / Detail

def full_mask(bird: Bird, region: tuple[int, int, int, int]) -> np.ndarray:
    """Vogelmaske in den Koordinaten eines (größeren) Ausschnitts."""
    rx0, ry0, rx1, ry1 = region
    m = np.zeros((ry1 - ry0, rx1 - rx0), np.float32)
    x0, y0, x1, y1 = bird.box
    m[y0 - ry0:y1 - ry0, x0 - rx0:x1 - rx0] = bird.mask
    return m


def feather(mask: np.ndarray, size_px: int) -> np.ndarray:
    """Maske leicht schrumpfen und weichzeichnen -> keine Säume beim Zurückkomponieren."""
    k = max(1, int(size_px * 0.004))
    if k > 1:
        mask = cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * k + 1, 2 * k + 1)))
    sigma = max(1.0, size_px * 0.006)
    return np.clip(cv2.GaussianBlur(mask, (0, 0), sigma), 0, 1)


def enhance_detail(crop: np.ndarray, mask: np.ndarray, strength: float) -> np.ndarray:
    """Federn herausarbeiten: Mehrskalen-Schärfung + Mikrokontrast, nur innerhalb der Maske.

    Radien richten sich nach der Vogelgröße im Ausschnitt, damit das Ergebnis bei jeder
    Auflösung ähnlich aussieht.
    """
    if strength <= 0:
        return crop
    ys, xs = np.where(mask > 0.5)
    if len(ys) == 0:
        return crop
    size = max(ys.max() - ys.min(), xs.max() - xs.min()) + 1
    fine = max(0.7, size / 900.0)
    mid = max(1.5, size / 250.0)

    out = crop
    out = classic.unsharp(out, amount=0.9 * strength, radius=fine, noise_floor=0.003)
    out = classic.unsharp(out, amount=0.45 * strength, radius=mid, noise_floor=0.004)

    # CLAHE auf der Helligkeit (16 Bit), holt Federstruktur aus flachen Bereichen
    ycc = cv2.cvtColor(out, cv2.COLOR_RGB2YCrCb)
    y16 = np.clip(ycc[..., 0] * 65535.0, 0, 65535).astype(np.uint16)
    grid = int(np.clip(size // 120, 4, 12))
    clahe = cv2.createCLAHE(clipLimit=1.0 + 2.0 * strength, tileGridSize=(grid, grid))
    ycc[..., 0] = clahe.apply(y16).astype(np.float32) / 65535.0
    out = np.clip(cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB), 0, 1)

    a = mask[..., None]
    return crop * (1.0 - a) + out * a


def find_eye(crop: np.ndarray, mask: np.ndarray):
    """EXPERIMENTELL: sucht den dunkelsten Fleck im Kopfbereich. Bei dunklem Gefieder
    (z. B. Krähen) kann das danebenliegen -> standardmäßig abgeschaltet."""
    ys, xs = np.where(mask > 0.9)
    if len(ys) == 0:
        return None
    y0, y1 = ys.min(), ys.max()
    size = max(y1 - y0, xs.max() - xs.min()) + 1
    band = np.zeros_like(mask, bool)
    band[y0:y0 + int(0.45 * (y1 - y0 + 1)), :] = True
    gray = cv2.GaussianBlur(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), (0, 0), max(1.0, size / 150.0))
    cand = np.where(band & (mask > 0.9), gray, np.inf)
    idx = np.unravel_index(np.argmin(cand), cand.shape)
    if not np.isfinite(cand[idx]):
        return None
    return int(idx[1]), int(idx[0]), max(3, int(size / 55))


def boost_eye(crop: np.ndarray, eye, amount: float) -> np.ndarray:
    if eye is None or amount <= 0:
        return crop
    ex, ey, r = eye
    h, w = crop.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    falloff = np.exp(-(((xx - ex) ** 2 + (yy - ey) ** 2) / (2.0 * (2.0 * r) ** 2))).astype(np.float32)
    sharp = classic.unsharp(crop, amount=1.2 * amount, radius=max(0.7, r / 6.0), noise_floor=0.002)
    sharp = classic.clarity(sharp, amount=0.5 * amount, radius=max(2.0, r))
    a = falloff[..., None]
    return crop * (1 - a) + sharp * a
