#!/bin/bash
# Installs (or updates) the Question Desk QR add-in for PowerPoint on this Mac, for you only.
#
#   Terminal:  curl -fsSL https://djsincla.github.io/question-desk/addin/install/install-mac.sh | bash
#   Or double-click "Install Question Desk QR.command" from the Mac download.
#
# It puts the add-in's manifest where PowerPoint looks for add-ins
# (~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef). Nothing else changes.
set -euo pipefail

MANIFEST_URL="${QD_MANIFEST_URL:-https://djsincla.github.io/question-desk/addin/manifest.xml}"
ADDIN_ID="cbe57d61-2cd8-4fdf-ae94-438fc403a58e"
WEF="$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef"
TARGET="$WEF/$ADDIN_ID.manifest.xml"

finish() {
  # Keep the window open when double-clicked, so people can read the result.
  if [ -t 0 ] && [ -z "${QD_NO_PAUSE:-}" ]; then
    echo
    read -r -n 1 -s -p "Press any key to close this window." || true
    echo
  fi
}
trap finish EXIT

echo "Installing Question Desk QR for PowerPoint…"

if [ ! -d "/Applications/Microsoft PowerPoint.app" ] && [ -z "${QD_SKIP_APP_CHECK:-}" ]; then
  echo "Note: Microsoft PowerPoint isn't in Applications. The add-in will be ready when it is installed."
fi

mkdir -p "$WEF"
download="$(mktemp "${TMPDIR:-/tmp}/question-desk-qr.XXXXXX")"
if ! curl -fsSL "$MANIFEST_URL" -o "$download"; then
  rm -f "$download"
  echo "Couldn't download the add-in. Check the internet connection and try again." >&2
  exit 1
fi
if ! grep -q "$ADDIN_ID" "$download"; then
  rm -f "$download"
  echo "The downloaded file isn't the Question Desk QR add-in. Nothing was changed." >&2
  exit 1
fi

# Remove earlier copies of this add-in, whatever they were named (e.g. a hand-copied manifest.xml).
for f in "$WEF"/*.xml; do
  [ -f "$f" ] || continue
  [ "$f" = "$TARGET" ] && continue
  if grep -q "$ADDIN_ID" "$f"; then rm -f "$f"; fi
done

mv "$download" "$TARGET"
chmod 644 "$TARGET"
VERSION="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$TARGET" | head -1)"

echo "✓ Installed Question Desk QR ${VERSION}."
if pgrep -x "Microsoft PowerPoint" >/dev/null 2>&1; then
  echo "PowerPoint is open: quit it (⌘Q) and open it again."
fi
echo "In PowerPoint, open a presentation, then Home → Add-ins → Question Desk QR."
