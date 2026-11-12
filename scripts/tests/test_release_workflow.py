import base64
import hashlib
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_release import ApiError, Publisher, deploy_site, public_download, publication_lock
from release_packages import validate_bundle
from prepare_release import prepare


class ReleaseWorkflowTests(unittest.TestCase):
    def test_later_four_platform_release_keeps_harmony_original_download_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.1', 'tag': 'v0.3.1', 'source': 'a' * 40, 'revision': 'fix', 'repos': {'github': 'owner/repo'}}, {}, directory)
            self.assertEqual(publisher.public_url('github', 'harmony.hap', '0.3.0'), 'https://github.com/owner/repo/releases/download/v0.3.0/harmony.hap')
            self.assertEqual(publisher.public_url('github', 'mac.dmg'), 'https://github.com/owner/repo/releases/download/v0.3.1/mac.dmg')

    def test_same_version_repack_does_not_prune_retained_harmony_package(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = {'version': '0.3.0', 'source': 'a' * 40, 'revision': 'fix', 'assets': [{'name': 'new.apk'}],
                    'manifest': {'platforms': [{'file': 'new.apk'}, {'file': 'harmony.hap'}]},
                    'previous': {'platforms': [{'file': 'old.apk'}, {'file': 'harmony.hap'}]}}
            publisher = Publisher(plan, {}, directory)
            publisher.report.update(publicManifests={}, downloads=[])
            publisher.release = Mock(return_value={'id': 1})
            publisher.list_assets = Mock(return_value=[{'name': 'old.apk'}, {'name': 'harmony.hap'}])
            publisher.delete_asset = Mock()
            publisher.prune()
            self.assertEqual(publisher.delete_asset.call_count, 2)
            self.assertTrue(all(c.args[2]['name'] == 'old.apk' for c in publisher.delete_asset.call_args_list))

    def test_attachment_redirect_does_not_forward_api_credentials_to_cdn(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.0', 'source': 'a' * 40, 'revision': 'fix', 'repos': {'github': 'owner/repo'}}, {'github': 'PRIVATE-API-TOKEN'}, directory)
            publisher.opener = Mock()
            publisher.opener.open.side_effect = urllib.error.HTTPError('https://api.github.com/asset', 302, 'redirect', {'Location': 'https://cdn.example.test/asset'}, None)
            with patch('publish_release.public_download', return_value={'size': 3, 'sha256': 'a' * 64}) as download:
                publisher.download_attachment('github', {'id': 1}, {'id': 2, 'size': 3, 'digest': 'sha256:' + 'a' * 64})
                self.assertEqual(download.call_args.args[0], 'https://cdn.example.test/asset')
                self.assertNotIn('PRIVATE-API-TOKEN', str(download.call_args))

    def test_an_unfinished_plan_blocks_a_different_publication_but_can_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            with publication_lock(directory, 'first', directory):
                pass
            with self.assertRaisesRegex(ValueError, 'unfinished'):
                with publication_lock(directory, 'second', directory):
                    self.fail('A concurrent release must not start')
            with publication_lock(directory, 'first', directory):
                pass

    def test_local_download_proof_cannot_activate_another_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.0', 'source': 'a' * 40, 'revision': 'fix'}, {}, directory)
            Path(directory, 'download-verification.json').write_text(json.dumps({'planDigest': 'wrong', 'results': []}))
            publisher.api = Mock()
            with self.assertRaisesRegex(ValueError, 'another plan'):
                publisher.finish_release()
            publisher.api.assert_not_called()

    def test_preparation_preserves_sources_and_generates_all_eight_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, version = 'a' * 40, '0.3.1'
            ids = {'macOS': 'mac', 'iOS': 'ios', 'Android': 'android', 'Windows': 'windows'}
            packages, entries = [], []
            for platform, id in ids.items():
                name = f'BiliMusic_{version}_{platform}.bin'
                data = platform.encode()
                (root / name).write_bytes(data)
                packages.append({'platform': platform, 'file': name, 'source': source, 'version': version, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
                entries.append({'id': id, 'channels': [{'id': 'github'}, {'id': 'gitee'}]})
                (root / f'THIRD_PARTY_LICENSES-{platform}.json').write_text(json.dumps({'sourceCommit': source, 'version': version}))
            (root / 'build-info.json').write_text(json.dumps({'version': version, 'source': source, 'platforms': packages, 'validation': {}}))
            for name in ['THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt', 'notes.md']:
                (root / name).write_text('# BiliMusic 0.3.1\n')
            template = {'version': version, 'platforms': entries, 'history': [{'version': version, 'changes': ['fixed']} ]}
            previous = {'version': '0.3.0'}
            output = prepare(root, template, root / 'notes.md', root / 'publish', 'fix-1', previous)
            plan = validate_bundle(output, Mock())
            self.assertEqual(plan['source'], source)
            self.assertEqual(plan['previous'], previous)
            urls = [c['url'] for p in plan['manifest']['platforms'] for c in p['channels']]
            self.assertEqual(len(urls), 8)
            self.assertTrue(all('/v0.3.1/BiliMusic_0.3.1_fix-1_' in u for u in urls))
            self.assertNotIn('file', template['platforms'][0])
            # A later four-platform update must retain the separately versioned
            # Harmony preview, and verify it without rebuilding or relabeling it.
            harmony = {'id': 'ohos', 'version': '0.3.0', 'signature': 'unsigned', 'releaseStatus': 'experimental',
                       'file': 'harmony-unsigned.hap', 'size': 7, 'sha256': 'c' * 64,
                       'channels': [{'id': 'github', 'url': 'https://github.com/harmony'}, {'id': 'gitee', 'url': 'https://gitee.com/harmony'}]}
            retained = json.loads((output / 'candidate-releases.json').read_text())
            retained['platforms'].append(harmony)
            (output / 'candidate-releases.json').write_text(json.dumps(retained))
            (output / 'previous-releases.json').write_text(json.dumps({'version': '0.3.0', 'platforms': [harmony]}))
            self.assertEqual(validate_bundle(output, Mock())['manifest']['platforms'][-1], harmony)
            retained['platforms'][-1] = dict(harmony, sha256='d' * 64)
            (output / 'candidate-releases.json').write_text(json.dumps(retained))
            with self.assertRaisesRegex(ValueError, 'preserve the existing Harmony'):
                validate_bundle(output, Mock())

    def test_new_release_is_a_prerelease_until_packages_are_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            source = 'a' * 40
            publisher = Publisher({'version': '0.3.1', 'source': source, 'revision': 'first', 'tag': 'v0.3.1'}, {}, directory)
            calls = []
            def api(channel, path, method='GET', payload=None):
                calls.append((path, method, payload))
                if path.startswith('/releases/tags/'):
                    raise ApiError(channel, method, path, 404)
                if path == '/releases':
                    return {'id': 1, 'tag_name': 'v0.3.1', 'prerelease': True}
                return {'sha': source}
            publisher.api = api
            release = publisher.release('github')
            self.assertTrue(release['prerelease'])
            self.assertTrue(next(c[2] for c in calls if c[1] == 'POST')['prerelease'])

    def test_new_release_does_not_retarget_an_existing_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.1', 'source': 'a' * 40, 'revision': 'first', 'tag': 'v0.3.1'}, {}, directory)
            def api(channel, path, method='GET', payload=None):
                if path.startswith('/releases/tags/'):
                    raise ApiError(channel, method, path, 404)
                return {'sha': 'b' * 40}
            publisher.api = Mock(side_effect=api)
            with self.assertRaisesRegex(ValueError, 'different source'):
                publisher.release('github')
            self.assertTrue(all(c.kwargs.get('method', c.args[2] if len(c.args) > 2 else 'GET') != 'POST' for c in publisher.api.call_args_list))
    def test_corrupt_package_is_rejected_before_native_tools_or_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            platforms = []
            entries = []
            ids = {'macOS': 'mac', 'iOS': 'ios', 'Android': 'android', 'Windows': 'windows'}
            for platform, id in ids.items():
                name = platform + '.bin'
                (root / name).write_bytes(b'changed')
                sha = hashlib.sha256(b'original').hexdigest()
                platforms.append({'platform': platform, 'file': name, 'source': 'a' * 40, 'version': '0.3.0', 'bytes': 8, 'sha256': sha})
                entries.append({'id': id})
            (root / 'build-info.json').write_text(json.dumps({'source': 'a' * 40, 'version': '0.3.0', 'platforms': platforms, 'validation': {}}))
            (root / 'candidate-releases.json').write_text(json.dumps({'version': '0.3.0', 'platforms': entries}))
            (root / 'previous-releases.json').write_text('{}')
            verifier = Mock()
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                validate_bundle(root, verifier)
            verifier.assert_not_called()

    def test_resume_skips_an_already_verified_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'assets').mkdir()
            (root / 'assets/app.apk').write_bytes(b'package')
            asset = {'name': 'app.apk', 'size': 7, 'sha256': hashlib.sha256(b'package').hexdigest(), 'binary': True}
            publisher = Publisher({'version': '0.3.0', 'source': 'a' * 40, 'revision': 'fix'}, {'github': 'DO-NOT-LOG'}, root)
            publisher.list_assets = Mock(return_value=[{'id': 1, 'name': 'app.apk', 'size': 7, 'state': 'uploaded', 'digest': 'sha256:' + asset['sha256']}])
            publisher.api = Mock()
            publisher.stage_asset('github', {'id': 1}, asset)
            publisher.api.assert_not_called()
            publisher.record('staged', {'count': 1})
            self.assertNotIn('DO-NOT-LOG', (root / 'report.json').read_text())

    def test_existing_binary_is_never_deleted_during_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'assets').mkdir()
            (root / 'assets/app.apk').write_bytes(b'new')
            asset = {'name': 'app.apk', 'size': 3, 'sha256': hashlib.sha256(b'new').hexdigest(), 'binary': True}
            publisher = Publisher({'version': '0.3.0', 'source': 'a' * 40, 'revision': 'fix'}, {}, root)
            publisher.list_assets = Mock(return_value=[{'id': 1, 'name': 'app.apk', 'size': 9}])
            publisher.delete_asset = Mock()
            with patch('publish_release.time.sleep'), self.assertRaisesRegex(ValueError, 'revision-specific'):
                publisher.stage_asset('github', {'id': 1}, asset)
            publisher.delete_asset.assert_not_called()

    def test_activation_and_pruning_require_completed_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.0', 'source': 'a' * 40, 'revision': 'fix'}, {}, directory)
            with self.assertRaisesRegex(ValueError, 'eight downloads'):
                publisher.activate()
            with self.assertRaisesRegex(ValueError, 'all update sources'):
                publisher.prune()

    def test_concurrent_mirror_update_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = {'version': '0.3.0', 'source': 'a' * 40, 'revision': 'fix', 'manifest': {'version': '0.3.0'}, 'previous': {'version': '0.2.8'}}
            publisher = Publisher(plan, {}, directory)
            publisher.api = Mock(return_value={'sha': 'new', 'content': base64.b64encode(b'{"version":"0.3.1"}').decode()})
            with self.assertRaisesRegex(ValueError, 'concurrently'):
                publisher.mirror('github')
            self.assertEqual(publisher.api.call_count, 1)

    def test_failed_site_health_restores_previous_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / 'backup'
            work.mkdir()
            before, candidate = {'version': '0.2.8'}, {'version': '0.3.0'}
            (root / 'releases.json').write_text(json.dumps(before))
            run = Mock()
            def get(path):
                return {'total': 31} if path.endswith('download-stats') else {'version': 'broken'}
            with patch('publish_release.time.sleep'), self.assertRaisesRegex(RuntimeError, 'restored'):
                deploy_site(root, work, candidate, before, run, get)
            self.assertEqual(json.loads((root / 'releases.json').read_text()), before)
            self.assertEqual(run.call_count, 2)

    def test_deployment_resumes_without_restart_or_counter_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / 'backup'
            work.mkdir()
            before, candidate = {'version': '0.2.8'}, {'version': '0.3.0'}
            (root / 'releases.json').write_text(json.dumps(candidate))
            (work / 'previous-live-releases.json').write_text(json.dumps(before))
            run = Mock()
            get = lambda path: {'total': 31} if path.endswith('download-stats') else {'status': 'ok'} if path.endswith('health') else candidate
            result = deploy_site(root, work, candidate, before, run, get)
            self.assertTrue(result['resumed'])
            run.assert_not_called()

    def test_partial_download_never_becomes_a_backup(self):
        class Response:
            url = 'https://example.test/app.apk'
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): raise OSError('interrupted')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'old.apk'
            with patch('publish_release.urllib.request.urlopen', return_value=Response()), patch('publish_release.time.sleep'), self.assertRaises(RuntimeError):
                public_download(Response.url, destination=path)
            self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
