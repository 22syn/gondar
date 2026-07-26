#!/usr/bin/env bash
# Install a weekly LaunchAgent that syncs ALL friend watchlists → the universe sheet.
# Default: every Sunday 09:00 local. Override day/time by editing the plist's
# StartCalendarInterval after install (Weekday 0=Sun … 6=Sat).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# No default: the sheet id is the only access control on the public-read universe
# sheet, so it must not be committed. Set GOOGLE_SHEET_ID in your environment.
SHEET_ID="${GOOGLE_SHEET_ID:?set GOOGLE_SHEET_ID to the target universe sheet id}"
CREDS="${GOOGLE_SHEETS_CREDENTIALS:-$HOME/.config/google-sheets-mcp/service-account.json}"

[ -f "$CREDS" ] || { echo "Service-account key not found at: $CREDS" >&2; exit 1; }
[ -f "$REPO/watchlist-sources.json" ] || { echo "Missing $REPO/watchlist-sources.json" >&2; exit 1; }

DEST="$HOME/Library/LaunchAgents/com.svr.friend-watchlist-sync.plist"
mkdir -p "$REPO/.cache" "$HOME/Library/LaunchAgents"

sed -e "s#__REPO__#$REPO#g" \
    -e "s#__SHEET_ID__#$SHEET_ID#g" \
    -e "s#__CREDS__#$CREDS#g" \
    "$REPO/scripts/com.svr.friend-watchlist-sync.plist" > "$DEST"

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
echo "✓ Weekly friend-watchlist sync loaded: Sundays 09:00 → $DEST"
echo "  Log: $REPO/.cache/friend-sync.log"
echo "  Run now to test: launchctl start com.svr.friend-watchlist-sync"
