# JZoEntertainment Photo/Video AI

Eigenes Foto- und Video-Veredelungstool (RAW/JPG/TIFF, MP4/MOV) mit **Vogel-Modus**. Baut auf freien KI-Modellen auf und
bündelt sie in einer Oberfläche und einer Kommandozeile. Läuft auf macOS, auch auf Intel-Macs.

> **Einordnung:** JZoEntertainment Photo/Video AI ist kein Nachbau von Topaz Photo AI oder DxO PureRAW. Es nutzt frei verfügbare
> Modelle (Real-ESRGAN, SCUNet) und klassische Verfahren. Qualität und Tempo liegen unter den kommerziellen
> Programmen, dafür gehört dir der Code, und der Vogel-Modus ist auf deine Arbeit zugeschnitten.

## Installation (Mac)

```bash
brew install python@3.11 ffmpeg exiftool     # ffmpeg nur für Video, exiftool optional (EXIF übernehmen)
cd jzoai
./install_mac.sh
```

Wichtig für Intel-Macs: PyTorch wird dort nur bis Version 2.2.2 gebaut. Darum Python 3.11 und die festen
Versionen in `requirements.txt`. Prüfen mit `python -m jzoai doctor`.

## Benutzung

**Oberfläche:** `./jzoai_gui.command` (oder Doppelklick im Finder).
Foto öffnen, Preset wählen, per Klick einen 1000-px-Ausschnitt festlegen, **Vorschau** (Vorher/Nachher, Trennlinie
ziehen), dann **Verarbeiten und speichern**. Ordner-Batch: **Ordner (Batch)**.

**Kommandozeile:**

```bash
source .venv/bin/activate
python -m jzoai photo IMG_0001.ARW --preset voegel --upscale 2
python -m jzoai photo ~/Fotos/Tag1 --preset hohe-iso --fast-denoise      # ganzer Ordner
python -m jzoai photo IMG.ARW --birds --bird-mode thorough --bird-crops ~/Voegel
python -m jzoai photo IMG.ARW --bird-box 2400,1300,2650,1520              # winziger Vogel von Hand
```

Presets: `standard`, `hohe-iso`, `voegel`, `voegel-klein`. Ausgabe: 16-Bit-TIFF (Standard), PNG oder JPG.

## Funktionen

| Funktion | Umsetzung |
|---|---|
| RAW-Entwicklung | rawpy/LibRaw (Kamera-Weißabgleich, 16 Bit) |
| Entrauschen | SCUNet (KI) oder klassisch (Non-Local-Means, schnell) |
| Upscaling 2x / 4x | Real-ESRGAN (`general` schnell, `x4plus` beste Qualität) |
| Schärfen | Luminanz-Unsharp-Mask mit Rauschschwelle |
| Objektivkorrektur | lensfun (optional, braucht `lensfunpy` und exiftool) |
| Batch, Vorher/Nachher | Oberfläche und CLI |

### Vogel-Modus

1. **Finden:** Mask R-CNN erkennt Vögel samt Umriss. `fast` sucht auf dem verkleinerten Bild. `thorough` sucht
   zusätzlich Kachel für Kachel in Originalauflösung (findet kleinere Vögel, dauert deutlich länger).
2. **Von Hand markieren:** Sehr kleine oder verdeckte Vögel erkennt kein Detektor zuverlässig. Rechteck
   aufziehen (oder `--bird-box`), die Maske entsteht per GrabCut. Das funktioniert in jeder Auflösung.
3. **Gezielt bearbeiten:** Hintergrund wird stärker entrauscht, der Vogel schonender. Der Vogel wird einzeln
   auf eine Arbeitsgröße (Standard 1200 px lange Kante) hochgerechnet, mit Mehrskalen-Schärfung und Mikrokontrast
   auf den Federn nachgearbeitet und mit weicher Maske zurück ins Bild gesetzt. Radien richten sich nach der
   Vogelgröße, deshalb sieht das Ergebnis bei verschiedenen Auflösungen ähnlich aus.
4. **Einzelbilder:** `--bird-crops ORDNER` speichert jeden Vogel als eigenes Bild in Arbeitsgröße.
5. **Augen-Boost** ist experimentell und standardmäßig aus: Er sucht den dunkelsten Fleck im Kopfbereich und
   liegt bei dunklem Gefieder (Krähe, Amsel) gern daneben.

Grenzen: KI-Upscaling erfindet plausible Details. Für dokumentarische Vogelfotos (Artbestimmung) das Original
daneben aufbewahren.

### Video-Modul

```bash
python -m jzoai video clip.mp4 --upscale 2 --denoise 0.4 --seconds 10          # Schnellmodus, erst 10 s testen
python -m jzoai video clip.mp4 --stabilize --fps 60 --interp blend              # ruhiger + 60 fps
python -m jzoai video clip.mp4 --engine ki --upscale 2 --seconds 5              # KI pro Frame (sehr langsam)
python -m jzoai video ~/Clips --upscale 1.5 --codec x265                        # ganzer Ordner
```

