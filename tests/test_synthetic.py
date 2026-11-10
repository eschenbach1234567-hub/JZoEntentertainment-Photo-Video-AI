"""Rauchtest ohne KI-Modelle: synthetisches, verrauschtes Bild mit "Vogel" (Ellipse mit Federtextur)."""
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jzoai.pipeline import Pipeline, Settings  # noqa: E402
from jzoai.rawio import load_image, save_image  # noqa: E402


def make_scene(w=1200, h=800, seed=1):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    bg = np.stack([0.35 + 0.2 * xx / w, 0.5 + 0.1 * yy / h, 0.3 + 0.1 * np.sin(xx / 90)], -1)
    img = bg.copy()
    # "Vogel": Ellipse mit feiner Streifentextur ("Federn")
    cx, cy, a, b = 700, 420, 90, 50
    inside = (((xx - cx) / a) ** 2 + ((yy - cy) / b) ** 2) < 1
    tex = 0.5 + 0.25 * np.sin((xx + yy) / 2.2) * np.sin((xx - yy) / 3.1)
    bird = np.stack([tex * 0.8, tex * 0.6, tex * 0.4], -1)
    img[inside] = bird[inside]
    clean = img.copy()
    noisy = np.clip(img + rng.normal(0, 0.05, img.shape).astype(np.float32), 0, 1)
    box = (cx - a - 6, cy - b - 6, cx + a + 6, cy + b + 6)
    return clean.astype(np.float32), noisy.astype(np.float32), box


def psnr(a, b):
    mse = float(np.mean((a - b) ** 2))
    return 10 * np.log10(1.0 / max(mse, 1e-12))


def main():
    clean, noisy, box = make_scene()
    out_dir = Path(__file__).resolve().parent / "out"
    out_dir.mkdir(exist_ok=True)

    # 1) Entrauschen + Schärfen (klassisch)
    s = Settings(engine="classic", denoise=0.6, sharpen=0.3, lens=False)
    res = Pipeline(s, log=lambda *_: None).run(noisy)
    assert res.shape == noisy.shape
    print(f"PSNR verrauscht : {psnr(noisy, clean):.2f} dB")
    print(f"PSNR bearbeitet : {psnr(res, clean):.2f} dB")
    assert psnr(res, clean) > psnr(noisy, clean), "Entrauschen hat nicht verbessert"

    # 2) Vogel-Modus mit manueller Markierung, 2x Upscale
    s = Settings(engine="classic", denoise=0.5, upscale=2, birds=True, bird_boxes=[box],
                 bird_detail=0.7, bird_bg_denoise=0.4, bird_target_px=600, lens=False)
    pipe = Pipeline(s, log=lambda *_: None)
    res2 = pipe.run(noisy)
    assert res2.shape == (noisy.shape[0] * 2, noisy.shape[1] * 2, 3), res2.shape
    assert len(pipe.last_birds) == 1 and len(pipe.bird_crops) == 1
    assert np.isfinite(res2).all() and res2.min() >= 0 and res2.max() <= 1
    print("Vogel-Modus 2x   :", res2.shape, "| Vogel-Arbeitsstück:", pipe.bird_crops[0].shape)

    # 3) Ein-/Ausgabe (16 Bit TIFF) Roundtrip
    save_image(res2, out_dir / "test_bird_2x.tif")
    back = load_image(out_dir / "test_bird_2x.tif")
    assert np.abs(back - res2).max() < 2e-4
    save_image(noisy, out_dir / "noisy.png", bit16=False)
    save_image(res, out_dir / "denoised.png", bit16=False)
    save_image(pipe.bird_crops[0], out_dir / "bird_crop.png", bit16=False)

    # 4) Fehlerfälle
    try:
        Pipeline(Settings(engine="classic", upscale=3, lens=False), log=lambda *_: None).run(noisy)
        raise SystemExit("upscale=3 hätte abgelehnt werden müssen")
    except ValueError:
        pass
    print("ALLE TESTS BESTANDEN")


if __name__ == "__main__":
    main()
