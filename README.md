# JZoEntertainment Photo/Video AI

Eigenes Foto-Veredelungstool (RAW/JPG/TIFF) mit **Vogel-Modus**. Baut auf freien KI-Modellen auf und
bündelt sie in einer Oberfläche und einer Kommandozeile. Läuft auf macOS, auch auf Intel-Macs.

> **Einordnung:** JZoEntertainment Photo/Video AI ist kein Nachbau von Topaz Photo AI oder DxO PureRAW. Es nutzt frei verfügbare
> Modelle (Real-ESRGAN, SCUNet) und klassische Verfahren. Qualität und Tempo liegen unter den kommerziellen
> Programmen, dafür gehört dir der Code, und der Vogel-Modus ist auf deine Arbeit zugeschnitten.

## Installation (Mac)

```bash
brew install python@3.11 exiftool     # exiftool ist optional (EXIF übernehmen, Objektivdaten)
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
```

## Noch nicht enthalten

- **Video** (Upscaling, Bildinterpolation, Stabilisierung): nächster Baustein, geplant mit Real-ESRGAN pro Frame,
  RIFE und ffmpeg.
- Gesichts-/Personen-Verbesserung, Farb-/Look-Profile, Objektivprofile auf dem Niveau von DxO.
- Die Vogelerkennung (Mask R-CNN) wurde in meiner Testumgebung nicht ausgeführt, weil dort der Download der
  Gewichte gesperrt war. Beim ersten Start auf deinem Mac lädt torchvision sie automatisch (ca. 180 MB).
  Getestet sind der manuelle Weg (Rechteck + GrabCut), das Entrauschen, das Upscaling und der Vogel-Detailpass.