In der Oberfläche: **Video-Modul …**. Der Ton bleibt erhalten, mit `--start` und `--seconds` lässt sich ein Abschnitt
bearbeiten.

| Funktion | Umsetzung |
|---|---|
| Upscaling | Schnell: Lanczos + Schärfen (ffmpeg, beliebiger Faktor). KI: Real-ESRGAN pro Frame (Faktor 2 oder 4) |
| Entrauschen | hqdn3d (räumlich und zeitlich) |
| Stabilisieren | vidstab in zwei Durchgängen, sonst `deshake` |
| Bildrate erhöhen | `minterpolate`: bewegungsbasiert (`mci`) oder Überblendung (`blend`) |
| Codec | x264 (Standard), x265, h264_videotoolbox (Hardware-Encoder des Macs, schneller, geringere Qualität) |

Grenzen, bitte ernst nehmen:

- **Nur SDR.** HDR-Material (PQ/HLG) wird abgelehnt, weil die Farben sonst falsch umgerechnet würden.
- **KI-Upscaling pro Frame flackert leicht**, weil jedes Bild einzeln berechnet wird. Es gibt keine zeitliche Stabilisierung
  wie bei Topaz Video AI. Das Vorab-Entrauschen mildert es nur.
- **Zwischenbilder (`minterpolate`) sind einfacher als RIFE** und zeigen bei schneller Bewegung sichtbare Artefakte.
  Die KI-Variante RIFE ist noch nicht eingebaut.
- **Der Vogel-Modus gilt nur für Fotos**, nicht für Video.

Gemessen in meiner Testumgebung (nur 2 CPU-Kerne, 1080p, 4 s Clip mit 100 Frames, dein i9 sollte mehrfach schneller sein):

| Aufgabe | Tempo |
|---|---|
| 1080p auf 4K, Entrauschen + Schärfen (Schnellmodus) | ca. 1 Frame/s |
| Stabilisieren + Entrauschen (1080p) | ca. 3 Frames/s |
| 25 auf 50 fps, Überblendung | ca. 3 Frames/s |
| 25 auf 50 fps, bewegungsbasiert | ca. 0,4 Frames/s |
| KI-Upscaling | gemessen nur bei Mini-Clips (160x120: ca. 1 s/Frame); bei 720p oder 1080p rechne mit mehreren Sekunden pro Frame, also Stunden pro Minute Video |

Darum: immer zuerst mit `--seconds 5` testen, den KI-Modus nur für kurze Schlüsselszenen nutzen und lange Läufe über Nacht starten.

## Geschwindigkeit auf einem Intel-Mac (wichtig)

Die Grafikkarte wird nicht genutzt (PyTorch 2.2.2 und AMD-GPU unter macOS sind unzuverlässig), alles läuft auf
der CPU. Messwerte aus meiner Testumgebung mit nur **2 CPU-Kernen** (dein i9 hat 6 Kerne und sollte mehrfach
schneller sein, bitte selbst nachmessen):

| Schritt | Testumgebung (2 Kerne) |
|---|---|
| KI-Entrauschen (SCUNet) | ca. 30 s je Megapixel |
| Upscaling `general` (4x-Modell) | ca. 13 s je Megapixel Eingabe |
| Upscaling `x4plus` | ca. 250 s je Megapixel Eingabe |
| Klassisches Entrauschen | ca. 1,6 s je Megapixel |

Folgen: Ein 24-MP-Foto mit KI-Entrauschen dauert auch auf dem i9 mehrere Minuten. Deshalb gibt es
`--fast-denoise`. Das große Modell `x4plus` wird nur für die kleinen Vogel-Ausschnitte benutzt (bis 1,5 MP), nicht
für das ganze Bild. Für Batch-Läufe lohnt sich über Nacht laufen lassen. Eine schnellere Variante über die
Radeon-GPU (Vulkan/ncnn) ist ein möglicher nächster Ausbau.

## Tests

```bash
python tests/test_synthetic.py   # ohne KI-Modelle
python tests/test_ai.py          # mit KI-Modellen (nach ./install_mac.sh)
python tests/test_video.py       # Video (braucht ffmpeg), mit --no-ki ohne KI-Teil
```

## Noch nicht enthalten

- Bildinterpolation und Upscaling auf Topaz-Niveau (RIFE, zeitlich stabile KI-Modelle), Vogel-Modus für Video.
- Gesichts-/Personen-Verbesserung, Farb-/Look-Profile, Objektivprofile auf dem Niveau von DxO.
- Die automatische Vogelerkennung (Mask R-CNN) wurde in meiner Testumgebung nicht ausgeführt, weil dort der Download
  der Gewichte gesperrt war. Beim ersten Start auf deinem Mac lädt torchvision sie automatisch (ca. 180 MB).
  Getestet sind der manuelle Weg (Rechteck + GrabCut), das Entrauschen, das Foto-Upscaling und der Vogel-Detailpass.
- Alles lief bisher nur unter Linux, nicht auf macOS.
