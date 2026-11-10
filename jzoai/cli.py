"""Kommandozeile:  python -m jzoai --help"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from . import __version__, device, models
from .pipeline import PRESETS, Pipeline, Settings
from .rawio import is_supported, load_image, read_exif, save_image


def _parse_box(text: str):
    try:
        x0, y0, x1, y1 = (int(v) for v in text.split(","))
        return (x0, y0, x1, y1)
    except Exception:
        raise argparse.ArgumentTypeError("Format: x0,y0,x1,y1  (Pixel im Originalbild)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="jzoai", description="JZoEntertainment Photo/Video AI - Foto-Veredelung mit Vogel-Modus")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="Installation und Rechengerät prüfen")

    m = sub.add_parser("models", help="KI-Modelle herunterladen")
    m.add_argument("names", nargs="*", help=f"Namen ({', '.join(models.REGISTRY)}); leer = Standardsatz")

    f = sub.add_parser("photo", help="Foto(s) verarbeiten (RAW, JPG, TIFF, PNG)")
    f.add_argument("input", type=Path, help="Datei oder Ordner")
    f.add_argument("-o", "--output", type=Path, help="Zieldatei bzw. Zielordner")
    f.add_argument("--preset", choices=list(PRESETS), help="Startwerte; Einzelwerte überschreiben sie")
    f.add_argument("--engine", choices=["auto", "ai", "classic"], default=None)
    f.add_argument("--denoise", type=float, help="0..1")
    f.add_argument("--sharpen", type=float, help="0..1")
    f.add_argument("--upscale", type=int, choices=[1, 2, 4])
    f.add_argument("--quality", choices=["fast", "best"], help="Upscaling-Modell: fast=schnell, best=beste Qualität")
    f.add_argument("--fast-denoise", action="store_true",
                   help="klassisches statt KI-Entrauschen (viel schneller auf CPU, etwas weniger Qualität)")
    f.add_argument("--no-lens", action="store_true", help="Objektivkorrektur aus")
    f.add_argument("--tile", type=int, help="Kachelgröße (kleiner = weniger Speicher)")
    g = f.add_argument_group("Vogel-Modus")
    g.add_argument("--birds", action="store_true", help="Vögel erkennen und gezielt bearbeiten")
    g.add_argument("--bird-mode", choices=["fast", "thorough"], help="thorough findet auch kleine Vögel (langsam)")
    g.add_argument("--bird-box", type=_parse_box, action="append", default=[],
                   help="Vogel manuell markieren: x0,y0,x1,y1 (mehrfach möglich)")
    g.add_argument("--bird-detail", type=float, help="Federdetail 0..1")
    g.add_argument("--bird-bg-denoise", type=float, help="Zusatz-Entrauschen Hintergrund 0..1")
    g.add_argument("--bird-target", type=int, help="Arbeitsgröße des Vogels in Pixeln (lange Kante)")
    g.add_argument("--bird-eye", type=float, help="Augen-Boost 0..1 (experimentell)")
    g.add_argument("--bird-crops", type=Path, help="Ordner, in den jeder Vogel einzeln gespeichert wird")
    o = f.add_argument_group("Ausgabe")
    o.add_argument("--format", choices=["tif", "png", "jpg"], default="tif")
    o.add_argument("--jpeg-quality", type=int, default=95)
    o.add_argument("--8bit", dest="eight", action="store_true", help="TIFF/PNG mit 8 statt 16 Bit")

    v = sub.add_parser("video", help="Video(s) verarbeiten: Upscaling, Entrauschen, Stabilisieren, Bildrate")
    v.add_argument("input", type=Path, help="Datei oder Ordner")
    v.add_argument("-o", "--output", type=Path, help="Zieldatei bzw. Zielordner")
    v.add_argument("--engine", choices=["fast", "ki"], default="fast",
                   help="fast = ffmpeg-Filter (schnell), ki = Real-ESRGAN pro Frame (sehr langsam auf CPU)")
    v.add_argument("--upscale", type=float, default=2.0, help="Faktor (fast: beliebig, ki: 2 oder 4)")
    v.add_argument("--quality", choices=["fast", "best"], default="fast", help="KI-Modell (nur --engine ki)")
    v.add_argument("--denoise", type=float, default=0.4, help="0..1")
    v.add_argument("--sharpen", type=float, default=0.3, help="0..1")
    v.add_argument("--stabilize", action="store_true", help="Verwacklungen glätten")
    v.add_argument("--smoothing", type=int, default=15, help="Stabilisierung: Glättung in Frames")
    v.add_argument("--fps", type=float, help="Ziel-Bildrate, z. B. 60 (berechnet Zwischenbilder)")
    v.add_argument("--interp", choices=["mci", "blend"], default="mci",
                   help="mci = bewegungsbasiert (besser, langsam), blend = Überblendung (schnell)")
    v.add_argument("--codec", choices=["x264", "x265", "videotoolbox"], default="x264")
    v.add_argument("--crf", type=int, default=16, help="Qualität, kleiner = besser/größer")
    v.add_argument("--start", type=float, default=0.0, help="Startzeit in Sekunden")
    v.add_argument("--seconds", type=float, help="Nur diese Länge verarbeiten (zum Testen empfohlen)")
    v.add_argument("--tile", type=int, help="Kachelgröße für KI (kleiner = weniger Speicher)")
    return p


def _settings_from_args(a) -> Settings:
    s = Settings()
    if a.preset:
        s.apply_preset(a.preset)
    if a.engine:
        s.engine = a.engine
    for name in ("denoise", "sharpen", "upscale", "tile"):
        v = getattr(a, name)
        if v is not None:
            setattr(s, name, v)
    if a.quality:
        s.upscale_model = "x4plus" if a.quality == "best" else "general"
    if a.no_lens:
        s.lens = False
    if a.fast_denoise:
        s.fast_denoise = True
    if a.birds:
        s.birds = True
    if a.bird_box:
        s.birds, s.bird_boxes = True, list(a.bird_box)
    for arg, attr in (("bird_mode", "bird_mode"), ("bird_detail", "bird_detail"),
                      ("bird_bg_denoise", "bird_bg_denoise"), ("bird_target", "bird_target_px"),
                      ("bird_eye", "bird_eye")):
        v = getattr(a, arg)
        if v is not None:
            setattr(s, attr, v)
    return s


def _collect(inp: Path) -> list[Path]:
    if inp.is_dir():
        return sorted(p for p in inp.iterdir() if p.is_file() and is_supported(p))
    return [inp]


def cmd_photo(a) -> int:
    settings = _settings_from_args(a)
    files = _collect(a.input)
    if not files:
        print("Keine unterstützten Bilddateien gefunden.", file=sys.stderr)
        return 1
    ext = {"tif": ".tif", "png": ".png", "jpg": ".jpg"}[a.format]
    pipe = Pipeline(settings)
    print(device.describe())

    for i, src in enumerate(files, 1):
        if a.output and len(files) == 1 and a.output.suffix:
            dst = a.output
        else:
            out_dir = a.output or (src.parent / "jzoai_out")
            dst = out_dir / (src.stem + "_jzo" + ext)
        t0 = time.time()
        last = {"t": 0.0}

        def cb(frac: float, text: str, _i=i):
            now = time.time()
            if now - last["t"] > 1.0 or frac >= 1.0:
                last["t"] = now
                print(f"\r[{_i}/{len(files)}] {src.name}: {text} {frac * 100:3.0f}%   ", end="", flush=True)

        try:
            img = load_image(src)
            exif = read_exif(src) if settings.lens else None
            res = pipe.run(img, exif=exif, cb=cb)
            save_image(res, dst, quality=a.jpeg_quality, bit16=not a.eight, copy_exif_from=src)
            if a.bird_crops and pipe.bird_crops:
                for n, crop in enumerate(pipe.bird_crops, 1):
                    save_image(crop, a.bird_crops / f"{src.stem}_vogel{n}.png", bit16=not a.eight)
            print(f"\r[{i}/{len(files)}] {src.name} -> {dst}  ({time.time() - t0:.0f} s)            ")
        except Exception as exc:
            print(f"\n[{i}/{len(files)}] {src.name}: FEHLER: {exc}", file=sys.stderr)
    return 0


def cmd_video(a) -> int:
    from . import video as V

    try:
        V.require_ffmpeg()
    except V.VideoError as exc:
        print(exc, file=sys.stderr)
        return 1
    s = V.VideoSettings(
        engine=a.engine, upscale=a.upscale, upscale_model="x4plus" if a.quality == "best" else "general",
        denoise=a.denoise, sharpen=a.sharpen, stabilize=a.stabilize, stabilize_smoothing=a.smoothing,
        fps=a.fps, interp=a.interp, codec=a.codec, crf=a.crf, start=a.start, seconds=a.seconds, tile=a.tile)
    files = sorted(p for p in a.input.iterdir() if p.is_file() and V.is_video(p)) if a.input.is_dir() else [a.input]
    if not files:
        print("Keine Videodateien gefunden.", file=sys.stderr)
        return 1
    code = 0
    for i, src in enumerate(files, 1):
        if a.output and len(files) == 1 and a.output.suffix:
            dst = a.output
        else:
            dst = (a.output or src.parent / "jzoai_out") / (src.stem + "_jzo.mp4")
        last = {"t": 0.0}

        def cb(frac: float, text: str, _i=i, _n=src.name):
            now = time.time()
            if now - last["t"] > 1.0 or frac >= 1.0:
                last["t"] = now
                print(f"\r[{_i}/{len(files)}] {_n}: {text} {frac * 100:3.0f}%      ", end="", flush=True)

        t0 = time.time()
        try:
            V.process_video(src, dst, s, progress=cb, log=lambda m: print(f"\n{m}"))
            print(f"\r[{i}/{len(files)}] {src.name} -> {dst}  ({time.time() - t0:.0f} s)              ")
        except V.VideoError as exc:
            print(f"\n[{i}/{len(files)}] {src.name}: FEHLER: {exc}", file=sys.stderr)
            code = 1
    return code


def cmd_models(a) -> int:
    names = a.names or ["general", "scunet"]
    for n in names:
        if n not in models.REGISTRY:
            print(f"Unbekanntes Modell: {n}", file=sys.stderr)
            return 1
        models.download(n)
    print("Fertig. Modelle liegen in:", models.MODELS_DIR)
    return 0


def cmd_doctor(_a) -> int:
    print(f"JZoEntertainment Photo/Video AI {__version__}")
    print(device.describe())
    for mod in ("numpy", "cv2", "rawpy", "torch", "torchvision", "spandrel", "PySide6", "lensfunpy"):
        try:
            m = __import__(mod)
            print(f"  ok      {mod} {getattr(m, '__version__', '')}")
        except Exception:
            opt = " (optional)" if mod == "lensfunpy" else ""
            print(f"  fehlt   {mod}{opt}")
    from . import video as V
    for tool in ("ffmpeg", "ffprobe"):
        print(f"  {'ok     ' if V.find_tool(tool) else 'fehlt  '} {tool}" + ("" if V.find_tool(tool) else "  (brew install ffmpeg, nur für Video nötig)"))
    for k, v in models.REGISTRY.items():
        print(f"  Modell  {k:8s} {'vorhanden' if models.is_downloaded(k) else 'noch nicht geladen'}  - {v['desc']}")
    return 0


def main(argv=None) -> int:
    a = build_parser().parse_args(argv)
    return {"photo": cmd_photo, "video": cmd_video, "models": cmd_models, "doctor": cmd_doctor}[a.cmd](a)


if __name__ == "__main__":
    raise SystemExit(main())
