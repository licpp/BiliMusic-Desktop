# BiliMusic optional cloud synchronization

Independent Node 22/PostgreSQL service; website and anonymous feedback stay separate.

```
npm ci
npm test
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE npm start
```

`HOST` defaults to loopback, `PORT` to 3181. Run behind HTTPS. Only enable `TRUST_PROXY=true` with a trusted local reverse proxy and no public direct port. No broad CORS is enabled; native clients perform requests in Rust.

API prefix `/api/sync/v1`: `POST auth`, `GET/PUT/DELETE vault`, `DELETE session`, `GET policy`, `GET health`.

Auth verifies Bilibili login at the upstream HTTPS nav endpoint; never trusts a client UID or persists the supplied Cookie. A random device token (30 days) is returned once; only its SHA-256 digest is saved. Invalid/expired sessions are rejected. Connections and auth are rate limited, with at most ten active device sessions per user.

PUT requires If-Match or If-None-Match; PostgreSQL transactions and advisory locking serialize per-account mutation, with atomic version checks. The body is a whitelist of personal records, not arbitrary JSON storage. Raw source details, credentials, unknown fields, orphan metadata, >200 recent tracks or >3MB snapshots are rejected. Current rollout caps cloud vaults at 200; only the current snapshot is stored.

Deployment: `/opt/bilimusic-sync`, container `bilimusic-sync`, restricted role/database `bilimusic_sync`, server-only environment `/etc/bilimusic-sync.env` (0600). API is reverse-proxied on the existing domain; no new public database or app port. Container memory128MB, log2MB×2, read-only source. `scripts/backup.sh` is installed in `/etc/cron.daily/bilimusic-sync`, encrypted backup key lives only at `/etc/bilimusic-sync.backup-key`. Latest and previous backup only; deployment verifies encrypted gzip integrity. The server-specific script uses existing `postgres_db` / local administrator `chase`; adjust when deploying elsewhere.

Do not log request bodies, Authorization, database URLs, or Bilibili Cookies. Never configure fake auth in production. Unit tests inject a verifier only into their private local HTTP server; production server always uses the real verifier.

See `../docs/CLOUD_SYNC_USAGE.md` for client behavior and current public-access limitation.
