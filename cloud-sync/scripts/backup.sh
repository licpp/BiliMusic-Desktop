#!/bin/bash
set -euo pipefail
umask 077
mkdir -p /var/backups/bilimusic-sync
backup_dir=/var/backups/bilimusic-sync
trap 'rm -f "$backup_dir/next.enc"' EXIT
# Credentials stay inside the existing database container; encrypt before writing to disk.
docker exec postgres_db pg_dump -U chase -d bilimusic_sync --no-owner --no-acl | gzip -c | openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:/etc/bilimusic-sync.backup-key -out "$backup_dir/next.enc"
if [ -f "$backup_dir/latest.enc" ]; then mv -f "$backup_dir/latest.enc" "$backup_dir/previous.enc"; fi
mv -f "$backup_dir/next.enc" "$backup_dir/latest.enc"
