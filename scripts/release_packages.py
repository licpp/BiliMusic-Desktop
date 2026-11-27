import io
import tarfile
"""Validate a multi-platform bundle before any publishing credentials are used."""
import hashlib
import json
import plistlib
import re
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


def package_id(package):
    platform = package['platform']
    arch = package.get('architecture') or ('arm64' if platform == 'macOS' else 'x64')
    if platform == 'Linux':
        return 'linux-' + arch + ('-deb' if package['file'].endswith('.deb') else '-appimage')
    if platform == 'macOS':
        return 'mac-intel' if arch == 'x64' else 'mac'
    if platform == 'Windows':
        return 'windows-arm64' if arch == 'arm64' else 'windows'
    if platform == 'Android Large Screen' and arch == 'armv7':
        return 'android-large-armv7'
    return {'iOS': 'ios', 'Android': 'android', 'HarmonyOS NEXT': 'ohos', 'Android Large Screen': 'android-large'}[platform]


def package_ids(package):
    primary = package_id(package)
    if primary == 'android-large' and package.get('architecture') == 'universal':
        return (primary, 'android-large-armv7')
    return (primary,)


def license_name(package, packages):
    if sum(p['platform'] == package['platform'] for p in packages) > 1:
        return 'THIRD_PARTY_LICENSES-' + package_id(package) + '.json'
    return 'THIRD_PARTY_LICENSES-' + package['platform'].replace(' ', '-') + '.json'


def checksum_list(build, manifest):
    if build.get('partialRelease'):
        return ''.join(dict.fromkeys(f"{p['sha256']}  {p['file']}\n" for p in manifest['platforms'] if p['status'] == 'available'))
    return ''.join(f"{p['sha256']}  {p['file']}\n" for p in build['platforms'])


def compatible_package_source(platform, built, release):
    changed = command(['git', 'diff', '--name-only', built, release]).splitlines()
    # The standard frontend entry does not import the car-only application.
    common = ('scripts/', 'tests/', 'src/large-screen/')
    allowed = ('native/android-player/',) if platform != 'Android' else ()
    if platform == 'iOS':
        allowed += ('native/ios-player/', 'src/features/settings/SettingsView.tsx', 'src/services/floatingLyrics.ts')
    return bool(changed) and all(n.startswith(common + allowed) for n in changed)


def apple_build(version, build):
    major, minor, patch = map(int, version.split('.'))
    return f'{1000 + major * 100 + minor}.{patch}.{49 + build}'


def verify_android_bridge(dex):
    # Rust looks up the getter by name through JNI. Keep it through R8 shrinking.
    require(b'getPluginManager\0' in dex, 'Android Tauri plugin manager getter removed')
    for name in ['PlayerPlugin', 'PlayArgs', 'ControlArgs', 'SecretArgs']:
        require(('Lapp/bilimusic/player/' + name + ';').encode() in dex, 'Android bridge removed: ' + name)


def verify_android_libraries(archive, architecture):
    arm64 = ('arm64-v8a', 2, 183)
    armv7 = ('armeabi-v7a', 1, 40)
    architectures = {'arm64': (arm64,), 'armv7': (armv7,), 'universal': (arm64, armv7)}
    expected = {abi: (elf_class, machine) for abi, elf_class, machine in architectures[architecture]}
    libraries = [x for x in archive.infolist() if x.filename.endswith('.so')]
    require(all(f'lib/{abi}/libbilimusic_lib.so' in archive.namelist() for abi in expected), 'Android application library missing')
    for library in libraries:
        match = re.fullmatch(r'lib/([^/]+)/[^/]+\.so', library.filename)
        require(match and match[1] in expected and library.file_size < 30 * 1024 * 1024, 'Unexpected Android native library')
        elf_class, machine = expected[match[1]]
        with archive.open(library) as binary:
            header = binary.read(20)
        require(len(header) == 20 and header[:6] == b'\x7fELF' + bytes([elf_class, 1]) and struct.unpack_from('<H', header, 18)[0] == machine, 'Android ELF architecture mismatch')


