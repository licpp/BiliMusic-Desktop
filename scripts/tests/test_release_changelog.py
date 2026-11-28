import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prepare_release import prepare
from publish_release import release_description
from release_changelog import (MAX_NOTE_GROUPS, app_note_groups, bound_notes, collect_changes,
                               generate_changelog, parse_fragment, validate_note_history)
from release_packages import validate_bundle


def note_change(text, platforms, kind='fixed', **metadata):
    return dict(summary=text, platforms=platforms, kind=kind, **metadata)


def note_group(version, builds, change_id):
    return dict(version=version, builds=builds, changes=[dict(id=change_id, text='修复播放控制。')])


class ReleaseChangelogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.fragment_dir = self.repo / 'docs/changes'
        self.fragment_dir.mkdir(parents=True)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'release@example.test')
        self.git('config', 'core.hooksPath', str(self.repo / '.missing-hooks'))
        self.base = self.commit('baseline')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], text=True).strip()

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '--allow-empty', '-qm', message)
        return self.git('rev-parse', 'HEAD')

    def fragment(self, name, value):
        (self.fragment_dir / (name + '.json')).write_text(json.dumps(value))

    def test_uses_each_actual_package_source_and_only_applicable_fragments(self):
        self.fragment('shared-controls', note_change('修复暂停后继续播放。', ['all']))
        phone_source = self.commit('shared controls')
        self.fragment('car-short-screen', note_change('改善车机矮屏布局。', ['android-large', 'android-large-armv7']))
        self.fragment('maintenance', note_change('扩充测试。', ['all'], kind='internal', pr=25))
        car_source = self.commit('car-only layout and tests')
        self.fragment('too-late', note_change('未来新增。', ['all']))
        self.commit('after the built source')
        previous = dict(version='0.4.6', platforms=[
            dict(id='android', sourceCommit=self.base, build=3),
            dict(id='android-large', sourceCommit=phone_source, build=3),
            dict(id='android-large-armv7', sourceCommit=self.base, build=3),
        ])
        targets = {'android': (4, phone_source), 'android-large': (4, car_source), 'android-large-armv7': (4, car_source)}
        changes = collect_changes(targets, previous, self.repo)
        self.assertEqual([note['id'] for note in changes['android']], ['shared-controls'])
        self.assertEqual([note['id'] for note in changes['android-large']], ['car-short-screen', 'maintenance'])
        self.assertEqual([note['id'] for note in changes['android-large-armv7']], ['car-short-screen', 'maintenance', 'shared-controls'])
        groups = app_note_groups('0.4.6', targets, changes, previous)
        self.assertEqual(len(groups), 3)
        self.assertEqual({note['id'] for group in groups for note in group['changes']}, {'shared-controls', 'car-short-screen'})
        validate_note_history(groups, [], {p: 4 for p in targets}, '0.4.6')

    def test_generates_all_channel_text_with_same_build_replace_and_manual_history(self):
        self.fragment('display-lyrics', note_change('改善歌词显示。', ['all'], detail='纠正首行位置。', pr=26))
        self.fragment('ci', note_change('扩充构建校验。', ['all'], kind='internal'))
        source = self.commit('changelog')
        previous = dict(version='0.4.6', platforms=[dict(id='android', sourceCommit=self.base, build=4)],
                        history=[dict(version='0.4.6', changes=['旧版说明。'])],
                        updateNotes=[note_group('0.4.6', {'android': 4}, 'prior')])
        candidate = copy.deepcopy(previous)
        notes = generate_changelog(candidate, previous, '0.4.6', 'android-republish', {'android': (4, source)}, repo=self.repo)
        self.assertIn('https://github.com/licpp/BiliMusic-Desktop/pull/26', notes)
        self.assertIn('纠正首行位置。', notes)
        self.assertIn('扩充构建校验。', notes)
        self.assertEqual(candidate['history'][0]['changes'], ['改善歌词显示。', '旧版说明。'])
        self.assertEqual(candidate['updateNotes'], previous['updateNotes'])

        for platform, data in [('android', previous['platforms'][0]), ('ohos', {'id': 'ohos'})]:
            previous['platforms'] = [data]
            candidate = dict(history=[dict(version='0.4.5', changes=['过期的本地模板。'])])
            generate_changelog(candidate, previous, '0.4.7', 'stable', {platform: (1, source)},
                               repo=self.repo, fallback_base=self.base)
            self.assertEqual(candidate['history'][0]['version'], '0.4.7')
            self.assertEqual(candidate['history'][0]['changes'], ['改善歌词显示。'])
            self.assertEqual(candidate['history'][1:], previous['history'])
            self.assertEqual(candidate['updateNotes'][0]['builds'], {platform: 1})
            self.assertEqual(candidate['updateNotes'][1:], previous['updateNotes'])

    def test_prepares_universal_car_patch_with_website_notes_and_rejects_scope_changes(self):
        self.fragment('car-display', note_change('修复车机设置排版。', ['android-large', 'android-large-armv7']))
        source = self.commit('car settings')
        work = self.repo / 'build-output'
        work.mkdir()
        version = '0.4.6'
        name = f'BiliMusic_{version}_Android_LargeScreen_universal.apk'
        data = b'test universal car package'
        (work / name).write_bytes(data)
        package = dict(platform='Android Large Screen', architecture='universal', file=name, source=source,
                       version=version, build=4, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        for filename in ['THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt']:
            (work / filename).write_text('fixture')
        (work / 'THIRD_PARTY_LICENSES-Android-Large-Screen.json').write_text(json.dumps(dict(version=version, sourceCommit=source)))
        (work / 'build-info.json').write_text(json.dumps(dict(version=version, source=source, validation={}, platforms=[package])))
        old_group = note_group(version, {'android': 3}, 'phone-build-3')
        previous = dict(version=version, history=[dict(version=version, changes=['旧版。'])], updateNotes=[old_group], platforms=[
            dict(id=platform, build=3, version=version, file=f'{platform}.apk', channels=[{'id': 'gitee'}, {'id': 'github'}],
                 status='available', sha256='c' * 64, sourceCommit=self.base)
            for platform in ('android', 'android-large', 'android-large-armv7')
        ])
        bundle = prepare(work, {}, None, self.repo / 'staged', 'car-build-4', previous,
                         dict(version=version, platforms={}), changelog_repo=self.repo)
        plan = validate_bundle(bundle, Mock())
        self.assertEqual(plan['manifest']['platforms'][0], previous['platforms'][0])
        self.assertEqual(plan['manifest']['history'][0]['changes'], ['修复车机设置排版。', '旧版。'])
        new_group = plan['manifest']['updateNotes'][0]
        self.assertEqual(new_group['builds'], {'android-large': 4, 'android-large-armv7': 4})
        self.assertEqual(plan['manifest']['updateNotes'][1], old_group)
        self.assertTrue(plan['appendChangelog'])
        package_file = bundle / 'candidate-releases.json'
        new_group['builds']['android'] = 4
        package_file.write_text(json.dumps(plan['manifest']))
        with self.assertRaisesRegex(ValueError, 'unpublished build or platform'):
            validate_bundle(bundle, Mock())

    def test_release_note_validation_only_evicts_the_bounded_oldest_suffix(self):
        version = '0.4.6'
        earlier = [note_group(version, {'android': n}, f'older-{n}') for n in range(MAX_NOTE_GROUPS, 0, -1)]
        latest = note_group(version, {'android': MAX_NOTE_GROUPS + 1}, 'latest')
        history = bound_notes([latest, *earlier])
        self.assertEqual(len(history), MAX_NOTE_GROUPS)
        validate_note_history(history, earlier, latest['builds'], version)
        with self.assertRaisesRegex(ValueError, 'must be preserved'):
            validate_note_history([latest, *history[2:]], earlier, latest['builds'], version)
        with self.assertRaisesRegex(ValueError, 'platform'):
            validate_note_history([latest, *earlier[:-1]], earlier, {}, version)

    def test_rejects_malformed_fragments_and_preserves_release_body_when_resumed(self):
        for fragment in (
            note_change('第一行\n第二行', ['all']), note_change('无效平台', ['typo']),
            note_change('无效范围', ['all', 'android']), note_change('无效类别', ['all'], kind='typo'),
        ):
            with self.assertRaises(ValueError):
                parse_fragment('sample.json', json.dumps(fragment))
        plan = dict(version='0.4.6', revision='car-build-4', notes='# BiliMusic 0.4.6\n\n## 车机补丁\n- 修复。', appendChangelog=True)
        earlier = '# BiliMusic 0.4.6\n\n## 首次发布\n- 新增功能。'
        merged = release_description(plan, earlier, '\n许可说明。\n')
        self.assertIn('## 首次发布', merged)
        self.assertIn('## 车机补丁', merged)
        self.assertIn('许可说明。', merged)
        self.assertEqual(merged.count('# BiliMusic 0.4.6'), 1)
        self.assertEqual(release_description(plan, merged, '\n许可说明。\n'), merged)
