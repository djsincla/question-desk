#!/bin/sh
# Builds the add-in installer downloads in docs/addin/install from the scripts beside them.
# Run after changing any install script; tests/installers.test.js checks the zips are current.
set -eu
cd "$(dirname "$0")/../docs/addin/install"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/mac" "$stage/windows"
cp install-mac.sh "$stage/mac/Install Question Desk QR.command"
cp uninstall-mac.sh "$stage/mac/Uninstall Question Desk QR.command"
chmod 755 "$stage/mac/"*.command
cp install-windows.ps1 uninstall-windows.ps1 "Install Question Desk QR.cmd" "Uninstall Question Desk QR.cmd" "$stage/windows/"

# Fixed timestamps so rebuilding unchanged scripts gives identical zips.
find "$stage" -exec touch -t 202601010000 {} +
rm -f QuestionDeskQR-Mac.zip QuestionDeskQR-Windows.zip
(cd "$stage/mac" && zip -X -q ../QuestionDeskQR-Mac.zip "Install Question Desk QR.command" "Uninstall Question Desk QR.command")
(cd "$stage/windows" && zip -X -q ../QuestionDeskQR-Windows.zip install-windows.ps1 uninstall-windows.ps1 "Install Question Desk QR.cmd" "Uninstall Question Desk QR.cmd")
mv "$stage/QuestionDeskQR-Mac.zip" "$stage/QuestionDeskQR-Windows.zip" .
echo "Built QuestionDeskQR-Mac.zip and QuestionDeskQR-Windows.zip"
