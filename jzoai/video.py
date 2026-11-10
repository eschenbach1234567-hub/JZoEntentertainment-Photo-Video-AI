"""Video-Modul: Upscaling, Entrauschen, Stabilisieren, Bildrate erhöhen.

Zwei Wege:
  * "fast": komplette ffmpeg-Filterkette (hqdn3d, vidstab, lanczos, unsharp, minterpolate).
            Schnell, robust, braucht keine KI.
  * "ki"  : Frames werden aus ffmpeg gelesen, mit Real-ESRGAN vergrößert und wieder an ffmpeg
            übergeben. Deutlich bessere Details, auf der CPU aber sehr langsam
            (Sekunden pro Frame) -> sinnvoll für kurze Clips oder niedrige Auflösungen.

Braucht ffmpeg und ffprobe (macOS:  brew install ffmpeg).  Nur SDR (8 Bit) wird farbrichtig
verarbeitet; HDR-Material wird abgelehnt statt falsch umgerechnet.
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable

import numpy as np

ProgressFn = Callable[[float, str], None]

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".mts", ".m2ts", ".webm", ".mxf"}


class VideoError(RuntimeError):
    pass


class Cancelled(VideoError):
    pass


# --------------------------------------------------------------------------- Werkzeuge

def find_tool(name: str) -> str | None:
    env = os.environ.get(f"JZOAI_{name.upper()}")
    if env:
        return env
    return shutil.which(name)


def require_ffmpeg() -> str:
    exe = find_tool("ffmpeg")
    if not exe:
        raise VideoError("ffmpeg nicht gefunden. Installation:  brew install ffmpeg")
    return exe


@lru_cache(maxsize=1)
def features() -> dict[str, set[str]]:
    exe = require_ffmpeg()

    def names(flag: str) -> set[str]:
        res = subprocess.run([exe, "-hide_banner", flag], capture_output=True, text=True)
        out = set()
        for line in res.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2 and re.fullmatch(r"[A-Z.]{3,6}", parts[0]):
                out.add(parts[1])
        return out

    return {"filters": names("-filters"), "encoders": names("-encoders")}


def is_video(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXT


# --------------------------------------------------------------------------- Probe

@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    fps_str: str
    duration: float
    has_audio: bool
    pix_fmt: str = ""
    color_transfer: str = ""
    color_space: str = ""

    @property
    def matrix(self) -> str:
        """Farbmatrix für RGB<->YUV: laut Datei-Tag, sonst nach Auflösung geschätzt."""
        if self.color_space == "bt709":
            return "bt709"
        if self.color_space in ("smpte170m", "bt470bg", "bt601"):
            return "bt601"
        return "bt709" if self.height >= 720 else "bt601"

    @property
    def frames(self) -> int:
        return max(1, int(round(self.duration * self.fps)))


def _frac(text: str) -> float:
    try:
        a, b = text.split("/")
        return float(a) / float(b) if float(b) else 0.0
    except Exception:
        try:
            return float(text)
        except Exception:
            return 0.0


def probe(path: str | Path) -> VideoInfo:
    ffprobe = find_tool("ffprobe")
    if not ffprobe:
        raise VideoError("ffprobe nicht gefunden (gehört zu ffmpeg).  brew install ffmpeg")
    res = subprocess.run([ffprobe, "-v", "error", "-print_format", "json", "-show_streams",
                          "-show_format", str(path)], capture_output=True, text=True)
    if res.returncode != 0:
        raise VideoError(f"Datei nicht lesbar: {path}\n{res.stderr.strip()[-400:]}")
    data = json.loads(res.stdout)
    vs = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    if vs is None:
        raise VideoError("Keine Videospur gefunden.")
    fps_str = vs.get("avg_frame_rate") or vs.get("r_frame_rate") or "25/1"
    if _frac(fps_str) <= 0:
        fps_str = vs.get("r_frame_rate", "25/1")
    dur = float(vs.get("duration") or data.get("format", {}).get("duration") or 0)
    return VideoInfo(
        width=int(vs["width"]), height=int(vs["height"]), fps=_frac(fps_str), fps_str=fps_str,
        duration=dur, has_audio=any(s.get("codec_type") == "audio" for s in data["streams"]),
        pix_fmt=vs.get("pix_fmt", ""), color_transfer=vs.get("color_transfer", ""),
        color_space=vs.get("color_space", ""),
    )


# --------------------------------------------------------------------------- Einstellungen

@dataclass
class VideoSettings:
    engine: str = "fast"            # fast | ki
    upscale: float = 2.0            # fast: beliebig (z. B. 1.5); ki: 1, 2 oder 4
    upscale_model: str = "general"  # nur ki
    denoise: float = 0.4            # 0..1 (zeitlich + räumlich, hqdn3d)
    sharpen: float = 0.3            # 0..1
    stabilize: bool = False
    stabilize_smoothing: int = 15   # Glättung in Frames (größer = ruhiger, mehr Beschnitt)
    fps: float | None = None        # Ziel-Bildrate (Zwischenbilder berechnen)
    interp: str = "mci"             # mci = bewegungsbasiert | blend = Überblendung (schnell)
    codec: str = "x264"             # x264 | x265 | videotoolbox
    crf: int = 16                   # Qualität (kleiner = besser/größer)
    start: float = 0.0              # Sekunden
    seconds: float | None = None    # nur diese Länge verarbeiten
    tile: int | None = None


def _even(v: float) -> int:
    n = int(round(v))
    return max(2, n - (n % 2))


def _denoise_filter(d: float) -> str | None:
    if d <= 0.01:
        return None
    return f"hqdn3d={8 * d:.2f}:{6 * d:.2f}:{9 * d:.2f}:{7 * d:.2f}"


def _sharpen_filter(s: float) -> str | None:
    if s <= 0.01:
        return None
    return f"unsharp=5:5:{1.5 * s:.2f}:5:5:0.0"


def _interp_filter(fps: float, mode: str) -> str:
    if mode == "blend":
        return f"minterpolate=fps={fps}:mi_mode=blend"
    return f"minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"


def _encoder_args(s: VideoSettings, out_w: int, out_h: int, fps: float) -> list[str]:
    enc = features()["encoders"]
    if s.codec == "videotoolbox":
        if "h264_videotoolbox" not in enc:
            raise VideoError("h264_videotoolbox ist in diesem ffmpeg nicht verfügbar.")
        bitrate = int(min(out_w * out_h * fps * 0.12, 200e6))
        return ["-c:v", "h264_videotoolbox", "-b:v", str(bitrate), "-pix_fmt", "yuv420p"]
    if s.codec == "x265":
        if "libx265" not in enc:
            raise VideoError("libx265 ist in diesem ffmpeg nicht verfügbar.")
        return ["-c:v", "libx265", "-preset", "medium", "-crf", str(s.crf + 2),
                "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]
    if "libx264" not in enc:
        raise VideoError("libx264 ist in diesem ffmpeg nicht verfügbar.")
    return ["-c:v", "libx264", "-preset", "medium", "-crf", str(s.crf), "-pix_fmt", "yuv420p"]


def _effective_duration(info: VideoInfo, s: VideoSettings) -> float:
    d = max(info.duration - s.start, 0.0)
    return min(d, s.seconds) if s.seconds else d


def _check_input(info: VideoInfo, s: VideoSettings) -> None:
    if info.color_transfer in ("smpte2084", "arib-std-b67"):
        raise VideoError("HDR-Material (PQ/HLG) wird nicht unterstützt: Die Farben würden falsch "
                         "umgerechnet. Bitte vorher in SDR wandeln.")
    if _effective_duration(info, s) <= 0:
        raise VideoError("Der gewählte Abschnitt ist leer (Start hinter dem Ende?).")


def _time_args(s: VideoSettings) -> list[str]:
    a = ["-ss", f"{s.start:.3f}"] if s.start > 0 else []
    return a


def _dur_args(s: VideoSettings) -> list[str]:
    return ["-t", f"{s.seconds:.3f}"] if s.seconds else []


def _base() -> list[str]:
    return [require_ffmpeg(), "-y", "-hide_banner", "-nostats", "-progress", "pipe:1"]


def _tail(f, n: int = 1200) -> str:
    f.seek(0)
    return f.read().decode(errors="replace")[-n:]


def _run(cmd: list[str], total: float, progress: ProgressFn | None, lo: float, hi: float,
         text: str, cancel: threading.Event | None, cwd: str | None = None) -> None:
    err = tempfile.TemporaryFile()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, cwd=cwd, text=True)
    try:
        for line in proc.stdout:  # type: ignore[union-attr]
            if cancel is not None and cancel.is_set():
                proc.kill()
                raise Cancelled("Abgebrochen.")
            if line.startswith(("out_time_us=", "out_time_ms=")):
                try:
                    t = int(line.split("=", 1)[1]) / 1e6
                except ValueError:
                    continue
                if progress and total > 0:
                    progress(lo + (hi - lo) * min(t / total, 1.0), text)
        rc = proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
    if rc != 0:
        raise VideoError(f"ffmpeg-Fehler ({rc}):\n{_tail(err)}")


# --------------------------------------------------------------------------- Stabilisierung

def _stabilize_filters(src: str, info: VideoInfo, s: VideoSettings, tmp: str, total: float,
                       progress, cancel, log, lo: float, hi: float) -> list[str]:
    """Pass 1 (Bewegung analysieren); gibt die Filter für Pass 2 zurück."""
    if "vidstabdetect" in features()["filters"]:
        cmd = _base() + _time_args(s) + ["-i", src] + _dur_args(s) + [
            "-vf", "vidstabdetect=shakiness=5:accuracy=15:result=transforms.trf", "-f", "null", "-"]
        _run(cmd, total, progress, lo, hi, "Stabilisierung analysieren", cancel, cwd=tmp)
        return [f"vidstabtransform=input=transforms.trf:smoothing={s.stabilize_smoothing}:optzoom=1:zoom=0"]
    log("vidstab fehlt in diesem ffmpeg -> einfachere Stabilisierung (deshake).")
    return ["deshake"]


# --------------------------------------------------------------------------- Schnellmodus

def process_fast(src: str, dst: str, s: VideoSettings, info: VideoInfo,
                 progress: ProgressFn | None, log, cancel) -> None:
    total = _effective_duration(info, s)
    out_w, out_h = _even(info.width * s.upscale), _even(info.height * s.upscale)
    with tempfile.TemporaryDirectory() as tmp:
        vf: list[str] = []
        lo = 0.0
        if s.stabilize:
            vf += _stabilize_filters(src, info, s, tmp, total, progress, cancel, log, 0.0, 0.25)
            lo = 0.25
        for f in (_denoise_filter(s.denoise),):
            if f:
                vf.append(f)
        if (out_w, out_h) != (info.width, info.height):
            vf.append(f"scale={out_w}:{out_h}:flags=lanczos")
        if (f := _sharpen_filter(s.sharpen)):
            vf.append(f)
        if s.fps:
            vf.append(_interp_filter(s.fps, s.interp))
        vf.append("format=yuv420p")
        fps_out = s.fps or info.fps
        cmd = _base() + _time_args(s) + ["-i", src] + _dur_args(s) + [
            "-vf", ",".join(vf), "-map", "0:v:0", "-map", "0:a:0?",
        ] + _encoder_args(s, out_w, out_h, fps_out) + ["-c:a", "aac", "-b:a", "192k", dst]
        _run(cmd, total, progress, lo, 1.0, "Video verarbeiten", cancel, cwd=tmp)


# --------------------------------------------------------------------------- KI-Modus

def _read_exact(stream, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None  # Stream zu Ende (ein unvollständiges letztes Frame wird verworfen)
        buf += chunk
    return bytes(buf)


def process_ki(src: str, dst: str, s: VideoSettings, info: VideoInfo,
               progress: ProgressFn | None, log, cancel) -> None:
    from . import classic
    from .pipeline import Pipeline, Settings

    scale = int(s.upscale)
    if scale not in (2, 4):
        raise VideoError("KI-Upscaling unterstützt Faktor 2 oder 4.")
    total = _effective_duration(info, s)
    n_frames = max(1, int(round(total * info.fps)))
    w, h = info.width, info.height
    out_w, out_h = _even(w * scale), _even(h * scale)
    matrix = info.matrix

    pipe = Pipeline(Settings(engine="ai", upscale=scale, upscale_model=s.upscale_model,
                             denoise=0.0, sharpen=0.0, tile=s.tile, lens=False), log=log)
    if not pipe.ai:
        raise VideoError("KI-Modus braucht PyTorch. Alternative: --engine fast")

    with tempfile.TemporaryDirectory() as tmp:
        pre: list[str] = []
        lo = 0.0
        if s.stabilize:
            pre += _stabilize_filters(src, info, s, tmp, total, progress, cancel, log, 0.0, 0.1)
            lo = 0.1
        if (f := _denoise_filter(s.denoise)):
            pre.append(f)
        pre.append(f"scale=in_color_matrix={matrix}:out_range=full,format=rgb24")

        dec_cmd = [require_ffmpeg(), "-hide_banner", "-loglevel", "error"] + _time_args(s) + \
            ["-i", src] + _dur_args(s) + ["-vf", ",".join(pre), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]

        post = [f"scale=in_range=full:out_color_matrix={matrix}:out_range=tv"]
        if s.fps:
            post.insert(0, _interp_filter(s.fps, s.interp))
        post.append("format=yuv420p")
        fps_out = s.fps or info.fps
        enc_cmd = [require_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{out_w}x{out_h}",
                   "-framerate", info.fps_str, "-i", "pipe:0"]
        if info.has_audio:
            enc_cmd += _time_args(s) + ["-i", src] + _dur_args(s)
        enc_cmd += ["-map", "0:v:0"] + (["-map", "1:a:0?"] if info.has_audio else []) + \
                   ["-vf", ",".join(post)] + _encoder_args(s, out_w, out_h, fps_out) + \
                   ["-colorspace", matrix if matrix == "bt709" else "smpte170m",
                    "-color_primaries", "bt709" if matrix == "bt709" else "smpte170m",
                    "-color_trc", "bt709" if matrix == "bt709" else "smpte170m"] + \
                   (["-c:a", "aac", "-b:a", "192k"] if info.has_audio else []) + [dst]

        dec_err, enc_err = tempfile.TemporaryFile(), tempfile.TemporaryFile()
        dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=dec_err)
        enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stderr=enc_err)
        frame_bytes = w * h * 3
        done, t0 = 0, time.time()
        try:
            while True:
                if cancel is not None and cancel.is_set():
                    raise Cancelled("Abgebrochen.")
                raw = _read_exact(dec.stdout, frame_bytes)
                if raw is None:
                    break
                img = np.frombuffer(raw, np.uint8).reshape(h, w, 3).astype(np.float32) / 255.0
                up = pipe._upscale(img, scale, lambda f: None)
                if s.sharpen > 0:
                    up = classic.unsharp(up, amount=s.sharpen, radius=0.8 * math.sqrt(scale))
                u8 = (np.clip(up, 0, 1) * 255.0 + 0.5).astype(np.uint8)[:out_h, :out_w]
                if u8.shape[0] != out_h or u8.shape[1] != out_w:
                    u8 = np.pad(u8, ((0, out_h - u8.shape[0]), (0, out_w - u8.shape[1]), (0, 0)), mode="edge")
                enc.stdin.write(np.ascontiguousarray(u8).tobytes())
                done += 1
                el = time.time() - t0
                if done in (1, 3):
                    log(f"~{el / done:.1f} s pro Frame -> geschätzt {el / done * n_frames / 60:.0f} min für {n_frames} Frames")
                if progress:
                    eta = el / done * (n_frames - done)
                    progress(lo + (1.0 - lo) * min(done / n_frames, 1.0),
                             f"Frame {done}/{n_frames}, noch ca. {eta / 60:.0f} min")
            enc.stdin.close()
            if enc.wait() != 0:
                raise VideoError(f"ffmpeg (Encoder) Fehler:\n{_tail(enc_err)}")
            if dec.wait() != 0 and done == 0:
                raise VideoError(f"ffmpeg (Decoder) Fehler:\n{_tail(dec_err)}")
        finally:
            for p in (dec, enc):
                if p.poll() is None:
                    p.kill()
        if done == 0:
            raise VideoError("Es wurden keine Frames gelesen.")


# --------------------------------------------------------------------------- Einstieg

def process_video(src: str | Path, dst: str | Path, s: VideoSettings | None = None,
                  progress: ProgressFn | None = None, log=print,
                  cancel: threading.Event | None = None) -> Path:
    s = s or VideoSettings()
    src, dst = str(src), Path(dst)
    require_ffmpeg()
    info = probe(src)
    _check_input(info, s)
    if s.fps and s.fps <= info.fps:
        log(f"Ziel-Bildrate {s.fps:g} <= Quelle {info.fps:g}: Bildraten-Erhöhung übersprungen.")
        s.fps = None
    dst.parent.mkdir(parents=True, exist_ok=True)
    log(f"Quelle: {info.width}x{info.height}, {info.fps:.3f} fps, {info.duration:.1f} s"
        f"{', mit Ton' if info.has_audio else ''}")
    engine = s.engine
    if engine == "ki" and s.upscale <= 1:
        log("KI-Modus ohne Vergrößerung ist nicht sinnvoll -> Schnellmodus.")
        engine = "fast"
    if engine == "ki":
        process_ki(src, str(dst), s, info, progress, log, cancel)
    else:
        process_fast(src, str(dst), s, info, progress, log, cancel)
    if not dst.exists() or dst.stat().st_size == 0:
        raise VideoError("Ausgabedatei wurde nicht erzeugt.")
    if progress:
        progress(1.0, "Fertig")
    return dst
