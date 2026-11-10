"""Ein- und Ausgabe: RAW (rawpy) und normale Bilddateien (OpenCV).

Intern arbeiten alle Module mit float32-RGB im Bereich 0..1 (sRGB-kodiert).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np

RAW_EXT = {".arw", ".cr2", ".cr3", ".nef", ".nrw", ".orf", ".raf", ".rw2",
           ".dng", ".pef", ".srw", ".3fr", ".iiq", ".erf", ".mrw"}
IMG_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp"}


def is_supported(path: Path) -> bool:
    return path.suffix.lower() in RAW_EXT | IMG_EXT


def load_image(path: str | Path) -> np.ndarray:
    path = Path(path)
    ext = path.suffix.lower()
    if ext in RAW_EXT:
        import rawpy

        with rawpy.imread(str(path)) as raw:
            rgb16 = raw.postprocess(
                use_camera_wb=True,
                no_auto_bright=True,
                output_bps=16,
                output_color=rawpy.ColorSpace.sRGB,
                demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD,
            )
        return rgb16.astype(np.float32) / 65535.0

    data = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if data is None:
        raise ValueError(f"Datei konnte nicht gelesen werden: {path}")
    if data.ndim == 2:
        data = cv2.cvtColor(data, cv2.COLOR_GRAY2BGR)
    if data.shape[2] == 4:
        data = data[:, :, :3]
    scale = 65535.0 if data.dtype == np.uint16 else 255.0
    return cv2.cvtColor(data.astype(np.float32) / scale, cv2.COLOR_BGR2RGB)


def save_image(img: np.ndarray, path: str | Path, quality: int = 95,
               bit16: bool = True, copy_exif_from: str | Path | None = None) -> None:
    path = Path(path)
    ext = path.suffix.lower()
    img = np.clip(img, 0.0, 1.0)
    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    if ext in {".tif", ".tiff", ".png"} and bit16:
        out = (bgr * 65535.0 + 0.5).astype(np.uint16)
    else:
        out = (bgr * 255.0 + 0.5).astype(np.uint8)
    params: list[int] = []
    if ext in {".jpg", ".jpeg"}:
        params = [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), out, params):
        raise IOError(f"Speichern fehlgeschlagen: {path}")
    if copy_exif_from is not None:
        _copy_exif(copy_exif_from, path)


def _copy_exif(src: str | Path, dst: Path) -> None:
    """EXIF/IPTC per exiftool übernehmen, falls installiert (brew install exiftool)."""
    exiftool = shutil.which("exiftool")
    if not exiftool:
        return
    try:
        subprocess.run(
            [exiftool, "-overwrite_original", "-q", "-TagsFromFile", str(src),
             "-all:all", "-Orientation=", str(dst)],
            check=False, timeout=60,
        )
    except Exception:
        pass


def read_exif(path: str | Path) -> dict:
    """Kamera-/Objektivdaten per exiftool (optional)."""
    exiftool = shutil.which("exiftool")
    if not exiftool:
        return {}
    try:
        import json

        res = subprocess.run([exiftool, "-json", "-n", str(path)],
                             capture_output=True, text=True, timeout=30)
        return json.loads(res.stdout)[0]
    except Exception:
        return {}
