#!/bin/bash
# Removes the Question Desk QR add-in from PowerPoint on this Mac.
set -euo pipefail

ADDIN_ID="cbe57d61-2cd8-4fdf-ae94-438fc403a58e"
WEF="$HOME/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef"

finish() {
  if [ -t 0 ] && [ -z "${QD_NO_PAUSE:-}" ]; then
    echo
    read -r -n 1 -s -p "Press any key to close this window." || true
    echo
  fi
}
trap finish EXIT

removed=0
for f in "$WEF"/*.xml; do
  [ -f "$f" ] || continue
  if grep -q "$ADDIN_ID" "$f"; then rm -f "$f"; removed=$((removed + 1)); fi
done

if [ "$removed" -gt 0 ]; then
  echo "✓ Removed Question Desk QR. Quit and reopen PowerPoint to finish."
else
  echo "Question Desk QR wasn't installed for this account."
fi
