"""Einfache Oberfläche (PySide6): Vorher/Nachher-Vergleich, Vogel markieren, Batch.

Start:  python -m jzoai.gui
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PySide6.QtCore import QPoint, QRect, Qt, QThread, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDialog, QDoubleSpinBox,
                               QFileDialog, QFormLayout, QGroupBox, QHBoxLayout, QLabel,
                               QLineEdit, QMainWindow, QMessageBox, QPlainTextEdit, QProgressBar,
                               QPushButton, QSlider, QSpinBox, QVBoxLayout, QWidget)
import threading

from . import device
from .classic import resize_to
from .pipeline import PRESETS, Pipeline, Settings
from .rawio import is_supported, load_image, read_exif, save_image

PREVIEW_SIZE = 1000  # Pixel-Ausschnitt in Originalauflösung


def to_qimage(img: np.ndarray) -> QImage:
    u8 = np.ascontiguousarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))
    h, w, _ = u8.shape
    return QImage(u8.data, w, h, 3 * w, QImage.Format_RGB888).copy()


class Worker(QThread):
    progress = Signal(float, str)
    log = Signal(str)
    done = Signal(object)
    failed = Signal(str)

    def __init__(self, job):
        super().__init__()
        self.job = job

    def run(self):
        try:
            self.done.emit(self.job(lambda f, t: self.progress.emit(f, t), self.log.emit))
        except Exception as exc:  # Fehler in der Oberfläche anzeigen
            self.failed.emit(str(exc))


class View(QWidget):
    """Übersicht (Originalbild, passend skaliert) oder Vorher/Nachher mit Trennlinie."""
    point_clicked = Signal(int, int)       # Bildkoordinaten
    box_drawn = Signal(int, int, int, int)  # Bildkoordinaten

    def __init__(self):
        super().__init__()
        self.setMinimumSize(640, 480)
        self.setMouseTracking(True)
        self.base: QPixmap | None = None
        self.before: QPixmap | None = None
        self.after: QPixmap | None = None
        self.split = 0.5
        self.draw_mode = False
        self.boxes: list[tuple[int, int, int, int]] = []
        self.preview_center: tuple[int, int] | None = None
        self._drag: QPoint | None = None
        self._cur: QPoint | None = None
        self._img_size = (1, 1)

    def set_overview(self, img: np.ndarray):
        h, w = img.shape[:2]
        self._img_size = (w, h)
        s = 1600 / max(w, h)
        small = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else img
        self.base, self.before, self.after = QPixmap.fromImage(to_qimage(small)), None, None
        self.update()

    def set_compare(self, before: np.ndarray, after: np.ndarray):
        self.before, self.after = QPixmap.fromImage(to_qimage(before)), QPixmap.fromImage(to_qimage(after))
        self.split = 0.5
        self.update()

    def show_overview(self):
        self.before = self.after = None
        self.update()

    def _target(self) -> QRect:
        pm = self.before or self.base
        if pm is None:
            return QRect()
        s = min(self.width() / pm.width(), self.height() / pm.height())
        w, h = int(pm.width() * s), int(pm.height() * s)
        return QRect((self.width() - w) // 2, (self.height() - h) // 2, w, h)

    def _to_image(self, p: QPoint) -> tuple[int, int]:
        t = self._target()
        w, h = self._img_size
        return (int((p.x() - t.x()) / max(t.width(), 1) * w), int((p.y() - t.y()) / max(t.height(), 1) * h))

    def paintEvent(self, _):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 30, 30))
        t = self._target()
        if self.before and self.after:
            p.drawPixmap(t, self.before)
            sx = t.x() + int(t.width() * self.split)
            p.setClipRect(QRect(sx, t.y(), t.right() - sx + 1, t.height()))
            p.drawPixmap(t, self.after)
            p.setClipping(False)
            p.setPen(QPen(QColor(255, 200, 0), 2))
            p.drawLine(sx, t.y(), sx, t.bottom())
            p.setPen(QColor(255, 255, 255))
            p.drawText(t.x() + 8, t.y() + 18, "Vorher")
            p.drawText(t.right() - 52, t.y() + 18, "Nachher")
        elif self.base:
            p.drawPixmap(t, self.base)
            w, h = self._img_size
            p.setPen(QPen(QColor(0, 200, 255), 2))
            for x0, y0, x1, y1 in self.boxes:
                p.drawRect(QRect(t.x() + int(x0 / w * t.width()), t.y() + int(y0 / h * t.height()),
                                 int((x1 - x0) / w * t.width()), int((y1 - y0) / h * t.height())))
            if self.preview_center:
                cx, cy = self.preview_center
                half = PREVIEW_SIZE / 2
                p.setPen(QPen(QColor(255, 200, 0), 1, Qt.DashLine))
                p.drawRect(QRect(t.x() + int((cx - half) / w * t.width()), t.y() + int((cy - half) / h * t.height()),
                                 int(PREVIEW_SIZE / w * t.width()), int(PREVIEW_SIZE / h * t.height())))
            if self._drag and self._cur:
                p.setPen(QPen(QColor(0, 200, 255), 2, Qt.DashLine))
                p.drawRect(QRect(self._drag, self._cur).normalized())

    def mousePressEvent(self, e):
        if self.before and self.after:
            self._set_split(e.position().toPoint())
        elif self.base:
            self._drag = self._cur = e.position().toPoint()

    def mouseMoveEvent(self, e):
        if self.before and self.after and e.buttons() & Qt.LeftButton:
            self._set_split(e.position().toPoint())
        elif self._drag:
            self._cur = e.position().toPoint()
            self.update()

    def mouseReleaseEvent(self, e):
        if self._drag is None:
            return
        a, b = self._drag, e.position().toPoint()
        self._drag = self._cur = None
        if self.draw_mode and (abs(a.x() - b.x()) > 4 and abs(a.y() - b.y()) > 4):
            (x0, y0), (x1, y1) = self._to_image(a), self._to_image(b)
            self.box_drawn.emit(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        elif not self.draw_mode:
            self.point_clicked.emit(*self._to_image(b))
        self.update()

    def _set_split(self, p: QPoint):
        t = self._target()
        self.split = min(1.0, max(0.0, (p.x() - t.x()) / max(t.width(), 1)))
        self.update()


class VideoDialog(QDialog):
    """Video-Werkzeug: Upscaling, Entrauschen, Stabilisieren, Bildrate (siehe video.py)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Video-Modul")
        self.resize(560, 640)
        self.worker: Worker | None = None
        self.cancel = threading.Event()

        self.src = QLineEdit()
        self.src.setPlaceholderText("Videodatei wählen …")
        b_src = QPushButton("…")
        b_src.clicked.connect(self.pick_src)
        row = QHBoxLayout()
        row.addWidget(self.src, 1)
        row.addWidget(b_src)

        self.engine = QComboBox()
        self.engine.addItems(["Schnell (ffmpeg-Filter)", "KI (Real-ESRGAN, sehr langsam)"])
        self.engine.currentIndexChanged.connect(self.on_engine)
        self.upscale = QComboBox()
        self.denoise = self._slider(40)
        self.sharpen = self._slider(30)
        self.stabilize = QCheckBox("Stabilisieren (Verwacklungen glätten)")
        self.fps = QComboBox()
        self.fps.addItems(["wie Original", "30", "50", "60"])
        self.interp = QComboBox()
        self.interp.addItems(["bewegungsbasiert (besser, langsam)", "Überblendung (schnell)"])
        self.codec = QComboBox()
        self.codec.addItems(["x264", "x265", "videotoolbox"])
        self.start = QDoubleSpinBox()
        self.start.setRange(0, 86400)
        self.start.setSuffix(" s")
        self.seconds = QDoubleSpinBox()
        self.seconds.setRange(0, 86400)
        self.seconds.setSpecialValueText("ganzes Video")
        self.seconds.setSuffix(" s")
        self.seconds.setValue(10)

        form = QFormLayout()
        form.addRow("Video", row)
        for label, w in (("Verfahren", self.engine), ("Upscaling", self.upscale),
                         ("Entrauschen", self.denoise), ("Schärfen", self.sharpen), ("", self.stabilize),
                         ("Bildrate", self.fps), ("Zwischenbilder", self.interp), ("Codec", self.codec),
                         ("Start bei", self.start), ("Länge", self.seconds)):
            form.addRow(label, w)
        self.on_engine()

        self.hint = QLabel("Tipp: Erst mit 5-10 s Länge testen. Die KI braucht auf der CPU Sekunden pro Frame.")
        self.hint.setWordWrap(True)
        self.bar = QProgressBar()
        self.logbox = QPlainTextEdit()
        self.logbox.setReadOnly(True)
        self.btn_run = QPushButton("Verarbeiten …")
        self.btn_run.clicked.connect(self.run)
        self.btn_cancel = QPushButton("Abbrechen")
        self.btn_cancel.setEnabled(False)
        self.btn_cancel.clicked.connect(self.cancel.set)
        btns = QHBoxLayout()
        btns.addWidget(self.btn_run)
        btns.addWidget(self.btn_cancel)

        lay = QVBoxLayout(self)
        lay.addLayout(form)
        lay.addWidget(self.hint)
        lay.addLayout(btns)
        lay.addWidget(self.bar)
        lay.addWidget(self.logbox, 1)

    @staticmethod
    def _slider(v: int) -> QSlider:
        s = QSlider(Qt.Horizontal)
        s.setRange(0, 100)
        s.setValue(v)
        return s

    def on_engine(self):
        self.upscale.clear()
        self.upscale.addItems(["2x", "4x"] if self.engine.currentIndex() == 1 else ["1x", "1.5x", "2x", "3x", "4x"])
        self.upscale.setCurrentText("2x")

    def pick_src(self):
        fn, _ = QFileDialog.getOpenFileName(self, "Video öffnen", "", "Videos (*.mp4 *.mov *.m4v *.mkv *.avi *.mts *.m2ts *.webm *.mxf)")
        if fn:
            self.src.setText(fn)

    def run(self):
        from . import video as V

        src = Path(self.src.text().strip())
        if not src.is_file():
            return QMessageBox.information(self, "Video-Modul", "Bitte zuerst ein Video wählen.")
        dst, _ = QFileDialog.getSaveFileName(self, "Speichern als", str(src.with_name(src.stem + "_jzo.mp4")), "MP4 (*.mp4)")
        if not dst:
            return
        fps_txt = self.fps.currentText()
        s = V.VideoSettings(
            engine="ki" if self.engine.currentIndex() == 1 else "fast",
            upscale=float(self.upscale.currentText().rstrip("x")),
            denoise=self.denoise.value() / 100, sharpen=self.sharpen.value() / 100,
            stabilize=self.stabilize.isChecked(),
            fps=None if fps_txt == "wie Original" else float(fps_txt),
            interp="blend" if self.interp.currentIndex() == 1 else "mci",
            codec=self.codec.currentText(), start=self.start.value(),
            seconds=self.seconds.value() or None)
        self.cancel.clear()
        self.btn_run.setEnabled(False)
        self.btn_cancel.setEnabled(True)
        cancel = self.cancel

        def job(progress, log):
            return str(V.process_video(src, dst, s, progress=progress, log=log, cancel=cancel))

        self.worker = Worker(job)
        self.worker.progress.connect(lambda f, t: (self.bar.setValue(int(f * 100)), self.bar.setFormat(f"{t} %p%")))
        self.worker.log.connect(self.logbox.appendPlainText)
        self.worker.done.connect(lambda d: (self._finish(), self.logbox.appendPlainText(f"Gespeichert: {d}")))
        self.worker.failed.connect(lambda m: (self._finish(), self.logbox.appendPlainText(f"FEHLER: {m}")))
        self.worker.start()

    def _finish(self):
        self.btn_run.setEnabled(True)
        self.btn_cancel.setEnabled(False)