def verify_native(path, platform, version, certificate, architecture='arm64', build=0):
    if platform == 'macOS':
        command(['hdiutil', 'verify', str(path)])
        with tempfile.TemporaryDirectory(prefix='bilimusic-release-mac-') as mount:
            command(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, str(path)])
            try:
                app = Path(mount) / 'BiliMusic.app'
                info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
                require(info['CFBundleIdentifier'] == 'app.resonance.desktop', 'Unexpected macOS identity')
                require(info['CFBundleShortVersionString'] == version, 'Unexpected macOS version')
                if build:
                    require(info['CFBundleVersion'] == apple_build(version, build), 'Unexpected macOS build number')
                binary = app / 'Contents/MacOS' / info['CFBundleExecutable']
                expected_arch = 'x86_64' if '_x64' in path.name or '_intel' in path.name.lower() else 'arm64'
                require(command(['lipo', '-archs', str(binary)]) == expected_arch, 'Unexpected macOS architecture')
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
            if build:
                require(info['CFBundleVersion'] == apple_build(version, build), 'Unexpected iOS build number')
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
    elif platform in ('Android', 'Android Large Screen'):
        require(certificate == ANDROID_CERTIFICATE and apk_certificate(path) == certificate, 'Android signing certificate changed')
        with zipfile.ZipFile(path) as archive:
            require(archive.testzip() is None, 'Corrupt APK')
            manifest = apk_manifest(archive.read('AndroidManifest.xml'))
            major, minor, patch = map(int, version.split('.'))
            expected_id = 'app.bilimusic.large' if platform == 'Android Large Screen' else 'app.bilimusic.mobile'
            require(manifest['package'] == expected_id and manifest['versionName'] == version and manifest['versionCode'] == major * 1000000 + minor * 10000 + patch * 100 + max(build - 1, 0), 'Android identity/versionCode mismatch')
            require(architecture != 'universal' or platform == 'Android Large Screen', 'Universal APK is only expected for the large-screen edition')
            verify_android_libraries(archive, architecture)
            dex = b''.join(archive.read(x.filename) for x in archive.infolist() if x.filename.endswith('.dex'))
            verify_android_bridge(dex)
    elif platform == 'HarmonyOS NEXT':
        with zipfile.ZipFile(path) as archive:
            require(archive.testzip() is None, 'Corrupt HAP')
            app = json.loads(archive.read('module.json'))['app']
            major, minor, patch = map(int, version.split('.'))
            require(app['bundleName'] == 'app.bilimusic.harmony' and app['versionName'] == version and app['versionCode'] == major * 1000000 + minor * 10000 + patch * 100 + max(build - 1, 0), 'Harmony identity/version mismatch')
            binary = archive.read('libs/arm64-v8a/libbilimusic_lib.so')
            require(binary[:4] == b'\x7fELF' and int.from_bytes(binary[18:20], 'little') == 183, 'Expected ARM64 Harmony binary')
            require(len(archive.read('ets/modules.abc')) > 1000, 'Harmony bytecode missing')
    elif platform == 'Linux':
        expected_arch = 'arm64' if '_arm64' in path.name else 'amd64'
        if path.suffix == '.deb':
            members = command(['ar', 't', str(path)]).splitlines()
            require('debian-binary' in members, 'Invalid Debian archive')
            control = next((n for n in members if n.startswith('control.tar')), None)
            require(control, 'Debian control archive missing')
            raw = subprocess.check_output(['ar', 'p', str(path), control])
            with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as archive:
                member = next(m for m in archive.getmembers() if m.name.removeprefix('./') == 'control')
                fields = archive.extractfile(member).read().decode()
            native_version = f'{version}-{build}' if build > 1 else version
            require('Package: bili-music\n' in fields and 'Version: ' + native_version + '\n' in fields and 'Architecture: ' + expected_arch + '\n' in fields, 'Debian identity/version/architecture mismatch')
            dependencies = next((line[8:].split(',') for line in fields.splitlines() if line.startswith('Depends:')), [])
            names = {item.strip().split(' ', 1)[0] for item in dependencies if '|' not in item}
            require({'libgtk-3-0', 'libwebkit2gtk-4.1-0', 'libayatana-appindicator3-1'} <= names, 'Debian runtime dependency missing')
        else:
            raw = path.read_bytes()[:64]
            require(raw[:4] == b'\x7fELF' and raw[8:11] == b'AI\x02', 'Expected AppImage type 2')
            require(int.from_bytes(raw[18:20], 'little') == (183 if expected_arch == 'arm64' else 62), 'Unexpected AppImage architecture')
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


