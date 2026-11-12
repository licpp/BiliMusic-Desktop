# /// script
# requires-python = ">=3.11"
# dependencies = ["paramiko>=3.5,<5"]
# ///
"""Resumable release workflow. No credentials are written to plans or reports."""
import argparse
import base64
import contextlib
import getpass
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


def require(value, message):
    if not value:
        raise ValueError(message)


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def save_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


@contextlib.contextmanager
def publication_lock(site, plan_digest, work):
    import fcntl
    owner = Path(site) / '.release-workflow-owner.json'
    with (Path(site) / '.release-workflow.lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another release phase is running; retry after it finishes') from None
        previous = json.loads(owner.read_text()) if owner.exists() else None
        require(not previous or previous.get('complete') or previous['planDigest'] == plan_digest, 'Another release plan is unfinished; resume that plan before starting a different release')
        save_json(owner, {'planDigest': plan_digest, 'work': str(work), 'complete': False})
        yield owner


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None  # Never forward API authorization to an asset CDN.


class ApiError(RuntimeError):
    def __init__(self, channel, method, path, status):
        self.status = status
        super().__init__(f'{channel} {method} {path}: HTTP {status}')


def public_download(url, expected=None, destination=None):
    require(url.startswith('https://'), 'Downloads must use HTTPS')
    for attempt in range(3):
        try:
            hasher, size = hashlib.sha256(), 0
            request = urllib.request.Request(url, headers={'User-Agent': 'BiliMusic-release-verification'})
            with urllib.request.urlopen(request, timeout=120) as response:
                require(response.url.startswith('https://'), 'Unsafe download redirect')
                temporary = Path(str(destination) + '.download-tmp') if destination else None
                output = temporary.open('wb') if temporary else None
                try:
                    while chunk := response.read(128 * 1024):
                        size += len(chunk)
                        require(size <= (expected['size'] if expected else 64 * 1024 * 1024), 'Unexpected download size')
                        hasher.update(chunk)
                        if output:
                            output.write(chunk)
                finally:
                    if output:
                        output.close()
            result = {'url': url, 'size': size, 'sha256': hasher.hexdigest()}
            if expected:
                require(size == expected['size'] and result['sha256'] == expected['sha256'], 'Download SHA-256 mismatch')
            if destination:
                temporary.replace(destination)
            return result
        except Exception:
            if destination:
                Path(str(destination) + '.download-tmp').unlink(missing_ok=True)
            if attempt == 2:
                raise RuntimeError('Could not verify public download: ' + url) from None
            time.sleep(2)


def deploy_site(site, work, candidate, previous, run, get):
    """Replace only the manifest, preserving the site and PostgreSQL counters."""
    path, backup = Path(site) / 'releases.json', Path(work) / 'previous-live-releases.json'
    current = json.loads(path.read_text())
    require(current in (previous, candidate), 'Live website changed concurrently; refusing deployment')
    before = get('/api/v1/download-stats')['total']
    if not backup.exists():
        require(current == previous, 'Missing rollback manifest for already-active candidate')
        shutil.copy2(path, backup)
    def healthy():
        require(get('/api/v1/releases') == candidate, 'Website manifest mismatch')
        require(get('/api/v1/health')['status'] == 'ok', 'Website health check failed')
        require(get('/api/v1/download-stats')['total'] >= before, 'Download counters changed unexpectedly')
    if current == candidate:
        healthy()
        return {'version': candidate['version'], 'downloadCountPreserved': True, 'resumed': True}
    try:
        temporary = path.with_suffix('.json.publish-tmp')
        save_json(temporary, candidate)
        temporary.replace(path)
        run(['docker', 'restart', 'bilimusic-site'])
        for attempt in range(15):
            try:
                healthy()
                return {'version': candidate['version'], 'downloadCountPreserved': True, 'resumed': False}
            except Exception:
                if attempt == 14:
                    raise
                time.sleep(1)
    except Exception:
        shutil.copy2(backup, path)
        run(['docker', 'restart', 'bilimusic-site'])
        raise RuntimeError('Website validation failed; previous manifest restored') from None