class Main(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("JZoEntertainment Photo/Video AI")
        self.resize(1250, 780)
        self.img: np.ndarray | None = None
        self.path: Path | None = None
        self.worker: Worker | None = None

        self.view = View()
        self.view.box_drawn.connect(self.add_box)
        self.view.point_clicked.connect(self.set_preview_center)

        side = QWidget()
        form = QVBoxLayout(side)
        side.setFixedWidth(330)

        row = QHBoxLayout()
        b_open = QPushButton("Foto öffnen …")
        b_open.clicked.connect(self.open_file)
        b_folder = QPushButton("Ordner (Batch) …")
        b_folder.clicked.connect(self.run_folder)
        row.addWidget(b_open)
        row.addWidget(b_folder)
        form.addLayout(row)
        b_video = QPushButton("Video-Modul …")
        b_video.clicked.connect(lambda: VideoDialog(self).show())
        form.addWidget(b_video)

        self.preset = QComboBox()
        self.preset.addItems(["(manuell)"] + list(PRESETS))
        self.preset.currentTextChanged.connect(self.apply_preset)
        self.engine = QComboBox()
        self.engine.addItems(["auto", "ai", "classic"])
        self.denoise = self._slider(40)
        self.fast_denoise = QCheckBox("schnelles Entrauschen (ohne KI)")
        self.sharpen = self._slider(30)
        self.upscale = QComboBox()
        self.upscale.addItems(["1x", "2x", "4x"])
        self.quality = QComboBox()
        self.quality.addItems(["schnell", "beste Qualität (langsam)"])
        g = QGroupBox("Allgemein")
        f = QFormLayout(g)
        for label, w in (("Preset", self.preset), ("Engine", self.engine), ("Entrauschen", self.denoise),
                         ("", self.fast_denoise),
                         ("Schärfen", self.sharpen), ("Upscaling", self.upscale), ("KI-Modell", self.quality)):
            f.addRow(label, w)
        form.addWidget(g)

        self.birds = QCheckBox("Vogel-Modus aktiv")
        self.bird_mode = QComboBox()
        self.bird_mode.addItems(["fast", "thorough (auch kleine Vögel, langsam)"])
        self.bird_detail = self._slider(70)
        self.bird_bg = self._slider(40)
        self.bird_eye = self._slider(0)
        self.bird_target = QSpinBox()
        self.bird_target.setRange(400, 4000)
        self.bird_target.setValue(1200)
        self.bird_target.setSuffix(" px")
        self.btn_draw = QPushButton("Vogel markieren (Rechteck ziehen)")
        self.btn_draw.setCheckable(True)
        self.btn_draw.toggled.connect(lambda on: setattr(self.view, "draw_mode", on))
        b_clear = QPushButton("Markierungen löschen")
        b_clear.clicked.connect(self.clear_boxes)
        gb = QGroupBox("Vögel")
        fb = QFormLayout(gb)
        fb.addRow(self.birds)
        for label, w in (("Suche", self.bird_mode), ("Federdetail", self.bird_detail),
                         ("Hintergrund entrauschen", self.bird_bg), ("Augen-Boost (exp.)", self.bird_eye),
                         ("Arbeitsgröße", self.bird_target)):
            fb.addRow(label, w)
        fb.addRow(self.btn_draw)
        fb.addRow(b_clear)
        form.addWidget(gb)

        self.btn_prev = QPushButton("Vorschau (1000-px-Ausschnitt, per Klick wählen)")
        self.btn_prev.clicked.connect(self.run_preview)
        self.btn_overview = QPushButton("Zurück zur Übersicht")
        self.btn_overview.clicked.connect(self.view.show_overview)
        self.btn_save = QPushButton("Verarbeiten und speichern …")
        self.btn_save.clicked.connect(self.run_full)
        for b in (self.btn_prev, self.btn_overview, self.btn_save):
            form.addWidget(b)
        form.addStretch(1)

        self.bar = QProgressBar()
        self.logbox = QPlainTextEdit()
        self.logbox.setReadOnly(True)
        self.logbox.setMaximumHeight(90)
        self.logbox.appendPlainText(device.describe())

        center = QVBoxLayout()
        center.addWidget(self.view, 1)
        center.addWidget(self.bar)
        center.addWidget(self.logbox)
        root = QHBoxLayout()
        root.addWidget(side)
        root.addLayout(center, 1)
        w = QWidget()
        w.setLayout(root)
        self.setCentralWidget(w)

    # ---------------------------------------------------------------- Hilfen
    @staticmethod
    def _slider(v: int) -> QSlider:
        s = QSlider(Qt.Horizontal)
        s.setRange(0, 100)
        s.setValue(v)
        return s

    def apply_preset(self, name: str):
        if name not in PRESETS:
            return
        p = PRESETS[name]
        self.denoise.setValue(int(p.get("denoise", 0.4) * 100))
        self.sharpen.setValue(int(p.get("sharpen", 0.3) * 100))
        self.birds.setChecked(p.get("birds", False))
        self.bird_mode.setCurrentIndex(1 if p.get("bird_mode") == "thorough" else 0)
        self.bird_detail.setValue(int(p.get("bird_detail", 0.7) * 100))
        self.bird_bg.setValue(int(p.get("bird_bg_denoise", 0.4) * 100))
        self.bird_target.setValue(p.get("bird_target_px", 1200))

    def settings(self) -> Settings:
        s = Settings()
        s.engine = self.engine.currentText()
        s.denoise = self.denoise.value() / 100
        s.fast_denoise = self.fast_denoise.isChecked()
        s.sharpen = self.sharpen.value() / 100
        s.upscale = int(self.upscale.currentText()[0])
        s.upscale_model = "general" if self.quality.currentIndex() == 0 else "x4plus"
        s.birds = self.birds.isChecked() or bool(self.view.boxes)
        s.bird_mode = "thorough" if self.bird_mode.currentIndex() == 1 else "fast"
        s.bird_detail = self.bird_detail.value() / 100
        s.bird_bg_denoise = self.bird_bg.value() / 100
        s.bird_eye = self.bird_eye.value() / 100
        s.bird_target_px = self.bird_target.value()
        s.bird_boxes = list(self.view.boxes)
        return s

    def log(self, text: str):
        self.logbox.appendPlainText(text)

    def busy(self, on: bool):
        for b in (self.btn_prev, self.btn_save):
            b.setEnabled(not on)

    def start(self, job, on_done):
        self.busy(True)
        self.worker = Worker(job)
        self.worker.progress.connect(lambda f, t: (self.bar.setValue(int(f * 100)), self.bar.setFormat(f"{t} %p%")))
        self.worker.log.connect(self.log)
        self.worker.done.connect(lambda r: (self.busy(False), on_done(r)))
        self.worker.failed.connect(lambda m: (self.busy(False), QMessageBox.critical(self, "Fehler", m)))
        self.worker.start()

    # ---------------------------------------------------------------- Aktionen
    def open_file(self):
        fn, _ = QFileDialog.getOpenFileName(self, "Foto öffnen", "", "Bilder (*.*)")
        if not fn:
            return
        try:
            self.img, self.path = load_image(fn), Path(fn)
        except Exception as exc:
            QMessageBox.critical(self, "Fehler", str(exc))
            return
        self.view.boxes.clear()
        self.view.preview_center = (self.img.shape[1] // 2, self.img.shape[0] // 2)
        self.view.set_overview(self.img)
        self.log(f"{self.path.name}: {self.img.shape[1]}x{self.img.shape[0]} px")

    def add_box(self, x0, y0, x1, y1):
        self.view.boxes.append((x0, y0, x1, y1))
        self.birds.setChecked(True)
        self.view.update()

    def clear_boxes(self):
        self.view.boxes.clear()
        self.view.update()

    def set_preview_center(self, x, y):
        if self.img is not None:
            self.view.preview_center = (x, y)
            self.view.update()

    def run_preview(self):
        if self.img is None:
            return QMessageBox.information(self, "JZoEntertainment Photo/Video AI", "Bitte zuerst ein Foto öffnen.")
        H, W = self.img.shape[:2]
        cx, cy = self.view.preview_center or (W // 2, H // 2)
        half = PREVIEW_SIZE // 2
        x0, y0 = int(np.clip(cx - half, 0, max(W - PREVIEW_SIZE, 0))), int(np.clip(cy - half, 0, max(H - PREVIEW_SIZE, 0)))
        x1, y1 = min(W, x0 + PREVIEW_SIZE), min(H, y0 + PREVIEW_SIZE)
        crop = self.img[y0:y1, x0:x1].copy()
        s = self.settings()
        # manuelle Markierungen in Ausschnitts-Koordinaten umrechnen
        boxes = []
        for bx0, by0, bx1, by1 in s.bird_boxes:
            nb = (max(bx0, x0) - x0, max(by0, y0) - y0, min(bx1, x1) - x0, min(by1, y1) - y0)
            if nb[2] - nb[0] > 8 and nb[3] - nb[1] > 8:
                boxes.append(nb)
        s.bird_boxes = boxes
        s.lens = False

        def job(progress, log):
            pipe = Pipeline(s, log=log)
            return crop, pipe.run(crop, cb=progress)

        def done(res):
            before, after = res
            before_big = resize_to(before, after.shape[1], after.shape[0])
            self.view.set_compare(before_big, after)

        self.start(job, done)

    def run_full(self):
        if self.img is None or self.path is None:
            return QMessageBox.information(self, "JZoEntertainment Photo/Video AI", "Bitte zuerst ein Foto öffnen.")
        dst, _ = QFileDialog.getSaveFileName(self, "Speichern als", str(self.path.with_name(self.path.stem + "_jzo.tif")),
                                             "TIFF (*.tif);;PNG (*.png);;JPEG (*.jpg)")
        if not dst:
            return
        s, img, src = self.settings(), self.img, self.path

        def job(progress, log):
            pipe = Pipeline(s, log=log)
            res = pipe.run(img, exif=read_exif(src) if s.lens else None, cb=progress)
            save_image(res, dst, copy_exif_from=src)
            return dst

        self.start(job, lambda d: self.log(f"Gespeichert: {d}"))

    def run_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "Ordner mit Fotos")
        if not folder:
            return
        files = sorted(p for p in Path(folder).iterdir() if p.is_file() and is_supported(p))
        if not files:
            return QMessageBox.information(self, "JZoEntertainment Photo/Video AI", "Keine Bilder im Ordner gefunden.")
        out_dir = Path(folder) / "jzoai_out"
        s = self.settings()
        s.bird_boxes = []  # Markierungen gelten nur für das geöffnete Foto

        def job(progress, log):
            pipe = Pipeline(s, log=log)
            for i, f in enumerate(files):
                log(f"[{i + 1}/{len(files)}] {f.name}")
                res = pipe.run(load_image(f), exif=read_exif(f) if s.lens else None,
                               cb=lambda fr, t, i=i: progress((i + fr) / len(files), f"{f.name}: {t}"))
                save_image(res, out_dir / (f.stem + "_jzo.tif"), copy_exif_from=f)
            return str(out_dir)

        self.start(job, lambda d: self.log(f"Batch fertig: {d}"))


def main():
    app = QApplication(sys.argv)
    win = Main()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
