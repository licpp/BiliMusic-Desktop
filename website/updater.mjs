import { readFileSync } from 'node:fs';
import { HttpError } from './validation.mjs';

export function updaterManifest(file = process.env.UPDATER_MANIFEST_PATH || new URL('./updater.json', import.meta.url)) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && Object.keys(value.platforms || {}).length ? value : null;
  } catch { return null; }
}
// Aggregate successful app downloads in the same counters as website downloads.
// No device identifier, account or browsing data is sent by the client.
export function validateUpdateDownload(body, releases) {
  const platform = releases.platforms.find(p => p.id === body?.platform && p.status === 'available');
  if (!platform || !['mac', 'windows', 'android', 'android-large'].includes(platform.id) || body.version !== (platform.version || releases.version) || body.source !== 'ota') {
    throw new HttpError(400, '更新包信息不正确。');
  }
  return { version: body.version, platform: platform.id, source: 'ota' };
}
