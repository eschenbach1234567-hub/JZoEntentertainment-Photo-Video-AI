#!/bin/bash
# Doppelklick = komplette Installation. Vor jeder größeren Änderung wird nachgefragt.
cd "$(dirname "$0")" || exit 1
clear
echo "=== JZoEntertainment Photo/Video AI: Installation ==="
echo
echo "Das dauert je nach Internet 10-30 Minuten und lädt etwa 1 GB herunter."
echo

load_brew() {
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then eval "$("$b" shellenv)"; fi
  done
}
pause_end() { echo; read -r -p "Zum Beenden Enter drücken ..." _; }

load_brew
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew fehlt. Das ist die Standard-Paketverwaltung für den Mac;"
  echo "wir brauchen sie für Python und ffmpeg."
  read -r -p "Jetzt installieren? Du musst dein Mac-Passwort eingeben (beim Tippen erscheint nichts, das ist normal). [j/n] " a
  if [ "$a" != "j" ]; then echo "Abgebrochen."; pause_end; exit 1; fi
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || { echo "Homebrew-Installation ist fehlgeschlagen."; pause_end; exit 1; }
  load_brew
fi

echo
echo "Installiere Python 3.11, ffmpeg und exiftool ..."
brew install python@3.11 ffmpeg exiftool || { echo "brew install ist fehlgeschlagen."; pause_end; exit 1; }

echo
./install_mac.sh || { echo; echo "Die Installation ist fehlgeschlagen. Bitte den Text oben kopieren und mir schicken."; pause_end; exit 1; }

echo
echo "FERTIG. Starten: Doppelklick auf START.command"
pause_end
