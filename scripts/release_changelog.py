"""Generate BiliMusic release notes from the fragments in the built sources."""

import argparse
import copy
import datetime
import json
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRAGMENT_DIRECTORY = 'docs/changes'
GITHUB = 'https://github.com/licpp/BiliMusic-Desktop'
PLATFORMS = {
    'mac': 'macOS ARM64',
    'mac-intel': 'macOS Intel',
    'windows': 'Windows x64',
    'windows-arm64': 'Windows ARM64',
    'android': 'Android 手机 / 平板',
    'android-large': '车机 / TV ARM64',
    'android-large-armv7': '车机 / TV ARMv7',
    'ios': 'iOS',
    'ohos': 'HarmonyOS NEXT',
    'linux-x64-deb': 'Linux x64 DEB',
    'linux-x64-appimage': 'Linux x64 AppImage',
    'linux-arm64-deb': 'Linux ARM64 DEB',
    'linux-arm64-appimage': 'Linux ARM64 AppImage',
}
CATEGORIES = {'added': '新增', 'changed': '改进', 'fixed': '修复', 'internal': '内部维护'}
SLUG = r'[a-z0-9][a-z0-9-]{0,59}'
MAX_NOTE_GROUPS = 32
MAX_NOTE_CHANGES = 6
MAX_NOTE_BYTES = 48 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def headline(text):
    return (isinstance(text, str) and text == text.strip() and 0 < len(text) <= 120
            and text.isprintable() and len(text.encode()) <= 360 and not any(symbol in text for symbol in '<>`'))


def parse_fragment(name, raw):
    change_id = Path(name).stem
    require(re.fullmatch(SLUG, change_id), f'Invalid changelog fragment name: {name}')
    try:
        fragment = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError(f'Invalid changelog JSON: {name}: {error.msg}') from None
    require(isinstance(fragment, dict) and set(fragment) <= {'summary', 'kind', 'platforms', 'detail', 'pr'},
            f'Invalid changelog fields: {name}')
    kind, platforms = fragment.get('kind'), fragment.get('platforms')
    require(isinstance(kind, str) and kind in CATEGORIES and headline(fragment.get('summary')),
            f'Expected a changelog kind and a plain, one-line summary (max 120 characters): {name}')
    require(isinstance(platforms, list) and platforms and all(isinstance(p, str) for p in platforms)
            and len(set(platforms)) == len(platforms) and (platforms == ['all'] or set(platforms) <= PLATFORMS.keys()),
            f'Expected platform IDs or ["all"]: {name}')
    detail, pr = fragment.get('detail', ''), fragment.get('pr')
    require(isinstance(detail, str) and len(detail) <= 2000 and '\0' not in detail,
            f'Invalid changelog detail: {name}')
    require(pr is None or type(pr) is int and pr > 0, f'Invalid pull request number: {name}')
    return dict(fragment, id=change_id)


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], check=False,
                            capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError(f'Could not read changelog from local Git history: {result.stderr.decode().strip()}')
    return result.stdout


def fragments_between(repo, base, source):
    require(all(isinstance(commit, str) and re.fullmatch(r'[0-9a-f]{40}', commit) for commit in (base, source)),
            'Expected full commit IDs for the previous and built changelog sources')
    if base == source:
        return []
    changed = git(repo, 'diff', '--no-renames', '--name-only', '--diff-filter=A', '-z',
                  base, source, '--', FRAGMENT_DIRECTORY + '/').decode().split('\0')
    return [parse_fragment(path, git(repo, 'show', f'{source}:{path}'))
            for path in changed if re.fullmatch(f'{FRAGMENT_DIRECTORY}/{SLUG}\\.json', path)]


def collect_changes(targets, previous, repo=ROOT, fallback_base=None):
    prior = {entry['id']: entry for entry in previous['platforms']}
    comparisons = {}
    selected = {}
    for platform, (_, source) in targets.items():
        base = prior.get(platform, {}).get('sourceCommit') or fallback_base
        require(base, f'Previous source for {platform} is unknown. Use --changelog-base with its source commit.')
        comparison = (base, source)
        if comparison not in comparisons:
            comparisons[comparison] = fragments_between(repo, base, source)
        selected[platform] = [entry for entry in comparisons[comparison]
                              if entry['platforms'] == ['all'] or platform in entry['platforms']]
    return selected


def grouped_changes(selected):
    grouped = {}
    for platform, changes in selected.items():
        for change in changes:
            key = json.dumps(change, sort_keys=True)
            _, platforms = grouped.setdefault(key, (change, []))
            platforms.append(platform)
    return list(grouped.values())


def app_note_groups(version, targets, selected, previous):
    prior = {entry['id']: entry for entry in previous['platforms']}
    groups = {}
    for platform, changes in selected.items():
        build, _ = targets[platform]
        older = prior.get(platform, {})
        if older.get('version', previous['version']) == version and build <= older.get('build', 0):
            continue
        headlines = tuple((change['id'], change['summary']) for change in changes if change['kind'] != 'internal')
        if headlines:
            groups.setdefault(headlines[:MAX_NOTE_CHANGES], {})[platform] = build
    return [{'version': version, 'builds': builds, 'changes': [{'id': key, 'text': text} for key, text in changes]}
            for changes, builds in groups.items()]