def preserves_release_history(history, previous, version):
    if history == previous:
        return True
    if not isinstance(history, list) or not isinstance(previous, list) or len(history) != len(previous):
        return False
    for current, original in zip(history, previous):
        if current == original:
            continue
        if not isinstance(current, dict) or not isinstance(original, dict) or original.get('version') != version:
            return False
        if {
            key: value for key, value in current.items() if key != 'changes'
        } != {key: value for key, value in original.items() if key != 'changes'}:
            return False
        changes, prior = current.get('changes'), original.get('changes', [])
        if not isinstance(changes, list) or not isinstance(prior, list) or len(changes) <= len(prior):
            return False
        count = len(changes) - len(prior)
        if changes[count:] != prior or not all(isinstance(note, str) and note.strip() for note in changes[:count]):
            return False
    return True


def validate_release_scope(build, manifest, previous):
    packages = build['platforms']
    version = build['version']
    require(manifest['version'] == version, 'Build and manifest versions differ')
    ids = [key for p in packages for key in package_ids(p)]
    require(ids and len(ids) == len(set(ids)), 'Expected distinct built platforms, including every declared edition')
    manifest_ids = [p['id'] for p in manifest['platforms']]
    require(len(manifest_ids) == len(set(manifest_ids)), 'Duplicate manifest platform')
    if build.get('partialRelease'):
        prior = {p['id']: p for p in previous['platforms']}
        require(version == previous['version'] and set(prior) == set(manifest_ids) and set(ids) <= set(prior), 'Platform patches must preserve the release and platform list')
        shared_keys_excluded = {'platforms', 'history'}
        require({k: v for k, v in manifest.items() if k not in shared_keys_excluded} == {k: v for k, v in previous.items() if k not in shared_keys_excluded}, 'Platform patches must preserve shared release information')
        require(preserves_release_history(manifest.get('history', []), previous.get('history', []), version), 'Platform patches may only add notes to the current release history')
        current = {p['id']: p for p in manifest['platforms']}
        require(all(current[i] == prior[i] for i in prior.keys() - set(ids)), 'Unbuilt platform entry changed')
        for package, key in ((p, key) for p in packages for key in package_ids(p)):
            old, new = prior[key], current[key]
            build_number = package.get('build')
            require(old.get('version', version) == version and new.get('version', version) == version, 'Platform patch version mismatch')
            require(type(build_number) is int and build_number > max(1, old.get('build', 0)) and build_number <= 50, 'Platform build must increase')
            require(new.get('build') == build_number and new['file'] != old['file'], 'Platform patch must use a new asset name')
        return
    require({'macOS', 'iOS', 'Android', 'Windows'} <= {p['platform'] for p in packages}, 'Expected core release platforms')
    require(set(manifest_ids) in (set(ids), set(ids) | {'ohos'}), 'Expected release platforms with optional retained Harmony test package')
    require(all(type(p.get('build', 0)) is int and p.get('build', 0) in (0, 1) for p in packages), 'New release packages must use the first build')
    if version == previous.get('version'):
        require(not any(p.get('build', 0) for p in previous['platforms']), 'An active build-aware version must use platform patches')
    if 'ohos' in manifest_ids and 'ohos' not in ids:
        harmony = next(p for p in manifest['platforms'] if p['id'] == 'ohos')
        require(harmony == next((p for p in previous.get('platforms', []) if p['id'] == 'ohos'), None), 'Publication must preserve the existing Harmony package')
        require(re.fullmatch(r'\d+\.\d+\.\d+', harmony.get('version', '')) and harmony.get('signature') == 'unsigned' and harmony.get('releaseStatus') == 'experimental', 'Retained Harmony test package must have its own version and signing status')