class Publisher:
    def __init__(self, plan, secrets, work):
        self.plan, self.secrets, self.work = plan, secrets, Path(work)
        self.work.mkdir(parents=True, exist_ok=True)
        self.opener = urllib.request.build_opener(NoRedirect)
        self.report = json.loads((self.work / 'report.json').read_text()) if (self.work / 'report.json').exists() else {}
        require(not self.report or self.report['planDigest'] == fingerprint(plan), 'A different release plan already owns this staging directory')
        self.report.pop('complete', None)
        self.report.update(version=plan['version'], source=plan['source'], revision=plan['revision'], planDigest=fingerprint(plan))

    def record(self, stage, result):
        self.report[stage] = result
        save_json(self.work / 'report.json', self.report)
        print(json.dumps({'stage': stage, 'status': 'verified'}, ensure_ascii=False), flush=True)

    def base(self, channel):
        host = 'https://api.github.com/repos/' if channel == 'github' else 'https://gitee.com/api/v5/repos/'
        return host + self.plan['repos'][channel]

    def api(self, channel, path, method='GET', payload=None, binary=None, multipart=None):
        url = path if path.startswith('https://') else self.base(channel) + path
        allowed = ('https://api.github.com/', 'https://uploads.github.com/') if channel == 'github' else ('https://gitee.com/api/v5/',)
        require(url.startswith(allowed), 'Unexpected authenticated API host')
        headers = {'Authorization': 'Bearer ' + self.secrets[channel], 'User-Agent': 'BiliMusic-release-workflow', 'Accept': 'application/json'}
        body = None
        if payload is not None:
            if channel == 'gitee' and method in ('POST', 'PUT', 'PATCH'):
                body = urllib.parse.urlencode(payload).encode()
                headers['Content-Type'] = 'application/x-www-form-urlencoded'
            else:
                body = json.dumps(payload).encode()
                headers['Content-Type'] = 'application/json'
        if binary is not None:
            body, headers['Content-Type'] = binary, 'application/octet-stream'
        if multipart:
            name, data = multipart
            boundary = 'BiliMusic' + uuid.uuid4().hex
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + data + f'\r\n--{boundary}--\r\n'.encode())
            headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
        if body is not None:
            headers['Content-Length'] = str(len(body))
        try:
            with self.opener.open(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=180) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raise ApiError(channel, method, urllib.parse.urlparse(url).path, error.code) from None

    def release(self, channel):
        try:
            release = self.api(channel, '/releases/tags/' + self.plan['tag'])
        except ApiError as error:
            if error.status != 404:
                raise
            # New versions start as public prereleases so package URLs can be
            # verified before promotion and before the website is switched.
            self.api(channel, '/commits/' + self.plan['source'])
            try:
                tag = self.api(channel, '/commits/' + self.plan['tag'])
                require(tag['sha'] == self.plan['source'], 'Existing tag points at a different source')
            except ApiError as tag_error:
                if tag_error.status != 404:
                    raise
            release = self.api(channel, '/releases', 'POST', {
                'tag_name': self.plan['tag'], 'target_commitish': self.plan['source'],
                'name': 'BiliMusic ' + self.plan['version'], 'body': '安装包正在验证，完成后正式开放下载。',
                'prerelease': True if channel == 'github' else 'true',
            })
        require(not release.get('draft') and release['tag_name'] == self.plan['tag'], 'Expected a public release for this version')
        if release.get('prerelease'):
            require(self.api(channel, '/commits/' + self.plan['tag'])['sha'] == self.plan['source'], 'Prerelease source mismatch')
        return release

    def list_assets(self, channel, release):
        if channel == 'github':
            return self.api(channel, f'/releases/{release["id"]}/assets?per_page=100')
        return self.api(channel, f'/releases/{release["id"]}/attach_files?per_page=100')

    def delete_asset(self, channel, release, asset):
        path = f'/releases/assets/{asset["id"]}' if channel == 'github' else f'/releases/{release["id"]}/attach_files/{asset["id"]}'
        self.api(channel, path, 'DELETE')

    def public_url(self, channel, name):
        host = 'https://github.com/' if channel == 'github' else 'https://gitee.com/'
        return host + self.plan['repos'][channel] + '/releases/download/' + self.plan['tag'] + '/' + urllib.parse.quote(name)

    def asset_matches(self, channel, release, existing, asset):
        if existing['size'] != asset['size']:
            return False
        if channel == 'github' and existing.get('digest'):
            return existing['digest'] == 'sha256:' + asset['sha256'] and existing.get('state') == 'uploaded'
        # An attachment ID is immutable; the filename URL can still cache the
        # superseded checksum/notice file immediately after a replacement.
        url = self.base(channel) + f'/releases/{release["id"]}/attach_files/{existing["id"]}/download'
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + self.secrets[channel], 'User-Agent': 'BiliMusic-release-workflow'})
        try:
            with self.opener.open(request, timeout=120) as response:
                data = response.read(64 * 1024 * 1024 + 1)
                require(len(data) <= 64 * 1024 * 1024, 'Attachment exceeded size limit')
                return len(data) == asset['size'] and hashlib.sha256(data).hexdigest() == asset['sha256']
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise RuntimeError('Gitee attachment download HTTP ' + str(error.code)) from None
            result = public_download(error.headers['Location'])
            return result['size'] == asset['size'] and result['sha256'] == asset['sha256']

    def stage_asset(self, channel, release, asset):
        data = (self.work / 'assets' / asset['name']).read_bytes()
        require(len(data) == asset['size'] and hashlib.sha256(data).hexdigest() == asset['sha256'], 'Staged asset corrupted')
        for attempt in range(3):
            try:
                existing = next((a for a in self.list_assets(channel, release) if a['name'] == asset['name']), None)
                if existing and self.asset_matches(channel, release, existing, asset):
                    return
                if existing:
                    require(not asset['binary'], 'Binary name is already used; choose a revision-specific filename')
                    backup = self.work / 'original-assets' / channel
                    backup.mkdir(parents=True, exist_ok=True)
                    if not (backup / asset['name']).exists():
                        public_download(self.public_url(channel, asset['name']), destination=backup / asset['name'])
                    self.delete_asset(channel, release, existing)
                if channel == 'github':
                    url = f'https://uploads.github.com/repos/{self.plan["repos"][channel]}/releases/{release["id"]}/assets?name=' + urllib.parse.quote(asset['name'])
                    uploaded = self.api(channel, url, 'POST', binary=data)
                else:
                    uploaded = self.api(channel, f'/releases/{release["id"]}/attach_files', 'POST', multipart=(asset['name'], data))
                # Re-list on the next call if a service response has no attachment envelope.
                existing = next((a for a in self.list_assets(channel, release) if a['name'] == asset['name']), None)
                require(existing and self.asset_matches(channel, release, existing, asset), 'Uploaded asset verification failed')
                print(json.dumps({'uploaded': asset['name'], 'channel': channel}), flush=True)
                return
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2)

    def check_ci(self):
        for platform, run in self.plan['ciRuns'].items():
            data = self.api('github', f'/actions/runs/{run}')
            require(data['conclusion'] == 'success' and data['head_sha'] == self.plan['source'], 'Build provenance mismatch: ' + platform)
        self.record('ci', self.plan['ciRuns'])

    def stage(self):
        self.check_ci()
        releases = {channel: self.release(channel) for channel in ('github', 'gitee')}
        for channel, release in releases.items():
            for asset in self.plan['assets']:
                if asset['binary']:
                    self.stage_asset(channel, release, asset)
        self.record('staged', {'binaryAssets': 8})

    def finish_release(self):
        verification = json.loads((self.work / 'download-verification.json').read_text())
        require(verification['planDigest'] == fingerprint(self.plan), 'Download verification belongs to another plan')
        downloads = verification['results']
        require(len(downloads) == 8 and len({d['url'] for d in downloads}) == 8, 'Expected eight verified downloads')
        for package in self.plan['manifest']['platforms']:
            for channel in package['channels']:
                require(channel['url'] == self.public_url(channel['id'], package['file']), 'Unexpected public download URL')
                match = next((d for d in downloads if d['url'] == channel['url']), None)
                require(match and match['size'] == package['size'] and match['sha256'] == package['sha256'], 'Public download proof mismatch')
        self.record('downloads', downloads)
        releases = {channel: self.release(channel) for channel in ('github', 'gitee')}
        for channel, release in releases.items():
            for asset in self.plan['assets']:
                if not asset['binary']:
                    self.stage_asset(channel, release, asset)
            title = next(line[2:] for line in self.plan['notes'].splitlines() if line.startswith('# '))
            self.api(channel, f'/releases/{release["id"]}', 'PATCH', {'tag_name': self.plan['tag'], 'name': title, 'body': self.plan['notes'], 'prerelease': 'false'} if channel == 'gitee' else {'name': title, 'body': self.plan['notes'], 'prerelease': False, 'make_latest': 'true'})
        self.record('releaseMetadata', {'channels': ['github', 'gitee'], 'assets': len(self.plan['assets'])})

    def mirror(self, channel):
        path = '/contents/website/releases.json'
        current = self.api(channel, path + '?ref=main')
        value = json.loads(base64.b64decode(current['content']))
        if value == self.plan['manifest']:
            return
        require(value == self.plan['previous'], 'Update mirror changed concurrently: ' + channel)
        content = (json.dumps(self.plan['manifest'], ensure_ascii=False, indent=2) + '\n').encode()
        self.api(channel, path, 'PUT', {'message': f'Publish {self.plan["version"]} {self.plan["revision"]} download manifest [skip ci]', 'branch': 'main', 'sha': current['sha'], 'content': base64.b64encode(content).decode()})

    def get_site(self, path):
        raw = subprocess.check_output(['curl', '--resolve', self.plan['siteHost'] + ':443:127.0.0.1', '-fsS', '--max-time', '10', 'https://' + self.plan['siteHost'] + path], stderr=subprocess.PIPE, timeout=15)
        return json.loads(raw)

    def activate(self):
        require(len(self.report.get('downloads', [])) == 8, 'Cannot activate before eight downloads are verified')
        run = lambda args: subprocess.check_output(args, stderr=subprocess.PIPE, timeout=60)
        result = deploy_site(self.plan['siteRoot'], self.work, self.plan['manifest'], self.plan['previous'], run, self.get_site)
        self.record('website', result)
        for channel in ('github', 'gitee'):
            self.mirror(channel)
            self.record('mirror-' + channel, {'version': self.plan['version']})
        endpoints = ['https://' + self.plan['siteHost'] + '/api/v1/releases',
                     'https://gitee.com/' + self.plan['repos']['gitee'] + '/raw/main/website/releases.json',
                     'https://raw.githubusercontent.com/' + self.plan['repos']['github'] + '/main/website/releases.json']
        for attempt in range(40):
            states = []
            for url in endpoints:
                try:
                    with urllib.request.urlopen(url, timeout=15) as response:
                        states.append(json.load(response) == self.plan['manifest'])
                except Exception:
                    states.append(False)
            if all(states):
                self.record('publicManifests', {'urls': endpoints, 'sha256': fingerprint(self.plan['manifest'])})
                return
            if attempt == 0:
                print(json.dumps({'stage': 'publicManifests', 'status': 'waiting for CDN caches'}), flush=True)
            time.sleep(10)
        raise RuntimeError('Public mirror caches not yet consistent; rerun to resume, old packages retained')

    def prune(self):
        require('publicManifests' in self.report, 'Cannot remove old assets before all update sources are verified')
        new = {a['name'] for a in self.plan['assets']}
        old = {p['file'] for p in self.plan['previous']['platforms']} - new
        removed = []
        for channel in ('github', 'gitee'):
            release = self.release(channel)
            for asset in self.list_assets(channel, release):
                if asset['name'] in old:
                    self.delete_asset(channel, release, asset)
                    removed.append({'channel': channel, 'file': asset['name']})
        self.record('removedSupersededBinaries', removed)
        self.report.pop('lastFailure', None)
        self.record('complete', {'version': self.plan['version'], 'source': self.plan['source'], 'verifiedDownloadCount': 8, 'downloadCountPreserved': True})


