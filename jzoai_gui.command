#!/bin/bash
# Doppelklick im Finder startet die Oberfläche.
cd "$(dirname "$0")"
source .venv/bin/activate
python -m jzoai.gui
