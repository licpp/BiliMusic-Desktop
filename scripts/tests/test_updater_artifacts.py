import base64
import io
import tarfile
import plistlib
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from updater_artifacts import updater_assets, prepare_updater, signature_text, KEY
from publish_release import Publisher, ApiError

class UpdaterTests(unittest.TestCase):
    def signature(self):
        # Only framing/key identity is checked here. The app verifies the signature cryptographically.
        public = base64.b64decode(base64.b64decode(KEY.read_text().strip()).decode().splitlines()[1])
        raw = b'ED' + public[2:10] + b'x' * 64
        return base64.b64encode(('untrusted comment: fixture\n' + base64.b64encode(raw).decode() + '\ntrusted comment: fixture\nignored\n').encode()).decode()

    def test_feed_assets_are_checked_and_same_installer_is_not_repacked(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); output = root / 'bundle'; output.mkdir()
            (root / 'original.exe').write_bytes(b'installer')
            (root / 'original.exe.sig').write_text(self.signature())
            (output / 'BiliMusic_0.3.5_test_setup.exe').write_bytes(b'installer')
            build = {'version': '0.3.5', 'platforms': [{'platform': 'Windows', 'file': 'BiliMusic_0.3.5_test_setup.exe'}]}
            manifest = prepare_updater(root, output, build, {'Windows': 'original.exe'})
            self.assertEqual(manifest['platforms']['windows-x86_64']['signature'], self.signature())
            checked, assets = updater_assets(output, '0.3.5')
            self.assertEqual(checked, manifest)
            self.assertEqual({a['name'] for a in assets}, {'updater.json', 'BiliMusic_0.3.5_test_setup.exe', 'BiliMusic_0.3.5_test_setup.exe.sig'})
            (output / 'BiliMusic_0.3.5_test_setup.exe').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'archive changed'): updater_assets(output, '0.3.5')

    def test_both_desktop_architectures_get_their_own_signed_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);out=root/'out';out.mkdir();packages=[];original={}
            for kind,arch in [('macOS','arm64'),('macOS','x64'),('Windows','x64'),('Windows','arm64')]:
                id=('mac' if arch=='arm64' else 'mac-intel') if kind=='macOS' else ('windows' if arch=='x64' else 'windows-arm64')
                name=f'BiliMusic_0.3.5_{arch}_{kind}'+('.dmg' if kind=='macOS' else '.exe')
                target='stable-'+name;original[id]=name;packages.append(dict(platform=kind,architecture=arch,file=target))
                (root/name).write_bytes(arch.encode());(out/target).write_bytes(arch.encode())
                source=root/name
                if kind=='macOS':
                    source=root/name.replace('.dmg','.app.tar.gz')
                    data=plistlib.dumps(dict(CFBundleIdentifier='app.resonance.desktop',CFBundleShortVersionString='0.3.5'))
                    with tarfile.open(source,'w:gz') as tar:
                        member=tarfile.TarInfo('BiliMusic.app/Contents/Info.plist');member.size=len(data);tar.addfile(member,io.BytesIO(data))
                Path(str(source)+'.sig').write_text(self.signature())
            feed=prepare_updater(root,out,dict(version='0.3.5',platforms=packages),original)
            self.assertEqual(set(feed['platforms']),{'darwin-aarch64','darwin-x86_64','windows-x86_64','windows-aarch64'})
            self.assertEqual(len({p['url'] for p in feed['platforms'].values()}),4)
            self.assertEqual(updater_assets(out,'0.3.5')[0],feed)

    def test_unsigned_build_produces_empty_feed_and_cannot_reuse_an_old_ota(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.assertEqual(prepare_updater(root, root, {'version': '0.3.5', 'platforms': [{'platform':'Windows','file':'setup.exe'}]}, {'Windows':'setup.exe'})['platforms'], {})
            _, assets = updater_assets(root, '0.3.5')
            self.assertEqual([a['name'] for a in assets], ['updater.json'])
            with self.assertRaisesRegex(ValueError, 'version/platform'): updater_assets(root, '0.3.4')

    def test_invalid_signature_is_not_published(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'app.sig'; path.write_text('not a signature')
            with self.assertRaises(ValueError): signature_text(path)

    def test_feed_activation_is_idempotent_and_creates_missing_mirror_files(self):
        with tempfile.TemporaryDirectory() as folder:
            feed = {'version':'0.3.5','platforms':{}}
            p=Publisher({'version':'0.3.5','source':'a'*40,'revision':'test','updater':feed,'siteRoot':folder}, {}, folder)
            def request(channel,path,method='GET',payload=None):
                if method=='GET': raise ApiError(channel,method,path,404)
                return {}
            p.api=Mock(side_effect=request);p.activate_updater()
            self.assertEqual(json.loads((Path(folder)/'updater.json').read_text()),feed)
            self.assertEqual([c.args[2] for c in p.api.call_args_list if len(c.args)>2], ['PUT','POST'])
            p.api=Mock(return_value={'content':base64.b64encode(json.dumps(feed).encode()).decode()})
            p.activate_updater();self.assertEqual(p.api.call_count,2)

if __name__=='__main__':unittest.main()
