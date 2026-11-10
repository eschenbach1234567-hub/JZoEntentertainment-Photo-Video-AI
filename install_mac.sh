#!/bin/bash
# Installation für macOS (getestet für Intel-Macs; funktioniert auch auf Apple Silicon).
set -e
cd "$(dirname "$0")"

# PyTorch gibt es für Intel-Macs nur bis Version 2.2.2 -> Python 3.11 (oder 3.10/3.12) nötig.
PY=""
for c in python3.11 python3.12 python3.10; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Kein passendes Python gefunden. Bitte installieren:  brew install python@3.11"
  exit 1
fi
echo "Verwende $($PY --version)"

$PY -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo
echo "Lade KI-Modelle (ca. 80 MB) ..."
python -m jzoai models

echo
python -m jzoai doctor
echo
echo "Optional, für EXIF-Übernahme und Objektivkorrektur:  brew install exiftool"
echo "Fertig. Oberfläche starten:  ./jzoai_gui.command   (oder: python -m jzoai.gui)"
