"""Signed desktop OTA assets, kept separate from normal installer packaging."""
import base64
import json
import plistlib
import shutil
import tarfile
from pathlib import Path
from release_packages import require, digest, package_id, apple_build

KEY = Path(__file__).resolve().parents[1] / 'src-tauri/update-public-key.txt'
TARGETS = {'mac': 'darwin-aarch64', 'mac-intel': 'darwin-x86_64',
           'windows': 'windows-x86_64', 'windows-arm64': 'windows-aarch64'}


def updater_target(package):
    return TARGETS.get(package_id(package))


def signature_text(path):
    text = Path(path).read_text().strip()
    try:
        decoded = base64.b64decode(text, validate=True).decode()
        signature = base64.b64decode(decoded.splitlines()[1], validate=True)
        public = base64.b64decode(base64.b64decode(KEY.read_text().strip()).decode().splitlines()[1])
        require(len(signature) == 74 and signature[2:10] == public[2:10], 'OTA signature belongs to a different key')
    except (ValueError, IndexError, UnicodeError):
        raise ValueError('Invalid OTA signature or updater key') from None
    return text


def prepare_updater(build_dir, output, build, original_names, previous=None):
    build_dir, output = Path(build_dir), Path(output)
    manifest = {'version': build['version'], 'platforms': dict(previous['platforms']) if previous else {}}
    for package in build['platforms']:
        kind = package['platform']
        target = updater_target(package)
        if not target:
            continue
        build_number = package.get('build', 0)
        if kind == 'macOS':
            original = original_names.get(package_id(package), original_names.get(kind))
            exact = build_dir / original.replace('.dmg', '.app.tar.gz') if original and original.endswith('.dmg') else None
            archives = [exact] if exact and exact.is_file() else list(build_dir.glob('*.app.tar.gz'))
            require(len(archives) <= 1, 'Ambiguous macOS OTA archives')
            if not archives:
                require(not build_number, 'macOS OTA archive missing')
                continue
            archive = archives[0]
            with tarfile.open(archive, 'r:gz') as tar:
                info = next((m for m in tar.getmembers() if m.name.endswith('.app/Contents/Info.plist')), None)
                require(info and info.size < 1024 * 1024, 'OTA app metadata missing')
                data = plistlib.loads(tar.extractfile(info).read())
                require(data.get('CFBundleIdentifier') == 'app.resonance.desktop' and data.get('CFBundleShortVersionString') == build['version'], 'OTA app identity/version mismatch')
                if build_number:
                    require(data.get('CFBundleVersion') == apple_build(build['version'], build_number), 'OTA app build number mismatch')
            name = package['file'].removesuffix('.dmg') + '.app.tar.gz'
            source = archive
        else:
            source = build_dir / original_names.get(package_id(package), original_names.get(kind))
            name = package['file']
        sig = Path(str(source) + '.sig')
        require((kind != 'macOS' and not build_number) or sig.is_file(), 'Desktop OTA signature missing')
        if not sig.is_file():
            continue
        signature = signature_text(sig)
        if kind == 'macOS':
            shutil.copy2(source, output / name)
        shutil.copy2(sig, output / (name + '.sig'))
        manifest['platforms'][target] = {'signature': signature, 'url': 'https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/v' + build['version'] + '/' + name,
                                          'size': (output / name).stat().st_size, 'sha256': digest(output / name)}
        if build_number:
            manifest['platforms'][target]['build'] = build_number
    # An explicit empty feed prevents retaining an updater for an older release.
    (output / 'updater.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest


def updater_assets(bundle, version, targets=None, previous=None):
    bundle = Path(bundle)
    path = bundle / 'updater.json'
    if not path.exists():
        require(previous is None and not any((targets or {}).values()), 'Missing updater feed')
        return None, []
    manifest = json.loads(path.read_text())
    platforms = manifest['platforms']
    require(manifest['version'] == version and set(platforms) <= set(TARGETS.values()), 'Invalid OTA release version/platform')
    for target, build_number in (targets or {}).items():
        if build_number:
            require(platforms.get(target, {}).get('build') == build_number, 'OTA build differs from installer')
    if previous is not None:
        require(previous['version'] == version, 'Previous OTA version mismatch')
        unchanged = {k: v for k, v in platforms.items() if k not in targets}
        require(unchanged == {k: v for k, v in previous['platforms'].items() if k not in targets}, 'Unbuilt OTA platform changed')
    names = {'updater.json': False}
    for target, entry in platforms.items():
        if previous is not None and target not in targets:
            continue
        prefix = 'https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/v' + version + '/'
        require(entry['url'].startswith(prefix), 'Unexpected OTA download host/version')
        name = entry['url'][len(prefix):]
        require(Path(name).name == name and name not in ('', '.', '..') and '%' not in name, 'Unsafe OTA asset name')
        asset = bundle / name
        require(asset.stat().st_size == entry['size'] and digest(asset) == entry['sha256'], 'OTA archive changed')
        require(signature_text(bundle / (name + '.sig')) == entry['signature'], 'OTA signature does not match feed')
        names[name], names[name + '.sig'] = True, False
    return manifest, [{'name': name, 'size': (bundle/name).stat().st_size, 'sha256': digest(bundle/name), 'binary': binary} for name, binary in names.items()]