def bound_notes(entries):
    bounded = []
    for entry in entries[:MAX_NOTE_GROUPS]:
        candidate = [*bounded, entry]
        if len(json.dumps(candidate, ensure_ascii=False, indent=2).encode()) > MAX_NOTE_BYTES:
            break
        bounded.append(entry)
    return bounded


def validate_note_history(notes, previous, targets, version):
    """Only the current published builds may add notes; old notes survive in order."""
    require(isinstance(previous, list), 'Previous update notes must be a list')
    require(isinstance(notes, list) and notes == bound_notes(notes), 'Update notes exceed the history budget')
    if notes == previous:
        return
    additions = []
    known = set()
    for entry in notes:
        if entry in previous:
            break
        require(isinstance(entry, dict) and set(entry) == {'version', 'builds', 'changes'} and entry['version'] == version,
                'Invalid update notes release')
        builds, changes = entry['builds'], entry['changes']
        require(isinstance(builds, dict) and builds and all(
            platform in targets and platform not in known and type(number) is int and number == targets[platform]
            for platform, number in builds.items()), 'Update notes reference an unpublished build or platform')
        known.update(builds)
        require(isinstance(changes, list) and 0 < len(changes) <= MAX_NOTE_CHANGES, 'Invalid update notes changes')
        ids = set()
        for change in changes:
            require(isinstance(change, dict) and set(change) == {'id', 'text'} and isinstance(change['id'], str)
                    and re.fullmatch(SLUG, change['id']) and change['id'] not in ids and headline(change['text']),
                    'Invalid or duplicate update note')
            ids.add(change['id'])
        additions.append(entry)
    require(notes == bound_notes([*additions, *previous]), 'Existing update notes must be preserved')


def render_groups(selected, published):
    lines = []
    grouped = grouped_changes(selected)
    for kind, label in CATEGORIES.items():
        items = [(change, platforms) for change, platforms in grouped if change['kind'] == kind]
        if not items:
            continue
        lines.extend((f'### {label}', ''))
        for change, platforms in items:
            scope = '、'.join(PLATFORMS[platform] for platform in platforms)
            prefix = f'**{scope}** · ' if set(platforms) != set(published) else ''
            pr = change.get('pr')
            pull = f' ([#{pr}]({GITHUB}/pull/{pr}))' if pr else ''
            lines.append(f'- {prefix}{change["summary"]}{pull}')
            if change.get('detail'):
                lines.extend(f'  {line}' for line in change['detail'].splitlines())
        lines.append('')
    return lines


def generate_changelog(candidate, previous, version, revision, targets, *, repo=ROOT, fallback_base=None):
    selected = collect_changes(targets, previous, repo, fallback_base)
    history = copy.deepcopy(previous['history'])
    candidate['history'] = history
    current = next((entry for entry in history if entry['version'] == version), None)
    if current is None:
        current = {'version': version, 'publishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   'kind': 'release', 'changes': []}
        history.insert(0, current)
    previous_changes = current.get('changes', [])
    highlights = list(dict.fromkeys(change['summary'] for change, _ in grouped_changes(selected)
                                    if change['kind'] != 'internal' and change['summary'] not in previous_changes))
    current['changes'] = [*highlights[:6], *previous_changes]
    previous_notes = previous.get('updateNotes', [])
    additions = app_note_groups(version, targets, selected, previous)
    combined = bound_notes([*additions, *previous_notes])
    if combined or 'updateNotes' in previous:
        candidate['updateNotes'] = combined

    packages = '、'.join(f'{PLATFORMS[platform]} {version}.{build}' if build else PLATFORMS[platform]
                        for platform, (build, _) in targets.items())
    lines = [f'# BiliMusic {version}', '', f'## 本次发布 · {revision}', '', f'安装包：{packages}', '']
    lines.extend(render_groups(selected, targets))
    if not any(selected.values()):
        lines.extend(('本次构建没有新增的更新日志条目。', ''))
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--check', action='store_true', help='Validate local changelog fragments')
    action.add_argument('--pending', action='store_true', help='Preview changes since each platform release')
    args = parser.parse_args()
    if args.check:
        files = sorted((ROOT / FRAGMENT_DIRECTORY).glob('*.json'))
        for file in files:
            parse_fragment(file.name, file.read_bytes())
        print(f'Validated {len(files)} changelog fragments')
    else:
        published = json.loads((ROOT / 'website/releases.json').read_text())
        source = git(ROOT, 'rev-parse', 'HEAD').decode().strip()
        targets = {entry['id']: (entry.get('build', 0), source) for entry in published['platforms']
                   if entry['status'] == 'available' and entry.get('sourceCommit')}
        pending = collect_changes(targets, published)
        print('## 待发布改动\n')
        print(f'源码 `{source[:12]}`，按已发布安装包的源码逐端比较。\n')
        print('\n'.join(render_groups(pending, targets)) if any(pending.values()) else '当前源码没有新增条目。')
