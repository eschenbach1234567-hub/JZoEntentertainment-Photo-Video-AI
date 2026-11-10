"""KI-Test (braucht torch + Modelle): SCUNet-Entrauschen und Real-ESRGAN-Upscaling auf CPU."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

from jzoai.pipeline import Pipeline, Settings  # noqa: E402
from test_synthetic import make_scene, psnr  # noqa: E402


def main():
    clean, noisy, box = make_scene(w=800, h=600)
    out = Path(__file__).resolve().parent / "out"
    out.mkdir(exist_ok=True)

    t0 = time.time()
    s = Settings(engine="ai", denoise=0.8, sharpen=0.2, lens=False)
    pipe = Pipeline(s)
    res = pipe.run(noisy)
    print(f"KI-Entrauschen: {time.time() - t0:.1f} s | PSNR {psnr(noisy, clean):.2f} -> {psnr(res, clean):.2f} dB")
    assert res.shape == noisy.shape and np.isfinite(res).all()
    assert psnr(res, clean) > psnr(noisy, clean) + 1.0

    t0 = time.time()
    s = Settings(engine="ai", denoise=0.5, sharpen=0.2, upscale=2, birds=True, bird_boxes=[box],
                 bird_detail=0.7, bird_bg_denoise=0.4, bird_target_px=500, lens=False)
    pipe = Pipeline(s)
    res2 = pipe.run(noisy)
    print(f"KI 2x + Vogelpass: {time.time() - t0:.1f} s | Ergebnis {res2.shape}, Vogel-Arbeitsstück {pipe.bird_crops[0].shape}")
    assert res2.shape == (noisy.shape[0] * 2, noisy.shape[1] * 2, 3)
    assert np.isfinite(res2).all() and res2.min() >= 0 and res2.max() <= 1
    from jzoai.rawio import save_image
    save_image(res2, out / "ai_bird_2x.png", bit16=False)
    print("KI-TESTS BESTANDEN")


if __name__ == "__main__":
    main()
