"""Prepare a publishing bundle from verified multi-platform build output."""
import argparse
import copy
import datetime
import json
import re
import shutil
import urllib.request
from pathlib import Path
from release_packages import checksum_list, digest, require, package_id, package_ids, license_name, validate_release_scope


def prepare(build_dir, template, notes_path, output, revision, previous, previous_updater=None, patch_changes=(), *,
            replace_android_build=False):
    build_dir, output = Path(build_dir), Path(output)
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', revision), 'Use a short lowercase revision, e.g. sync-fix-1')
    require(not output.exists() or not any(output.iterdir()), 'Output must be empty; resume with publish_release.py instead')
    build = json.loads((build_dir / 'build-info.json').read_text())
    version, source = build['version'], build['source']
    build.pop('replaceAndroidBuild', None)
    if replace_android_build:
        build['replaceAndroidBuild'] = True
    partial = replace_android_build or any(p.get('build', 0) > 1 for p in build['platforms'])
    if partial:
        require(previous_updater is not None and previous_updater['version'] == version, 'A platform patch requires the current updater feed')
        build['partialRelease'] = True
    candidate = copy.deepcopy(previous if partial else template)
    require(candidate['version'] == version, 'Update the release manifest/history template to the build version first')
    require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'Only stable release versions are supported')
    require(tuple(map(int, version.split('.'))) >= tuple(map(int, previous['version'].split('.'))), 'Refusing a version downgrade')
    history_entry = next((entry for entry in candidate['history'] if entry['version'] == version), None)
    require(history_entry is not None, 'Release history entry missing')
    if patch_changes:
        require(partial, 'Use the history template for a new release')
        history_entry['changes'] = [*patch_changes, *history_entry.get('changes', [])]
    output.mkdir(parents=True, exist_ok=True)
    original_names = {package_id(p): p['file'] for p in build['platforms']}
    for package in build['platforms']:
        path = build_dir / package['file']
        require(path.stat().st_size == package['bytes'] and digest(path) == package['sha256'], 'Build output changed: ' + path.name)
        prefix = 'BiliMusic_' + version + '_'
        require(path.name.startswith(prefix), 'Expected versioned build filename')
        name = prefix + revision + '_' + path.name[len(prefix):]
        shutil.copy2(path, output / name)
        package['file'] = name
        ids = package_ids(package)
        for key in ids:
            platform = next(p for p in candidate['platforms'] if p['id'] == key)
            platform.update(version=version, file=name, size=package['bytes'], sha256=package['sha256'], status='available')
            if partial:
                platform['sourceCommit'] = package['source']
            if 'build' in package:
                platform['build'] = package['build']
            if len(ids) == 2:
                platform.update(name='车机 / TV', architecture='ARM64 / ARMv7', sourceCommit=package['source'])
                platform.pop('note', None)
            channels = []
            for channel in platform['channels']:
                root = {'github': 'https://github.com/licpp/BiliMusic-Desktop', 'gitee': 'https://gitee.com/yoaker/BiliMusic-Desktop'}[channel['id']]
                channels.append(dict(channel, url=root + '/releases/download/v' + version + '/' + name))
            platform['channels'] = channels
    from updater_artifacts import prepare_updater
    validate_release_scope(build, candidate, previous)
    prepare_updater(build_dir, output, build, original_names, previous_updater if partial else None)
    build.pop('releasePublished', None)
    build.pop('websiteChanged', None)
    build.update(purpose='release publication', packageRevision=revision, packagedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    for name in ['THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt'] + list(dict.fromkeys(license_name(p, build['platforms']) for p in build['platforms'])):
        shutil.copy2(build_dir / name, output / name)
    for name in ['android-bridge-acl.json', 'ios-bridge-acl.json']:
        if (build_dir / name).exists():
            shutil.copy2(build_dir / name, output / name)
    notes = Path(notes_path).read_text()
    if source not in notes:
        notes += f'\n安装包构建源码：[{source}](https://github.com/licpp/BiliMusic-Desktop/commit/{source})。\n'
    (output / 'RELEASE_NOTES.md').write_text(notes)
    (output / 'SHA256SUMS.txt').write_text(checksum_list(build, candidate))
    for name, value in [('build-info.json', build), ('candidate-releases.json', candidate), ('previous-releases.json', previous)]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    if partial:
        (output / 'previous-updater.json').write_text(json.dumps(previous_updater, ensure_ascii=False, indent=2) + '\n')
        shutil.copy2(output / 'build-info.json', output / f'build-info-{revision}.json')
        for name in {license_name(p, build['platforms']) for p in build['platforms']}:
            shutil.copy2(output / name, output / f'{Path(name).stem}-{revision}.json')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', required=True)
    parser.add_argument('--manifest', default='website/releases.json')
    parser.add_argument('--notes', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--previous-manifest', help='Local baseline manifest for preparing an offline candidate')
    parser.add_argument('--previous-updater', help='Current signed updater feed, required for platform patches')
    parser.add_argument('--patch-change', action='append', default=[], help='Prepend an entry to the current version website changelog')
    parser.add_argument('--replace-android-build', action='store_true',
                        help='Replace the current Android phone/tablet APK at the same build number using a new asset name')
    args = parser.parse_args()
    if args.previous_manifest:
        previous = json.loads(Path(args.previous_manifest).read_text())
    else:
        with urllib.request.urlopen('https://bilimusic.cn/api/v1/releases', timeout=20) as response:
            previous = json.load(response)
    updater = json.loads(Path(args.previous_updater).read_text()) if args.previous_updater else None
    output = prepare(args.build_dir, json.loads(Path(args.manifest).read_text()), args.notes, args.output,
                     args.revision, previous, updater, args.patch_change,
                     replace_android_build=args.replace_android_build)
    print(json.dumps({'bundle': str(output), 'status': 'prepared'}, ensure_ascii=False))
