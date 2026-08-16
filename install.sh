#!/usr/bin/env bash
set -euo pipefail

UUID="claude-limit-viewer@kevinf"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST_DIR")"
rm -rf "$DEST_DIR"
ln -s "$SRC_DIR" "$DEST_DIR"

gnome-extensions enable "$UUID"

echo "Installed $UUID -> $DEST_DIR"
echo "On Wayland: log out/in to reload gnome-shell."
echo "On X11: Alt+F2, type 'r', Enter to reload gnome-shell."
