#!/usr/bin/env bash
# Dumps the production MongoDB to a compressed, dated archive and prunes anything
# older than RETENTION_DAYS. Meant to run daily via cron on the VPS, e.g.:
#   0 3 * * * /opt/app/Backend/scripts/backup-mongo.sh >> /var/log/webwhatsapp-backup.log 2>&1
#
# Requires `mongodump` (ships with the mongodb-database-tools package — install it on
# the host, or run this inside a container that has it) and MONGODB_URI set in the
# environment (same variable the backend itself uses).
set -euo pipefail
umask 077

MONGODB_URI="${MONGODB_URI:?set MONGODB_URI before running this script}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/mongo}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
dump_dir="$BACKUP_DIR/dump-$timestamp"
archive="$BACKUP_DIR/webwhatsapp-$timestamp.tar.gz"

echo "[backup-mongo] Dumping MongoDB -> $dump_dir"
mongodump --uri="$MONGODB_URI" --out="$dump_dir"

echo "[backup-mongo] Compressing -> $archive"
tar -czf "$archive" -C "$dump_dir" .
rm -rf "$dump_dir"

echo "[backup-mongo] Verifying archive"
tar -tzf "$archive" >/dev/null
sha256sum "$archive" > "$archive.sha256"

echo "[backup-mongo] Pruning backups older than $RETENTION_DAYS days"
find "$BACKUP_DIR" -name 'webwhatsapp-*.tar.gz' -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name 'webwhatsapp-*.tar.gz.sha256' -mtime "+$RETENTION_DAYS" -delete

echo "[backup-mongo] Done: $archive"
