#!/usr/bin/env bash
set -euo pipefail
umask 077

MONGODB_URI="${MONGODB_URI:?set MONGODB_URI before restoring}"
ARCHIVE="${1:?usage: restore-mongo.sh /path/to/webwhatsapp-YYYYMMDD-HHMMSS.tar.gz}"
CONFIRM_RESTORE="${CONFIRM_RESTORE:-}"

if [[ "$CONFIRM_RESTORE" != "YES" ]]; then
  echo "Refusing restore. Set CONFIRM_RESTORE=YES after confirming the target database." >&2
  exit 2
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "Archive not found: $ARCHIVE" >&2
  exit 2
fi
if [[ -f "$ARCHIVE.sha256" ]]; then sha256sum -c "$ARCHIVE.sha256"; fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
tar -xzf "$ARCHIVE" -C "$tmp_dir"
mongorestore --uri="$MONGODB_URI" --drop "$tmp_dir"
echo "Restore completed successfully."
