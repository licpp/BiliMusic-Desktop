const names = { mac: 'macOS', windows: 'Windows', android: 'Android', 'android-large': '车机 / TV', ios: 'iOS', ohos: '鸿蒙 NEXT', linux: 'Linux' };
export function downloadFamily(item) {
  const id = item.id.toLowerCase();
  if (id === 'android' || id.startsWith('android-')) return 'android';
  if (id.startsWith('linux')) return 'linux';
  if (id.startsWith('mac')) return 'mac';
  if (id.startsWith('windows')) return 'windows';
  return id;
}
export function groupDownloads(items) {
  const groups = new Map();
  const universal = items.find(item => item.id === 'android-large' && item.architecture === 'ARM64 / ARMv7' && item.status === 'available');
  for (const item of items) {
    if (universal && item.id === 'android-large-armv7' && item.file === universal.file && item.sha256 === universal.sha256 &&
        item.channels.every(channel => universal.channels.some(other => other.id === channel.id && other.url === channel.url))) continue;
    const id = downloadFamily(item);
    if (!groups.has(id)) groups.set(id, { id, name: names[id] || item.name, items: [] });
    groups.get(id).items.push(item);
  }
  return [...groups.values()];
}
export function downloadVariant(item) {
  const family = downloadFamily(item);
  if (family === 'android') return item.id.startsWith('android-large') ? `车机 / TV · ${largeScreenBitness(item)}` : '手机 / 平板';
  if (family === 'ios') return 'iPhone / iPad';
  if (family === 'ohos') return '未签名 HAP';
  const file = item.file || '';
  const intel = /intel|x86_64|x64/i.test(`${item.id} ${item.architecture} ${file}`);
  const arch = family === 'mac' ? (intel ? 'Intel' : 'Apple Silicon') : /arm64|aarch64/i.test(`${item.id} ${item.architecture} ${file}`) ? 'ARM64' : 'x64';
  return family === 'linux' ? `${arch} · ${/\.deb$/i.test(file) ? 'DEB' : 'AppImage'}` : arch;
}
export function largeScreenBitness(item) {
  if (item.architecture === 'ARM64 / ARMv7') return '32 / 64 位';
  return item.id === 'android-large-armv7' ? '32 位' : '64 位';
}
export function detectedDownloadFamily(userAgent, touchPoints = 0) {
  return /harmonyos|openharmony/i.test(userAgent) ? 'ohos' : /android/i.test(userAgent) ? 'android' : /iphone|ipad|ipod/i.test(userAgent) || (/macintosh/i.test(userAgent) && touchPoints > 1) ? 'ios'
    : /windows/i.test(userAgent) ? 'windows' : /mac/i.test(userAgent) ? 'mac' : /linux/i.test(userAgent) ? 'linux' : undefined;
}
export function preferredDownloadFamily(groups, userAgent, touchPoints = 0) {
  const preferred = detectedDownloadFamily(userAgent, touchPoints);
  return groups.find(group => group.id === preferred && group.items.some(item => item.status === 'available')) || groups[0];
}