def remote_main(work, phase):
    secrets = json.loads(sys.stdin.readline())  # Encrypted SSH stdin; never persisted.
    plan = json.loads((Path(work) / 'plan.json').read_text())
    publisher = Publisher(plan, secrets, work)
    try:
        with publication_lock(plan['siteRoot'], fingerprint(plan), work) as owner:
            if phase == 'stage':
                publisher.stage()
            else:
                publisher.finish_release()
                publisher.activate()
                publisher.prune()
                save_json(owner, {'planDigest': fingerprint(plan), 'work': work, 'complete': True})
    except Exception as error:
        publisher.report['lastFailure'] = {'type': type(error).__name__, 'message': str(error)}
        save_json(Path(work) / 'report.json', publisher.report)
        raise


def local_main(args):
    from release_packages import validate_bundle
    bundle = Path(args.bundle).resolve()
    plan = validate_bundle(bundle)
    plan.update(repos={'github': 'licpp/BiliMusic-Desktop', 'gitee': 'yoaker/BiliMusic-Desktop'}, siteHost='bilimusic.cn', siteRoot=args.site_root)
    require(args.site_root.startswith('/opt/'), 'Explicit /opt website directory required')
    save_json(bundle / 'release-plan.json', plan)
    print(json.dumps({'stage': 'localPackages', 'status': 'verified', 'source': plan['source']}), flush=True)
    if args.plan_only:
        return
    import paramiko
    ssh = paramiko.SSHClient()
    ssh.load_system_host_keys()
    try:
        ssh.connect(args.ssh_host, username=args.ssh_user, timeout=15, auth_timeout=15)
    except paramiko.SSHException as error:
        if not isinstance(error, paramiko.AuthenticationException) and 'No authentication methods available' not in str(error):
            raise
        ssh.connect(args.ssh_host, username=args.ssh_user, password=getpass.getpass('SSH password: '), timeout=15, auth_timeout=15, allow_agent=False, look_for_keys=False)
    work = args.site_root + '/.release-' + plan['version'] + '-' + fingerprint(plan)[:12]
    try:
        require(ssh.exec_command('mkdir -m 700 -p ' + shlex.quote(work + '/assets'))[1].channel.recv_exit_status() == 0, 'Cannot stage release directory')
        with ssh.open_sftp() as sftp:
            for asset in plan['assets']:
                sftp.put(str(bundle / asset['name']), work + '/assets/' + asset['name'])
            sftp.put(str(bundle / 'release-plan.json'), work + '/plan.json')
            sftp.put(str(Path(__file__).resolve()), work + '/publish_release.py')
        def run_phase(phase):
            secrets = {name: subprocess.check_output([cli, 'auth', 'token'], text=True, stderr=subprocess.DEVNULL).strip() for name, cli in [('github', 'gh'), ('gitee', 'gitee')]}
            cmd = 'python3 ' + shlex.quote(work + '/publish_release.py') + ' --remote-work ' + shlex.quote(work) + ' --remote-phase ' + phase
            stdin, stdout, stderr = ssh.exec_command(cmd, timeout=2400)
            stdin.write(json.dumps(secrets) + '\n')
            stdin.flush()
            stdin.channel.shutdown_write()
            secrets.clear()
            for line in stdout:
                print(line, end='', flush=True)
            status = stdout.channel.recv_exit_status()
            stderr.read()
            with ssh.open_sftp() as sftp:
                sftp.get(work + '/report.json', str(bundle / 'release-report.json'))
            if status:
                report = json.loads((bundle / 'release-report.json').read_text())
                raise RuntimeError(report.get('lastFailure', {}).get('message', 'Remote workflow failed; rerun to resume'))
        run_phase('stage')
        verification = bundle / 'download-verification.json'
        subprocess.run(['node', str(Path(__file__).with_name('verify_release_downloads.mjs')), str(bundle / 'release-plan.json'), str(verification), fingerprint(plan)], check=True)
        with ssh.open_sftp() as sftp:
            sftp.put(str(verification), work + '/download-verification.json')
        run_phase('activate')
        report = json.loads((bundle / 'release-report.json').read_text())
        require(report.get('complete', {}).get('verifiedDownloadCount') == 8, 'Incomplete release report')
        print(json.dumps({'report': str(bundle / 'release-report.json'), 'status': 'complete'}), flush=True)
    finally:
        ssh.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle')
    parser.add_argument('--ssh-host')
    parser.add_argument('--ssh-user', default='root')
    parser.add_argument('--site-root', default='/opt/bilimusic-site')
    parser.add_argument('--plan-only', action='store_true')
    parser.add_argument('--remote-work', help=argparse.SUPPRESS)
    parser.add_argument('--remote-phase', choices=['stage', 'activate'], help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.remote_work:
            require(args.remote_phase, 'Remote phase is required')
            remote_main(args.remote_work, args.remote_phase)
        else:
            require(args.bundle and (args.plan_only or args.ssh_host), 'Provide --bundle and --ssh-host (or --plan-only)')
            local_main(args)
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