def validate_bundle(bundle, native_verifier=verify_native):
    bundle = Path(bundle)
    build = json.loads((bundle / 'build-info.json').read_text())
    manifest = json.loads((bundle / 'candidate-releases.json').read_text())
    previous = json.loads((bundle / 'previous-releases.json').read_text())
    version, source = build['version'], build['source']
    require(len(source) == 40 and all(c in '0123456789abcdef' for c in source), 'Invalid source commit')
    packages = build['platforms']
    validate_release_scope(build, manifest, previous)
    certificate = build['validation'].get('androidCertificateSha256')
    assets = []
    for package in build['platforms']:
        name = package['file']
        require(Path(name).name == name and name not in ('.', '..'), 'Unsafe asset name')
        path = bundle / name
        require(package['version'] == version, 'Mixed build sources or versions')
        if package['source'] != source:
            require(re.fullmatch(r'[a-f0-9]{40}', package['source']) and compatible_package_source(package['platform'], package['source'], source), 'Mixed build sources or versions')
        require(path.stat().st_size == package['bytes'] and digest(path) == package['sha256'], 'Package digest mismatch: ' + name)
        number = package.get('build', 0)
        entries = [next(p for p in manifest['platforms'] if p['id'] == key) for key in package_ids(package)]
        for entry in entries:
            require(entry['file'] == name and entry['size'] == package['bytes'] and entry['sha256'] == package['sha256'] and entry['status'] == 'available', 'Manifest does not match package: ' + name)
            require({c['id'] for c in entry['channels']} == {'github', 'gitee'} and len(entry['channels']) == 2, 'Expected both download channels')
            require(entry.get('build', 0) == number, 'Manifest build does not match package')
        if len(entries) == 2:
            require(all(p.get('architecture') == 'ARM64 / ARMv7' for p in entries) and
                    {c['id']: c['url'] for c in entries[0]['channels']} == {c['id']: c['url'] for c in entries[1]['channels']}, 'Universal APK entries must share both download channels')
        args = (path, package['platform'], version, certificate, package.get('architecture', 'arm64'))
        native_verifier(*args, number) if number else native_verifier(*args)
        assets.append({'name': name, 'size': path.stat().st_size, 'sha256': digest(path), 'binary': True})
    sums = checksum_list(build, manifest)
    require((bundle / 'SHA256SUMS.txt').read_text() == sums, 'SHA256SUMS does not match packages')
    notices = list(dict.fromkeys(license_name(p, packages) for p in packages))
    for package in packages:
        data = json.loads((bundle / license_name(package, packages)).read_text())
        require(data['version'] == version and data['sourceCommit'] == package['source'], 'Dependency notices source mismatch')
    metadata = ['SHA256SUMS.txt', 'build-info.json', 'THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt'] + notices
    if build.get('partialRelease'):
        revision = build['packageRevision']
        require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', revision), 'Invalid platform patch label')
        patched = f'build-info-{revision}.json'
        require((bundle / patched).read_bytes() == (bundle / 'build-info.json').read_bytes(), 'Patch provenance differs from build information')
        metadata = ['SHA256SUMS.txt', patched]
        for name in notices:
            filename = f'{Path(name).stem}-{revision}.json'
            require((bundle / filename).read_bytes() == (bundle / name).read_bytes(), 'Patch license notice differs from original')
            metadata.append(filename)
    for name in metadata:
        path = bundle / name
        assets.append({'name': name, 'size': path.stat().st_size, 'sha256': digest(path), 'binary': False})
    from updater_artifacts import updater_assets, updater_target
    previous_updater = json.loads((bundle / 'previous-updater.json').read_text()) if build.get('partialRelease') else None
    targets = {target: p.get('build', 0) for p in packages if (target := updater_target(p))}
    updater, extras = updater_assets(bundle, version, targets, previous_updater)
    known = {a['name'] for a in assets}
    assets.extend(a for a in extras if a['name'] not in known)
    notes = (bundle / 'RELEASE_NOTES.md').read_text()
    require(source in notes, 'Release notes must pin the package source commit')
    return {'version': version, 'source': source, 'tag': 'v' + version, 'manifest': manifest, 'previous': previous,
            'assets': assets, 'notes': notes, **({'updater': updater} if updater is not None else {}),
            **({'previousUpdater': previous_updater} if previous_updater is not None else {}),
            'ciRuns': build.get('ciRuns', {}), 'platformSources': {**{p['platform']: p['source'] for p in build['platforms']}, **{package_id(p): p['source'] for p in build['platforms']}}, 'revision': build.get('packageRevision', source[:7])}
