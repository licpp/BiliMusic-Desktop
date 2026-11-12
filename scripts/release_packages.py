"""Validate a four-platform bundle before any publishing credentials are used."""
import hashlib
import json
import plistlib
import struct
import subprocess
import tempfile
import zipfile
from pathlib import Path

ANDROID_CERTIFICATE = 'fda2fb923f07c11e93f36f1bba1d1fc6036d67b382b1a64e5f22da51ec756bc2'


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(path):
    with Path(path).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def command(args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, timeout=120).decode().strip()


def apk_certificate(path):
    raw = Path(path).read_bytes()
    def u32(data, offset):
        return struct.unpack_from('<I', data, offset)[0]
    def length_prefixed(data, offset=0):
        size = u32(data, offset)
        require(offset + 4 + size <= len(data), 'Invalid APK signature block')
        return data[offset + 4:offset + 4 + size], offset + 4 + size
    end = raw.rfind(b'PK\x05\x06', max(0, len(raw) - 65557))
    require(end >= 0, 'APK ZIP directory missing')
    central = u32(raw, end + 16)
    require(raw[central - 16:central] == b'APK Sig Block 42', 'APK signing block missing')
    size = struct.unpack_from('<Q', raw, central - 24)[0]
    start = central - size - 8
    require(struct.unpack_from('<Q', raw, start)[0] == size, 'APK signing block size mismatch')
    offset = start + 8
    while offset < central - 24:
        size = struct.unpack_from('<Q', raw, offset)[0]
        offset += 8
        kind = u32(raw, offset)
        value = raw[offset + 4:offset + size]
        offset += size
        if kind == 0x7109871a:
            signers, _ = length_prefixed(value)
            signer, _ = length_prefixed(signers)
            signed, _ = length_prefixed(signer)
            _, position = length_prefixed(signed)
            certificates, _ = length_prefixed(signed, position)
            certificate, _ = length_prefixed(certificates)
            return hashlib.sha256(certificate).hexdigest()
    raise ValueError('APK v2 signature missing')


def apk_manifest(raw):
    strings, offset, result = [], 8, {}
    def u32(position):
        return struct.unpack_from('<I', raw, position)[0]
    def length8(position):
        value = raw[position]
        return (((value & 127) << 8) | raw[position + 1], position + 2) if value & 128 else (value, position + 1)
    while offset + 8 <= len(raw):
        kind, header, size = struct.unpack_from('<HHI', raw, offset)
        require(size >= 8 and offset + size <= len(raw), 'Invalid Android manifest')
        if kind == 1:
            count, _, flags, start, _ = struct.unpack_from('<IIIII', raw, offset + 8)
            for index in range(count):
                position = offset + start + u32(offset + header + 4 * index)
                if flags & 256:
                    _, position = length8(position)
                    length, position = length8(position)
                    value = raw[position:position + length].decode('utf8')
                else:
                    length = struct.unpack_from('<H', raw, position)[0]
                    position += 2
                    if length & 32768:
                        length = ((length & 32767) << 16) | struct.unpack_from('<H', raw, position)[0]
                        position += 2
                    value = raw[position:position + length * 2].decode('utf-16le')
                strings.append(value)
        elif kind == 0x102 and strings[u32(offset + 20)] == 'manifest':
            start, attribute_size, count = struct.unpack_from('<HHH', raw, offset + 24)
            for index in range(count):
                position = offset + 16 + start + index * attribute_size
                name, value, data = strings[u32(position + 4)], u32(position + 8), u32(position + 16)
                result[name] = strings[value] if value != 0xffffffff else strings[data] if raw[position + 15] == 3 else data
        offset += size
    return result


def verify_native(path, platform, version, certificate):
    if platform == 'macOS':
        command(['hdiutil', 'verify', str(path)])
        with tempfile.TemporaryDirectory(prefix='bilimusic-release-mac-') as mount:
            command(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, str(path)])
            try:
                app = Path(mount) / 'BiliMusic.app'
                info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
                require(info['CFBundleIdentifier'] == 'app.resonance.desktop', 'Unexpected macOS identity')
                require(info['CFBundleShortVersionString'] == version, 'Unexpected macOS version')
                binary = app / 'Contents/MacOS' / info['CFBundleExecutable']
                require(command(['lipo', '-archs', str(binary)]) == 'arm64', 'Expected Apple Silicon app')
                command(['codesign', '--verify', '--deep', '--strict', str(app)])
            finally:
                command(['hdiutil', 'detach', mount])
    elif platform == 'iOS':
        with zipfile.ZipFile(path) as archive:
            require(archive.testzip() is None, 'Corrupt IPA')
            prefix = 'Payload/BiliMusic.app/'
            info = plistlib.loads(archive.read(prefix + 'Info.plist'))
            require(info['CFBundleIdentifier'] == 'app.bilimusic.ios', 'Unexpected iOS identity')
            require(info['CFBundleShortVersionString'] == version, 'Unexpected iOS version')
            require('iPhoneOS' in info['CFBundleSupportedPlatforms'] and 'audio' in info['UIBackgroundModes'], 'Expected real-device app with background audio')
            require(not any(n.endswith('/libapp.a') for n in archive.namelist()), 'Unlinked Rust archive included in IPA')
            raw = archive.read(prefix + info['CFBundleExecutable'])
            require(struct.unpack_from('<II', raw) == (0xfeedfacf, 0x100000c), 'Expected ARM64 Mach-O')
            offset, device = 32, False
            for _ in range(struct.unpack_from('<I', raw, 16)[0]):
                kind, size = struct.unpack_from('<II', raw, offset)
                if kind == 0x32:
                    device = struct.unpack_from('<I', raw, offset + 8)[0] == 2
                offset += size
            require(device, 'IPA is not an iOS device binary')
    elif platform == 'Android':
        require(certificate == ANDROID_CERTIFICATE and apk_certificate(path) == certificate, 'Android signing certificate changed')
        with zipfile.ZipFile(path) as archive:
            require(archive.testzip() is None, 'Corrupt APK')
            manifest = apk_manifest(archive.read('AndroidManifest.xml'))
            major, minor, patch = map(int, version.split('.'))
            require(manifest['package'] == 'app.bilimusic.mobile' and manifest['versionName'] == version and manifest['versionCode'] == major * 1000000 + minor * 10000 + patch * 100, 'Android identity/versionCode mismatch')
            libraries = [x for x in archive.infolist() if x.filename.endswith('.so')]
            require(libraries and all(x.filename.startswith('lib/arm64-v8a/') and x.file_size < 30 * 1024 * 1024 for x in libraries), 'Unexpected Android native libraries')
            dex = b''.join(archive.read(x.filename) for x in archive.infolist() if x.filename.endswith('.dex'))
            for name in ['PlayerPlugin', 'PlayArgs', 'ControlArgs', 'SecretArgs']:
                require(('Lapp/bilimusic/player/' + name + ';').encode() in dex, 'Android bridge removed: ' + name)
    elif platform == 'Windows':
        raw = path.read_bytes()
        require(raw[:2] == b'MZ', 'Expected Windows executable')
        offset = struct.unpack_from('<I', raw, 60)[0]
        require(raw[offset:offset + 4] == b'PE\0\0' and struct.unpack_from('<H', raw, offset + 92)[0] == 2, 'Windows installer must use GUI subsystem')
        label = 'FileVersion\0'.encode('utf-16le')
        offset = raw.find(label)
        require(offset >= 0, 'Windows installer version missing')
        offset = (offset + len(label) + 3) & ~3
        actual = raw[offset:offset + 80].decode('utf-16le', errors='ignore').split('\0')[0]
        require(actual in (version, version + '.0'), 'Unexpected Windows installer version')


