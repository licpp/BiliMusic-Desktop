// Aggregate counters only: one row per version/platform/channel, no visitor records.
export async function initializeDownloadStats(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS download_stats_meta (
    id integer PRIMARY KEY CHECK (id = 1), started_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO download_stats_meta(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS download_counts (
      version text NOT NULL, platform text NOT NULL, source text NOT NULL,
      downloads bigint NOT NULL DEFAULT 0 CHECK(downloads >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(version, platform, source));`);
}
export async function recordDownload(db, version, platform, source) {
  await db.query(`INSERT INTO download_counts(version,platform,source,downloads)
    VALUES($1,$2,$3,1) ON CONFLICT(version,platform,source)
    DO UPDATE SET downloads=download_counts.downloads+1, updated_at=now()`, [version,platform,source]);
}
export async function getDownloadStats(db, currentVersion) {
  const counts = await db.query(`SELECT version, platform, sum(downloads)::text AS downloads
    FROM download_counts GROUP BY version, platform ORDER BY max(updated_at) DESC, version DESC`);
  const meta = await db.query('SELECT started_at FROM download_stats_meta WHERE id=1');
  const platforms = { mac:0, windows:0, android:0 };
  const byVersion = new Map();
  for (const row of counts.rows) {
    const count = Number(row.downloads);
    platforms[row.platform] = (platforms[row.platform] || 0) + count;
    byVersion.set(row.version, (byVersion.get(row.version) || 0) + count);
  }
  const versions = [...byVersion].map(([version,downloads]) => ({version,downloads}));
  if (!versions.some(row => row.version === currentVersion)) versions.unshift({ version:currentVersion, downloads:0 });
  const total = versions.reduce((sum,row) => sum+row.downloads,0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid download counter');
  return { total, platforms, currentVersion, versions, startedAt:meta.rows[0].started_at };
}
