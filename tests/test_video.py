"""Video-Test: erzeugt einen kurzen verrauschten Clip mit Ton und prüft Schnell- und KI-Modus.

Aufruf:  python tests/test_video.py [--no-ki]
"""
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jzoai import video as V  # noqa: E402


def make_clip(path: Path, w=320, h=240, fps=25, secs=3):
    cmd = [V.require_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
           "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate={fps}:duration={secs},noise=alls=18:allf=t",
           "-f", "lavfi", "-i", f"sine=frequency=440:duration={secs}",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)]
    subprocess.run(cmd, check=True)


def main():
    use_ki = "--no-ki" not in sys.argv
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        src = tmp / "in.mp4"
        make_clip(src)
        info = V.probe(src)
        print(f"Quelle: {info.width}x{info.height} {info.fps:.2f} fps {info.duration:.1f} s Ton={info.has_audio}")
        assert (info.width, info.height) == (320, 240) and info.has_audio

        # 1) Schnellmodus: 2x, Entrauschen, Stabilisieren, 50 fps, Ton bleibt
        out = V.process_video(src, tmp / "fast.mp4", V.VideoSettings(
            engine="fast", upscale=2, denoise=0.5, sharpen=0.3, stabilize=True, fps=50, interp="blend"),
            log=lambda m: None)
        o = V.probe(out)
        print(f"fast : {o.width}x{o.height} {o.fps:.2f} fps {o.duration:.1f} s Ton={o.has_audio}")
        assert (o.width, o.height) == (640, 480)
        assert abs(o.fps - 50) < 0.5 and o.has_audio and abs(o.duration - 3) < 0.3

        # 2) Ausschnitt (start/seconds) + krummer Faktor
        out = V.process_video(src, tmp / "cut.mp4", V.VideoSettings(
            engine="fast", upscale=1.5, denoise=0, sharpen=0, start=1.0, seconds=1.0), log=lambda m: None)
        o = V.probe(out)
        print(f"cut  : {o.width}x{o.height} {o.fps:.2f} fps {o.duration:.2f} s")
        assert (o.width, o.height) == (480, 360) and abs(o.duration - 1.0) < 0.25

        # 3) Fehlerfälle
        try:
            V.process_video(tmp / "gibtsnicht.mp4", tmp / "x.mp4", V.VideoSettings(), log=lambda m: None)
            raise SystemExit("fehlende Datei hätte Fehler geben müssen")
        except V.VideoError:
            pass
        try:
            V.process_video(src, tmp / "x.mp4", V.VideoSettings(start=99), log=lambda m: None)
            raise SystemExit("Start hinter dem Ende hätte Fehler geben müssen")
        except V.VideoError:
            pass

        # 4) KI-Modus (klein halten: 2 Sekunden, 160x120 -> 320x240)
        if use_ki:
            small = tmp / "small.mp4"
            make_clip(small, w=160, h=120, fps=10, secs=2)
            out = V.process_video(small, tmp / "ki.mp4", V.VideoSettings(
                engine="ki", upscale=2, denoise=0.3, sharpen=0.2), log=print)
            o = V.probe(out)
            print(f"ki   : {o.width}x{o.height} {o.fps:.2f} fps {o.duration:.1f} s Ton={o.has_audio}")
            assert (o.width, o.height) == (320, 240) and o.has_audio and abs(o.duration - 2) < 0.3
    print("VIDEO-TESTS BESTANDEN")


if __name__ == "__main__":
    main()
