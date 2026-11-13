"""Prepare a publishing bundle from verified four-platform build output."""
import argparse
import copy
import datetime
import json
import re
import shutil
import urllib.request
from pathlib import Path
from release_packages import digest, require


def prepare(build_dir, template, notes_path, output, revision, previous):
    build_dir, output = Path(build_dir), Path(output)
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{0,39}', revision), 'Use a short lowercase revision, e.g. sync-fix-1')
    require(not output.exists() or not any(output.iterdir()), 'Output must be empty; resume with publish_release.py instead')
    build = json.loads((build_dir / 'build-info.json').read_text())
    candidate = copy.deepcopy(template)
    version, source = build['version'], build['source']
    require(candidate['version'] == version, 'Update the release manifest/history template to the build version first')
    require(re.fullmatch(r'\d+\.\d+\.\d+', version), 'Only stable release versions are supported')
    require(tuple(map(int, version.split('.'))) >= tuple(map(int, previous['version'].split('.'))), 'Refusing a version downgrade')
    require(any(h['version'] == version for h in candidate['history']), 'Release history entry missing')
    output.mkdir(parents=True, exist_ok=True)
    ids = {'macOS': 'mac', 'iOS': 'ios', 'Android': 'android', 'Windows': 'windows'}
    if any(p['platform'] == 'HarmonyOS NEXT' for p in build['platforms']):
        ids['HarmonyOS NEXT'] = 'ohos'
    for package in build['platforms']:
        path = build_dir / package['file']
        require(path.stat().st_size == package['bytes'] and digest(path) == package['sha256'], 'Build output changed: ' + path.name)
        prefix = 'BiliMusic_' + version + '_'
        require(path.name.startswith(prefix), 'Expected versioned build filename')
        name = prefix + revision + '_' + path.name[len(prefix):]
        shutil.copy2(path, output / name)
        package['file'] = name
        platform = next(p for p in candidate['platforms'] if p['id'] == ids[package['platform']])
        platform.update(version=version, file=name, size=package['bytes'], sha256=package['sha256'], status='available')
        for channel in platform['channels']:
            root = {'github': 'https://github.com/licpp/BiliMusic-Desktop', 'gitee': 'https://gitee.com/yoaker/BiliMusic-Desktop'}[channel['id']]
            channel['url'] = root + '/releases/download/v' + version + '/' + name
    build.pop('releasePublished', None)
    build.pop('websiteChanged', None)
    build.update(purpose='release publication', packageRevision=revision, packagedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    for name in ['THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt'] + ['THIRD_PARTY_LICENSES-' + p.replace(' ', '-') + '.json' for p in ids]:
        shutil.copy2(build_dir / name, output / name)
    for name in ['android-bridge-acl.json', 'ios-bridge-acl.json']:
        if (build_dir / name).exists():
            shutil.copy2(build_dir / name, output / name)
    notes = Path(notes_path).read_text()
    if source not in notes:
        notes += f'\n安装包构建源码：[{source}](https://github.com/licpp/BiliMusic-Desktop/commit/{source})。\n'
    (output / 'RELEASE_NOTES.md').write_text(notes)
    (output / 'SHA256SUMS.txt').write_text(''.join(f"{p['sha256']}  {p['file']}\n" for p in build['platforms']))
    for name, value in [('build-info.json', build), ('candidate-releases.json', candidate), ('previous-releases.json', previous)]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', required=True)
    parser.add_argument('--manifest', default='website/releases.json')
    parser.add_argument('--notes', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--revision', required=True)
    args = parser.parse_args()
    with urllib.request.urlopen('https://bilimusic.cn/api/v1/releases', timeout=20) as response:
        previous = json.load(response)
    output = prepare(args.build_dir, json.loads(Path(args.manifest).read_text()), args.notes, args.output, args.revision, previous)
    print(json.dumps({'bundle': str(output), 'status': 'prepared'}, ensure_ascii=False))
