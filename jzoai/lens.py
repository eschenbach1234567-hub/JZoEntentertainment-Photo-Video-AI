"""Objektivkorrektur (Verzeichnung, Vignettierung, CA) über die offene lensfun-Datenbank.

Optional: benötigt `pip install lensfunpy` und `brew install exiftool`.
Wird still übersprungen, wenn etwas fehlt oder das Objektiv nicht in der Datenbank steht.
"""
from __future__ import annotations

import cv2
import numpy as np


def correct(img: np.ndarray, exif: dict, log=print) -> np.ndarray:
    try:
        import lensfunpy
    except ImportError:
        return img
    make, model = exif.get("Make"), exif.get("Model")
    lens_name = exif.get("LensModel") or exif.get("LensID") or exif.get("Lens")
    focal, aperture = exif.get("FocalLength"), exif.get("FNumber")
    if not (make and model and lens_name and focal and aperture):
        return img
    try:
        db = lensfunpy.Database()
        cams = db.find_cameras(str(make), str(model))
        if not cams:
            log(f"Objektivkorrektur: Kamera '{make} {model}' nicht in lensfun.")
            return img
        cam = cams[0]
        lenses = db.find_lenses(cam, lens=str(lens_name))
        if not lenses:
            log(f"Objektivkorrektur: Objektiv '{lens_name}' nicht in lensfun.")
            return img
        lens = lenses[0]
        h, w = img.shape[:2]
        mod = lensfunpy.Modifier(lens, cam.crop_factor, w, h)
        mod.initialize(float(focal), float(aperture), pixel_format=np.float32)
        work = np.ascontiguousarray(img, dtype=np.float32)
        if mod.apply_color_modification(work):
            pass  # Vignettierung korrigiert (in-place)
        coords = mod.apply_geometry_distortion()
        work = cv2.remap(work, coords, None, cv2.INTER_LANCZOS4)
        log(f"Objektivkorrektur angewendet: {lens.maker} {lens.model}")
        return np.clip(work, 0.0, 1.0)
    except Exception as exc:  # lensfun ist heikel -> nie die ganze Verarbeitung abbrechen
        log(f"Objektivkorrektur übersprungen ({exc}).")
        return img
