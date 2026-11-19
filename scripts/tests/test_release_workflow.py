import base64
import hashlib
import io
import json
import sys
import tempfile
import threading
import tarfile
import unittest
import zipfile
import urllib.error
from pathlib import Path
from unittest.mock import Mock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from publish_release import ApiError, Publisher, deploy_site, public_download, publication_lock, release_content_type, fingerprint, cached_downloads_valid
from release_packages import validate_bundle, verify_android_bridge
from prepare_release import prepare


class ReleaseWorkflowTests(unittest.TestCase):
    def test_android_release_keeps_tauri_plugin_manager_for_jni(self):
        player_bridge = b'\0'.join(
            b'Lapp/bilimusic/player/' + name + b';'
            for name in (b'PlayerPlugin', b'PlayArgs', b'ControlArgs', b'SecretArgs')
        )
        with self.assertRaisesRegex(ValueError, 'plugin manager getter removed'):
            verify_android_bridge(player_bridge)
        verify_android_bridge(player_bridge + b'\0getPluginManager\0')

    def test_android_patch_retains_other_installers_and_ota_feed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            version, source = '0.4.0', 'a' * 40
            name = f'BiliMusic_{version}_Android_arm64.apk'
            data = b'android build 2'
            (root / name).write_bytes(data)
            (root / 'build-info.json').write_text(json.dumps({
                'version': version, 'source': source, 'validation': {},
                'platforms': [{'platform': 'Android', 'architecture': 'arm64', 'file': name,
                               'source': source, 'version': version, 'build': 2, 'bytes': len(data),
                               'sha256': hashlib.sha256(data).hexdigest()}],
            }))
            for filename in ['THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt', 'notes.md']:
                (root / filename).write_text('# BiliMusic 0.4.0')
            (root / 'THIRD_PARTY_LICENSES-Android.json').write_text(json.dumps({'version': version, 'sourceCommit': source}))
            channels = [{'id': 'github'}, {'id': 'gitee'}]
            previous = {'version': version, 'history': [{'version': version}], 'platforms': [
                {'id': 'android', 'build': 1, 'file': 'phone.apk', 'channels': channels, 'status': 'available', 'sha256': '1' * 64},
                {'id': 'android-large', 'build': 1, 'file': 'large.apk', 'channels': channels, 'status': 'available', 'sha256': '2' * 64},
                {'id': 'mac', 'build': 1, 'file': 'mac.dmg', 'channels': channels, 'status': 'available', 'sha256': '3' * 64},
            ]}
            ota = {'version': version, 'platforms': {'darwin-aarch64': {'build': 1, 'url': 'existing'}}}
            output = prepare(root, {}, root / 'notes.md', root / 'staged', 'android-build-2', previous, ota)
            verifier = Mock()
            plan = validate_bundle(output, verifier)
            self.assertEqual(plan['manifest']['platforms'][0]['build'], 2)
            self.assertEqual(plan['manifest']['platforms'][1:], previous['platforms'][1:])
            self.assertEqual(plan['updater'], ota)
            self.assertEqual(verifier.call_args.args[-1], 2)
            self.assertIn('  large.apk', (output / 'SHA256SUMS.txt').read_text())
            self.assertIn('build-info-android-build-2.json', {asset['name'] for asset in plan['assets']})
            package = root / 'staged' / 'candidate-releases.json'
            candidate = json.loads(package.read_text())
            candidate['platforms'][1]['build'] = 2
            package.write_text(json.dumps(candidate))
            with self.assertRaisesRegex(ValueError, 'Unbuilt platform'):
                validate_bundle(output, verifier)

    def test_large_upload_timeout_scales_with_payload_size(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Publisher({'version':'0.3.5','source':'a'*40,'revision':'stable','repos':{'github':'owner/repo'}},{'github':'TOKEN'},folder)
            p.opener=Mock();response=MagicMock();response.__enter__.return_value.read.return_value=b'{}';p.opener.open.return_value=response
            p.api('github','https://uploads.github.com/repos/owner/repo/releases/1/assets?name=large.AppImage','POST',binary=b'x'*(24*1024*1024))
            self.assertGreater(p.opener.open.call_args.kwargs['timeout'],180)

    def test_documentation_archive_is_reproducible_and_keeps_each_verified_original(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'assets').mkdir();assets=[]
            for name,data in [('THIRD_PARTY_LICENSES-mac.json',b'license'*1000),('app.sig',b'signature'),('updater.json',b'feed')]:
                (root/'assets'/name).write_bytes(data)
                assets.append(dict(name=name,size=len(data),sha256=hashlib.sha256(data).hexdigest(),binary=False))
            p=Publisher(dict(version='0.3.5',source='a'*40,revision='stable',assets=assets),{},root)
            first=p.documentation_bundle();second=p.documentation_bundle()
            self.assertEqual(first,second)
            with tarfile.open(root/'assets'/first['name']) as archive:
                self.assertEqual(set(archive.getnames()),{'THIRD_PARTY_LICENSES-mac.json','app.sig'})
                self.assertEqual(archive.extractfile('app.sig').read(),b'signature')
            (root/'assets/app.sig').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'Documentation input changed'):p.documentation_bundle()

    def test_null_remote_asset_digest_uses_download_hash_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Publisher({'version':'0.3.5','source':'a'*40,'revision':'stable','repos':{'github':'owner/repo','gitee':'owner/repo'}},{'github':'TOKEN','gitee':'TOKEN'},folder)
            p.opener=Mock();response=MagicMock();response.__enter__.return_value.read.return_value=b'package';p.opener.open.return_value=response
            for channel in ['github','gitee']:
                result=p.download_attachment(channel,{'id':1},{'id':2,'size':7,'digest':None})
                self.assertEqual(result['sha256'],hashlib.sha256(b'package').hexdigest())
                self.assertEqual(result['size'],7)

    def test_only_empty_prerelease_upload_placeholders_are_removed(self):
        for prerelease,state,size,should_delete in [(True,'starter',0,True),(False,'starter',0,False),(True,'uploaded',1,False)]:
            with tempfile.TemporaryDirectory() as folder:
                root=Path(folder);(root/'assets').mkdir();(root/'assets/test.apk').write_bytes(b'apk')
                asset={'name':'test.apk','size':3,'sha256':hashlib.sha256(b'apk').hexdigest(),'binary':True}
                p=Publisher({'version':'0.3.5','source':'a'*40,'revision':'stable'},{},root)
                existing={'name':'test.apk','id':1,'state':state,'size':size}
                p.list_assets=Mock(side_effect=[[existing],[dict(existing,id=2,state='uploaded',size=3)]])
                p.delete_asset=Mock();p.api=Mock();p.asset_matches=Mock(return_value=True)
                p.stage_asset('github',{'id':1,'prerelease':prerelease},asset)
                self.assertEqual(p.delete_asset.called,should_delete)

    def test_ci_artifact_redirect_does_not_forward_api_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.3', 'source': 'a' * 40, 'revision': 'stable', 'repos': {'github': 'owner/repo'}}, {'github': 'PRIVATE-TOKEN'}, directory)
            publisher.opener = Mock()
            publisher.opener.open.side_effect = urllib.error.HTTPError('https://api.github.com/artifact', 302, 'redirect', {'Location': 'https://cdn.example.test/archive'}, None)
            response = MagicMock()
            response.read.return_value = b'ZIP-ARCHIVE'
            with patch('publish_release.urllib.request.urlopen', return_value=response) as download:
                self.assertEqual(publisher.ci_archive(2), b'ZIP-ARCHIVE')
                self.assertEqual(download.call_args.args, ('https://cdn.example.test/archive',))
                self.assertNotIn('PRIVATE-TOKEN', str(download.call_args))

    def test_dispatched_build_checks_actual_artifact_source_and_package(self):
        with tempfile.TemporaryDirectory() as directory:
            source, package = 'a' * 40, b'VERIFIED-INSTALLER'
            plan = {'version': '0.3.3', 'source': source, 'revision': 'stable',
                    'ciRuns': {'Windows': {'run': 1, 'artifact': 'windows', 'notice': 'notice.json', 'package': 'setup.exe'}},
                    'assets': [{'binary': True, 'size': len(package), 'sha256': hashlib.sha256(package).hexdigest()}]}
            publisher = Publisher(plan, {}, directory)
            publisher.api = Mock(side_effect=lambda channel, path: {'conclusion': 'success', 'head_sha': 'b' * 40, 'event': 'workflow_dispatch'} if path == '/actions/runs/1' else {'artifacts': [{'id': 2, 'name': 'windows', 'expired': False}]})
            def artifact(commit=source, binary=package):
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w') as archive:
                    archive.writestr('notice.json', json.dumps({'sourceCommit': commit, 'version': '0.3.3'}))
                    archive.writestr('setup.exe', binary)
                return output.getvalue()
            publisher.ci_archive = Mock(return_value=artifact())
            publisher.check_ci()
            publisher.ci_archive.return_value = artifact(commit='c' * 40)
            with self.assertRaisesRegex(ValueError, 'source notice mismatch'):
                publisher.check_ci()
            publisher.ci_archive.return_value = artifact(binary=b'WRONG-INSTALLER')
            with self.assertRaisesRegex(ValueError, 'package mismatch'):
                publisher.check_ci()
            publisher.api = Mock(return_value={'conclusion': 'failure', 'head_sha': source})
            with self.assertRaisesRegex(ValueError, 'Build failed'):
                publisher.check_ci()

    def test_apk_upload_has_android_content_type_instead_of_zip_or_unspecified_binary(self):
        self.assertEqual(release_content_type('BiliMusic.APK'), 'application/vnd.android.package-archive')
        self.assertEqual(release_content_type('BiliMusic.exe'), 'application/octet-stream')
        self.assertEqual(release_content_type('BiliMusic.zip'), 'application/zip')
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.1', 'source': 'a' * 40, 'revision': 'fix', 'repos': {'gitee': 'owner/repo'}}, {'gitee': 'TEST-TOKEN'}, directory)
            publisher.opener = Mock()
            publisher.opener.open.return_value = MagicMock()
            publisher.opener.open.return_value.__enter__.return_value.read.return_value = b'{}'
            publisher.api('gitee', '/releases/1/attach_files', 'POST', multipart=('BiliMusic.apk', b'APK-BYTES'))
            request = publisher.opener.open.call_args.args[0]
            self.assertIn(b'filename="BiliMusic.apk"', request.data)
            self.assertIn(b'Content-Type: application/vnd.android.package-archive\r\n', request.data)
            self.assertNotIn(b'Content-Type: application/zip', request.data)

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
                (root / ('THIRD_PARTY_LICENSES-' + platform.replace(' ', '-') + '.json')).write_text(json.dumps({'sourceCommit': source, 'version': version}))
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

    def test_five_platform_release_replaces_harmony_and_keeps_exact_per_platform_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, prior = 'a' * 40, 'b' * 40
            ids = {'macOS': 'mac', 'iOS': 'ios', 'Android': 'android', 'Windows': 'windows', 'HarmonyOS NEXT': 'ohos'}
            packages, entries = [], []
            for platform, id in ids.items():
                name = 'BiliMusic_0.3.1_' + id + '.bin'
                data = platform.encode()
                (root / name).write_bytes(data)
                built = source if platform == 'Android' else prior
                packages.append({'platform': platform, 'file': name, 'source': built, 'version': '0.3.1', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
                entries.append({'id': id, 'channels': [{'id': 'github'}, {'id': 'gitee'}]})
                (root / ('THIRD_PARTY_LICENSES-' + platform.replace(' ', '-') + '.json')).write_text(json.dumps({'sourceCommit': built, 'version': '0.3.1'}))
            (root / 'build-info.json').write_text(json.dumps({'version': '0.3.1', 'source': source, 'platforms': packages, 'validation': {}, 'ciRuns': {'Android': 1, 'Windows': 2}}))
            for name in ['THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt', 'notes.md']:
                (root / name).write_text('# BiliMusic 0.3.1\n')
            output = prepare(root, {'version': '0.3.1', 'platforms': entries, 'history': [{'version': '0.3.1'}]}, root / 'notes.md', root / 'publish', 'first', {'version': '0.3.0', 'platforms': [{'id': 'ohos', 'version': '0.3.0'}]})
            with patch('release_packages.command', return_value='native/android-player/Player.kt\nscripts/publish_release.py'):
                plan = validate_bundle(output, Mock())
            self.assertEqual(len([a for a in plan['assets'] if a['binary']]), 5)
            self.assertEqual(len([c for p in plan['manifest']['platforms'] for c in p['channels']]), 10)
            self.assertEqual(plan['platformSources']['Android'], source)
            self.assertEqual(plan['platformSources']['Windows'], prior)
            with patch('release_packages.command', return_value='src/features/lyrics/LyricsView.tsx'):
                with self.assertRaisesRegex(ValueError, 'Mixed build sources'):
                    validate_bundle(output, Mock())
            publisher = Publisher(plan | {'repos': {'github': 'owner/repo'}}, {}, root / 'worker')
            publisher.api = Mock(side_effect=[{'conclusion': 'success', 'head_sha': source}, {'conclusion': 'success', 'head_sha': prior}])
            publisher.check_ci()

    def test_multi_architecture_bundle_keeps_all_twelve_installers_and_notice_identities(self):
        from release_packages import package_id, license_name
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); version, source = '0.3.5', 'a' * 40
            specs = [('macOS','arm64','.dmg'),('macOS','x64','.dmg'),('Windows','x64','.exe'),('Windows','arm64','.exe'),('Android','arm64','.apk'),('Android Large Screen','arm64','.apk'),('Android Large Screen','armv7','.apk'),('iOS','arm64','.ipa'),('HarmonyOS NEXT','arm64','.hap')] + [('Linux',a,e) for a in ['x64','arm64'] for e in ['.AppImage','.deb']]
            packages = []
            for platform, arch, extension in specs:
                name = f'BiliMusic_{version}_{platform.replace(" ", "_")}_{arch}{extension}'; data = name.encode()
                (root / name).write_bytes(data)
                packages.append(dict(platform=platform,architecture=arch,file=name,source=source,version=version,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
            entries = [dict(id=package_id(p),channels=[{'id':'github'},{'id':'gitee'}]) for p in packages]
            for package in packages:
                (root/license_name(package,packages)).write_text(json.dumps(dict(sourceCommit=source,version=version)))
            (root/'build-info.json').write_text(json.dumps(dict(version=version,source=source,platforms=packages,validation={})))
            for name in ['THIRD_PARTY_NOTICES.md','qrc-codec-MIT.txt','notes.md']:(root/name).write_text('# BiliMusic 0.3.5')
            output=prepare(root,dict(version=version,platforms=entries,history=[{'version':version}]),root/'notes.md',root/'publish','stable',{'version':'0.3.4'})
            plan=validate_bundle(output,Mock())
            self.assertEqual(len([a for a in plan['assets'] if a['binary']]),13)
            self.assertEqual(len({p['id'] for p in plan['manifest']['platforms']}),13)
            self.assertEqual(len({p['file'] for p in plan['manifest']['platforms']}),13)
            self.assertIn('mac-intel',plan['platformSources']);self.assertIn('linux-arm64-deb',plan['platformSources'])

    def test_six_platform_bundle_includes_a_separate_large_screen_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, version = 'a' * 40, '0.3.4'
            ids = {'macOS': 'mac', 'iOS': 'ios', 'Android': 'android', 'Windows': 'windows', 'HarmonyOS NEXT': 'ohos', 'Android Large Screen': 'android-large'}
            packages, entries = [], []
            for platform, id in ids.items():
                name = f'BiliMusic_{version}_{id}.bin'
                data = platform.encode()
                (root / name).write_bytes(data)
                packages.append({'platform': platform, 'file': name, 'source': source, 'version': version, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
                entries.append({'id': id, 'channels': [{'id': 'github'}, {'id': 'gitee'}]})
                (root / ('THIRD_PARTY_LICENSES-' + platform.replace(' ', '-') + '.json')).write_text(json.dumps({'sourceCommit': source, 'version': version}))
            (root / 'build-info.json').write_text(json.dumps({'version': version, 'source': source, 'platforms': packages, 'validation': {}}))
            for name in ['THIRD_PARTY_NOTICES.md', 'qrc-codec-MIT.txt', 'notes.md']:
                (root / name).write_text('# BiliMusic 0.3.4')
            output = prepare(root, {'version': version, 'platforms': entries, 'history': [{'version': version}]}, root / 'notes.md', root / 'publish', 'stable', {'version': '0.3.3'})
            verifier = Mock()
            plan = validate_bundle(output, verifier)
            self.assertEqual(len([a for a in plan['assets'] if a['binary']]), 6)
            self.assertEqual(sum(len(p['channels']) for p in plan['manifest']['platforms']), 12)
            self.assertIn('Android Large Screen', plan['platformSources'])
            self.assertEqual(verifier.call_count, 6)
            self.assertEqual(len({p['file'] for p in plan['manifest']['platforms']}), 6)
            self.assertTrue((output / 'THIRD_PARTY_LICENSES-Android-Large-Screen.json').exists())

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

    def test_pending_icp_filing_skips_only_public_site_check_and_records_the_limit(self):
        for pending in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                manifest = {'platforms': [{'channels': [{}, {}]} for _ in range(4)]}
                plan = {'version': '0.3.1', 'source': 'a' * 40, 'revision': 'stable', 'siteHost': 'bilimusic.cn', 'siteRoot': '/opt/test', 'manifest': manifest, 'previous': {}, 'repos': {'github': 'owner/repo', 'gitee': 'owner/repo'}}
                publisher = Publisher(plan, {}, directory)
                publisher.site_filing_pending = pending
                publisher.report['downloads'] = [{} for _ in range(8)]
                publisher.mirror = Mock()
                response = MagicMock()
                response.__enter__.return_value.read.return_value = json.dumps(manifest).encode()
                with patch('publish_release.deploy_site', return_value={'version': '0.3.1'}), patch('publish_release.urllib.request.urlopen', return_value=response) as get:
                    publisher.activate()
                self.assertEqual(get.call_count, 2 if pending else 3)
                self.assertEqual('websitePublic' in publisher.report, pending)
                if pending:
                    self.assertEqual(publisher.report['websitePublic']['status'], 'pending-icp-filing')
                    self.assertTrue(all('bilimusic.cn' not in call.args[0] for call in get.call_args_list))
                self.assertEqual(publisher.mirror.call_count, 2)

    def test_workstation_manifest_proof_is_bound_to_plan_urls_and_full_contents(self):
        for pending in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                plan = {'version': '0.3.4', 'source': 'a' * 40, 'revision': 'stable', 'siteHost': 'bilimusic.cn', 'repos': {'github': 'owner/repo', 'gitee': 'owner/repo'}, 'manifest': {'version': '0.3.4', 'platforms': []}}
                publisher = Publisher(plan, {}, directory)
                publisher.site_filing_pending = pending
                urls = ['https://gitee.com/owner/repo/raw/main/website/releases.json', 'https://raw.githubusercontent.com/owner/repo/main/website/releases.json']
                if not pending:
                    urls.insert(0, 'https://bilimusic.cn/api/v1/releases')
                proof = {'planDigest': fingerprint(plan), 'results': [{'url': url, 'manifest': plan['manifest']} for url in urls]}
                path = Path(directory) / 'public-manifest-verification.json'
                for invalid in [dict(proof, planDigest='wrong'), dict(proof, results=proof['results'][:-1]), dict(proof, results=[proof['results'][0]] * len(urls)), dict(proof, results=[{'url': url, 'manifest': {'version': '0.3.4', 'platforms': ['wrong']}} for url in urls])]:
                    path.write_text(json.dumps(invalid))
                    with self.assertRaises(ValueError):
                        publisher.verify_manifest_proof()
                    self.assertNotIn('publicManifests', publisher.report)
                path.write_text(json.dumps(proof))
                publisher.verify_manifest_proof()
                self.assertEqual(publisher.report['publicManifests']['verifiedBy'], 'publishing-workstation')
                self.assertEqual(publisher.report['publicManifests']['urls'], urls)

    def test_activation_can_defer_public_checks_until_workstation_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = {'version': '0.3.4', 'platforms': [{'channels': [{}, {}]} for _ in range(4)]}
            plan = {'version': '0.3.4', 'source': 'a' * 40, 'revision': 'stable', 'siteHost': 'bilimusic.cn', 'siteRoot': '/opt/test', 'manifest': manifest, 'previous': {}, 'repos': {'github': 'owner/repo', 'gitee': 'owner/repo'}}
            publisher = Publisher(plan, {}, directory)
            publisher.report['downloads'] = [{} for _ in range(8)]
            publisher.mirror = Mock()
            with patch('publish_release.deploy_site', return_value={'version': '0.3.4'}), patch('publish_release.urllib.request.urlopen') as request:
                publisher.activate(verify_public=False)
            request.assert_not_called()
            self.assertNotIn('publicManifests', publisher.report)
            with self.assertRaisesRegex(ValueError, 'before all update sources'):
                publisher.prune()

    def test_gitee_missing_release_can_return_json_null_with_http_200(self):
        with tempfile.TemporaryDirectory() as directory:
            source = 'a' * 40
            publisher = Publisher({'version': '0.3.1', 'source': source, 'revision': 'first', 'tag': 'v0.3.1'}, {}, directory)
            def api(channel, path, method='GET', payload=None):
                if path.startswith('/releases/tags/') or path == '/commits/v0.3.1':
                    return None
                if path == '/releases':
                    return {'id': 1, 'tag_name': 'v0.3.1', 'prerelease': False}
                return {'sha': source}
            publisher.api = Mock(side_effect=api)
            self.assertEqual(publisher.release('gitee')['id'], 1)

    def test_github_missing_tag_can_return_422_before_creating_a_release(self):
        with tempfile.TemporaryDirectory() as directory:
            source = 'a' * 40
            publisher = Publisher({'version': '0.3.1', 'source': source, 'revision': 'first', 'tag': 'v0.3.1'}, {}, directory)
            def api(channel, path, method='GET', payload=None):
                if path.startswith('/releases/tags/'):
                    raise ApiError(channel, method, path, 404)
                if path == '/commits/v0.3.1':
                    raise ApiError(channel, method, path, 422)
                if path == '/releases':
                    return {'id': 1, 'tag_name': 'v0.3.1', 'prerelease': False}
                return {'sha': source}
            publisher.api = Mock(side_effect=api)
            self.assertEqual(publisher.release('github')['id'], 1)

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

    def test_github_server_digest_never_downloads_an_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.4', 'source': 'a' * 40, 'revision': 'stable'}, {}, directory)
            asset = {'name': 'app.apk', 'size': 7, 'sha256': 'b' * 64}
            remote = {'id': 11, 'name': 'app.apk', 'size': 7, 'state': 'uploaded', 'digest': 'sha256:' + 'b' * 64}
            publisher.download_attachment = Mock()
            self.assertTrue(publisher.asset_matches('github', {'id': 1}, remote, asset))
            publisher.download_attachment.assert_not_called()
            self.assertEqual(publisher.report['verifiedAssets']['github:app.apk']['method'], 'server-sha256')
            self.assertFalse(publisher.asset_matches('github', {'id': 1}, dict(remote, digest='sha256:' + 'c' * 64), asset))
            self.assertFalse(publisher.asset_matches('github', {'id': 1}, dict(remote, state='new'), asset))
            publisher.download_attachment.assert_not_called()

    def test_gitee_hash_is_read_once_and_receipts_survive_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = {'version': '0.3.4', 'source': 'a' * 40, 'revision': 'stable'}
            asset = {'name': 'app.apk', 'size': 7, 'sha256': 'b' * 64}
            remote = {'id': 11, 'name': 'app.apk', 'size': 7}
            publisher = Publisher(plan, {}, directory)
            publisher.download_attachment = Mock(return_value={'size': 7, 'sha256': 'b' * 64})
            self.assertTrue(publisher.asset_matches('gitee', {'id': 1}, remote, asset))
            self.assertTrue(publisher.asset_matches('gitee', {'id': 1}, remote, asset))
            publisher.download_attachment.assert_called_once()
            resumed = Publisher(plan, {}, directory)
            resumed.download_attachment = Mock(return_value={'size': 7, 'sha256': 'b' * 64})
            self.assertTrue(resumed.asset_matches('gitee', {'id': 1}, remote, asset))
            resumed.download_attachment.assert_not_called()
            self.assertTrue(resumed.asset_matches('gitee', {'id': 1}, dict(remote, id=12), asset))
            self.assertTrue(resumed.asset_matches('gitee', {'id': 1}, dict(remote, id=12, updated_at='changed'), asset))
            self.assertTrue(resumed.asset_matches('gitee', {'id': 2}, dict(remote, id=12, updated_at='changed'), asset))
            self.assertEqual(resumed.download_attachment.call_count, 3)
            self.assertFalse(resumed.asset_matches('gitee', {'id': 2}, dict(remote, size=9), asset))
            self.assertFalse(resumed.asset_matches('gitee', {'id': 2}, remote, dict(asset, sha256='c' * 64)))

    def test_corrupt_attachment_does_not_create_a_reusable_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.4', 'source': 'a' * 40, 'revision': 'stable'}, {}, directory)
            publisher.download_attachment = Mock(return_value={'size': 7, 'sha256': 'c' * 64})
            self.assertFalse(publisher.asset_matches('gitee', {'id': 1}, {'id': 2, 'name': 'app.apk', 'size': 7}, {'name': 'app.apk', 'size': 7, 'sha256': 'b' * 64}))
            self.assertNotIn('gitee:app.apk', publisher.report.get('verifiedAssets', {}))

    def test_upload_channels_run_concurrently_and_report_writes_are_serialized(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Publisher({'version': '0.3.4', 'source': 'a' * 40, 'revision': 'stable', 'assets': [{'name': 'app.apk', 'binary': True}]}, {}, directory)
            publisher.check_ci = Mock()
            publisher.release = Mock(side_effect=lambda channel: {'id': channel})
            publisher.list_assets = Mock(return_value=[])
            barrier = threading.Barrier(2)
            def upload(channel, release, asset):
                barrier.wait(timeout=2)
                for i in range(15):
                    publisher.record(channel + str(i), {'verified': True})
            publisher.stage_asset = Mock(side_effect=upload)
            publisher.stage()
            recorded = json.loads((Path(directory) / 'report.json').read_text())
            self.assertTrue(all(channel + str(i) in recorded for channel in ('github', 'gitee') for i in range(15)))
            self.assertEqual(recorded['staged']['binaryAssets'], 2)

    def test_fast_public_proof_requires_the_exact_staged_attachment(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = {'version': '0.3.4', 'source': 'a' * 40, 'revision': 'stable', 'tag': 'v0.3.4', 'repos': {'github': 'owner/repo', 'gitee': 'owner/repo'}, 'notes': '# Release', 'assets': [], 'manifest': {'platforms': []}}
            publisher = Publisher(plan, {}, directory)
            results = []
            for i in range(4):
                file = f'{i}.bin'
                entry = {'file': file, 'size': 7, 'sha256': 'b' * 64, 'channels': []}
                for channel in ('github', 'gitee'):
                    url = publisher.public_url(channel, file)
                    entry['channels'].append({'id': channel, 'url': url})
                    receipt = {'channel': channel, 'releaseId': 1, 'assetId': i + 1, 'name': file, 'size': 7, 'sha256': 'b' * 64, 'method': 'downloaded-sha256'}
                    publisher.report.setdefault('verifiedAssets', {})[channel + ':' + file] = receipt
                    results.append({'url': url, 'size': 7, 'sha256': 'b' * 64, 'verification': 'uploaded-hash-and-public-headers', 'uploadProof': receipt.copy()})
                plan['manifest']['platforms'].append(entry)
            publisher.api = Mock()
            publisher.release = Mock(return_value={'id': 1})
            path = Path(directory) / 'download-verification.json'
            wrong = json.loads(json.dumps(results)); wrong[0]['uploadProof']['assetId'] = 999
            path.write_text(json.dumps({'planDigest': fingerprint(plan), 'results': wrong}))
            with self.assertRaisesRegex(ValueError, 'Upload digest proof'):
                publisher.finish_release()
            publisher.api.assert_not_called()
            path.write_text(json.dumps({'planDigest': fingerprint(plan), 'results': results}))
            publisher.finish_release()
            self.assertEqual(len(publisher.report['downloads']), 8)

    def test_changed_attachment_invalidates_cached_header_proof_and_full_audit_requires_bytes(self):
        receipt = {'assetId': 1, 'sha256': 'b' * 64, 'size': 7}
        plan = {'manifest': {'platforms': [{'file': 'app.apk', 'sha256': 'b' * 64, 'size': 7, 'channels': [{'id': 'github', 'url': 'https://example.test/app.apk'}]}]}}
        result = {'url': 'https://example.test/app.apk', 'sha256': 'b' * 64, 'size': 7, 'verification': 'uploaded-hash-and-public-headers', 'uploadProof': receipt}
        proof = {'planDigest': fingerprint(plan), 'results': [result]}
        staged = {'verifiedAssets': {'github:app.apk': receipt}}
        self.assertTrue(cached_downloads_valid(plan, proof, staged))
        self.assertFalse(cached_downloads_valid(plan, proof, staged, full_audit=True))
        self.assertFalse(cached_downloads_valid(plan, proof, {'verifiedAssets': {'github:app.apk': dict(receipt, assetId=2)}}))
        self.assertFalse(cached_downloads_valid(plan, proof, {}))
        full = dict(proof, results=[dict(result, verification='full-download')])
        self.assertTrue(cached_downloads_valid(plan, full, {}, full_audit=True))
        self.assertFalse(cached_downloads_valid(plan, dict(full, planDigest='wrong'), {}))

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
