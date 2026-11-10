#!/bin/bash
# Doppelklick startet JZoEntertainment Photo/Video AI.
cd "$(dirname "$0")" || exit 1
if [ ! -d .venv ]; then
  echo "Noch nicht installiert. Bitte zuerst INSTALLIEREN.command per Doppelklick ausführen."
  read -r -p "Enter zum Beenden" _
  exit 1
fi
source .venv/bin/activate
python -m jzoai.gui
