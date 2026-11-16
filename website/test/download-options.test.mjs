import test from 'node:test';
import assert from 'node:assert/strict';
import { detectedDownloadFamily, groupDownloads, downloadVariant, preferredDownloadFamily } from '../public/download-options.js';
const item = (id, architecture, file = '') => ({ id, architecture, file, name: id, status: 'available', channels: [{ id: 'github', url: `https://example.invalid/${id}` }] });
const items = [item('mac', 'Apple Silicon'), item('mac-intel', 'Intel x64'), item('windows', 'x64'), item('windows-arm64', 'ARM64'), item('android', 'ARM64'), item('android-large', 'ARM64'), item('ios', 'ARM64'), item('ohos', 'ARM64'), item('linux-x64-appimage', 'x64', 'BiliMusic.AppImage'), item('linux-x64-deb', 'x64', 'BiliMusic.deb'), item('linux-arm64-appimage', 'aarch64', 'BiliMusic.AppImage'), item('linux-arm64-deb', 'ARM64', 'BiliMusic.deb')];
test('architecture grouping preserves each original download identity and channel', () => {
  const groups = groupDownloads(items);
  assert.deepEqual(groups.map(group => group.id), ['mac', 'windows', 'android', 'ios', 'ohos', 'linux']);
  assert.deepEqual(groups.flatMap(group => group.items), items);
  assert.equal(groups[5].items[3], items[11]);
  assert.deepEqual(items.slice(8).map(downloadVariant), ['x64 · AppImage', 'x64 · DEB', 'ARM64 · AppImage', 'ARM64 · DEB']);
  assert.deepEqual(items.slice(0, 4).map(downloadVariant), ['Apple Silicon', 'Intel', 'x64', 'ARM64']);
});
test('the initial tab follows the device without choosing an unpublished platform', () => {
  const groups = groupDownloads(items);
  for (const [agent, touch, expected] of [['Android', 5, 'android'], ['iPhone', 5, 'ios'], ['Macintosh', 5, 'ios'], ['Macintosh', 0, 'mac'], ['Windows NT', 0, 'windows'], ['X11; Linux x86_64', 0, 'linux'], ['OpenHarmony Android', 5, 'ohos']]) {
    assert.equal(preferredDownloadFamily(groups, agent, touch).id, expected);
  }
  assert.equal(preferredDownloadFamily(groups.slice(0, 2), 'Linux').id, 'mac');
  assert.equal(preferredDownloadFamily([], 'Linux'), undefined);
  assert.equal(detectedDownloadFamily('unrecognized browser'), undefined);
});

test('Android editions share one platform tab while preserving separate installer identities', () => {
  const group=groupDownloads(items).find(group=>group.id==='android');
  assert.deepEqual(group.items.map(item=>item.id),['android','android-large']);
  assert.deepEqual(group.items.map(downloadVariant),['手机 / 平板','车机 / TV']);
  assert.notEqual(group.items[0].channels[0].url,group.items[1].channels[0].url);
});