def validate_bundle(bundle, native_verifier=verify_native):
    bundle = Path(bundle)
    build = json.loads((bundle / 'build-info.json').read_text())
    manifest = json.loads((bundle / 'candidate-releases.json').read_text())
    previous = json.loads((bundle / 'previous-releases.json').read_text())
    version, source = build['version'], build['source']
    require(manifest['version'] == version, 'Build and manifest versions differ')
    require(len(source) == 40 and all(c in '0123456789abcdef' for c in source), 'Invalid source commit')
    ids = {'macOS': 'mac', 'iOS': 'ios', 'Android': 'android', 'Windows': 'windows'}
    require(len(build['platforms']) == 4 and {p['platform'] for p in build['platforms']} == set(ids), 'Expected exactly four built platforms')
    manifest_ids = [p['id'] for p in manifest['platforms']]
    require(len(manifest_ids) == len(set(manifest_ids)) and set(manifest_ids) in (set(ids.values()), set(ids.values()) | {'ohos'}), 'Expected four release platforms with optional retained Harmony test package')
    if 'ohos' in manifest_ids:
        harmony = next(p for p in manifest['platforms'] if p['id'] == 'ohos')
        require(harmony == next((p for p in previous.get('platforms', []) if p['id'] == 'ohos'), None), 'Four-platform publication must preserve the existing Harmony package')
        require(harmony.get('version') and harmony.get('signature') == 'unsigned' and harmony.get('releaseStatus') == 'experimental', 'Retained Harmony test package must have its own version and signing status')
    certificate = build['validation'].get('androidCertificateSha256')
    assets = []
    for package in build['platforms']:
        name = package['file']
        require(Path(name).name == name and name not in ('.', '..'), 'Unsafe asset name')
        path = bundle / name
        require(package['source'] == source and package['version'] == version, 'Mixed build sources or versions')
        require(path.stat().st_size == package['bytes'] and digest(path) == package['sha256'], 'Package digest mismatch: ' + name)
        entry = next(p for p in manifest['platforms'] if p['id'] == ids[package['platform']])
        require(entry['file'] == name and entry['size'] == package['bytes'] and entry['sha256'] == package['sha256'] and entry['status'] == 'available', 'Manifest does not match package: ' + name)
        require({c['id'] for c in entry['channels']} == {'github', 'gitee'} and len(entry['channels']) == 2, 'Expected both download channels')
        native_verifier(path, package['platform'], version, certificate)
        assets.append({'name': name, 'size': path.stat().st_size, 'sha256': digest(path), 'binary': True})
    sums = ''.join(f"{p['sha256']}  {p['file']}\n" for p in build['platforms'])
    require((bundle / 'SHA256SUMS.txt').read_text() == sums, 'SHA256SUMS does not match packages')
    for platform in ids:
        data = json.loads((bundle / f'THIRD_PARTY_LICENSES-{platform}.json').read_text())
        require(data['version'] == version and data['sourceCommit'] == source, 'Dependency notices source mismatch')
    for name in ['SHA256SUMS.txt', 'build-info.json', 'THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt'] + [f'THIRD_PARTY_LICENSES-{p}.json' for p in ids]:
        path = bundle / name
        assets.append({'name': name, 'size': path.stat().st_size, 'sha256': digest(path), 'binary': False})
    notes = (bundle / 'RELEASE_NOTES.md').read_text()
    require(source in notes, 'Release notes must pin the package source commit')
    return {'version': version, 'source': source, 'tag': 'v' + version, 'manifest': manifest, 'previous': previous,
            'assets': assets, 'notes': notes, 'ciRuns': build.get('ciRuns', {}), 'revision': build.get('packageRevision', source[:7])}
