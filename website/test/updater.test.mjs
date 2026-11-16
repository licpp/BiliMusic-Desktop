import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updaterManifest, validateUpdateDownload } from '../updater.mjs';
const releases = { version: '0.3.5', platforms: [{ id:'android-large', status:'available', version:'0.3.4' }, { id:'mac', status:'available' }, { id:'ios', status:'available' }] };
test('OTA counters validate edition and actual package version', () => {
  assert.deepEqual(validateUpdateDownload({ version:'0.3.4', platform:'android-large', source:'ota' }, releases), { version:'0.3.4', platform:'android-large', source:'ota' });
  assert.equal(validateUpdateDownload({ version:'0.3.5', platform:'mac', source:'ota' }, releases).platform, 'mac');
  for (const body of [null, {}, { version:'0.3.5', platform:'android-large', source:'ota' }, { version:'0.3.5', platform:'ios', source:'ota' }, { version:'0.3.5', platform:'mac', source:'untrusted' }]) assert.throws(() => validateUpdateDownload(body, releases));
});
test('desktop update feed is absent until a signed package has been published', () => {
  const folder = mkdtempSync(join(tmpdir(), 'updater-test-')), file = join(folder,'updater.json');
  try {
    assert.equal(updaterManifest(file), null);
    writeFileSync(file, '{"version":"0.3.5","platforms":{}}'); assert.equal(updaterManifest(file), null);
    writeFileSync(file, '{"version":"0.3.5","platforms":{"darwin-aarch64":{"url":"signed"}}}'); assert.ok(updaterManifest(file));
    writeFileSync(file, '<html>blocked</html>'); assert.equal(updaterManifest(file), null);
  } finally { rmSync(folder, { recursive:true }); }
});

test('OTA counts for desktop architectures remain separate', () => {
  const releases={version:'0.3.5',platforms:['mac','mac-intel','windows','windows-arm64'].map(id=>({id,status:'available'}))};
  for(const platform of ['mac','mac-intel','windows','windows-arm64']) assert.equal(validateUpdateDownload({version:'0.3.5',platform,source:'ota'},releases).platform,platform);
});
