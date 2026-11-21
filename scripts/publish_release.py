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
import io
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
import threading
import tarfile
from concurrent.futures import ThreadPoolExecutor
import zipfile
from pathlib import Path


def require(value, message):
    if not value:
        raise ValueError(message)


def release_content_type(name):
    return {'.apk': 'application/vnd.android.package-archive', '.zip': 'application/zip', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown'}.get(Path(name).suffix.lower(), 'application/octet-stream')


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
            deadline = time.monotonic() + 180
            request = urllib.request.Request(url, headers={'User-Agent': 'BiliMusic-release-verification'})
            with urllib.request.urlopen(request, timeout=120) as response:
                require(response.url.startswith('https://'), 'Unsafe download redirect')
                temporary = Path(str(destination) + '.download-tmp') if destination else None
                output = temporary.open('wb') if temporary else None
                try:
                    while chunk := response.read(128 * 1024):
                        require(time.monotonic() < deadline, 'Download exceeded time limit')
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
                require(size == expected['size'] and (not expected.get('sha256') or result['sha256'] == expected['sha256']), 'Download SHA-256 mismatch')
            if destination:
                temporary.replace(destination)
            return result
        except Exception:
            if destination:
                Path(str(destination) + '.download-tmp').unlink(missing_ok=True)
            if attempt == 2:
                safe_url = urllib.parse.urlsplit(url)._replace(query='', fragment='').geturl()
                raise RuntimeError('Could not verify public download: ' + safe_url) from None
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


def cached_downloads_valid(plan, proof, upload_report, full_audit=False):
    expected = {c['url']: (p, c) for p in plan['manifest']['platforms'] for c in p['channels']}
    results = proof.get('results', [])
    if proof.get('planDigest') != fingerprint(plan) or len(results) != len(expected) or {r.get('url') for r in results} != set(expected):
        return False
    for result in results:
        package, channel = expected[result['url']]
        if (result.get('size'), result.get('sha256')) != (package['size'], package['sha256']):
            return False
        method = result.get('verification', 'full-download')
        if method == 'uploaded-hash-and-public-headers':
            receipt = upload_report.get('verifiedAssets', {}).get(channel['id'] + ':' + package['file'])
            if full_audit or not receipt or result.get('uploadProof') != receipt:
                return False
        elif method != 'full-download':
            return False
    return True


class Publisher:
    def __init__(self, plan, secrets, work):
        self.plan, self.secrets, self.work = plan, secrets, Path(work)
        self.report_lock = threading.RLock()
        self.work.mkdir(parents=True, exist_ok=True)
        self.opener = urllib.request.build_opener(NoRedirect)
        self.report = json.loads((self.work / 'report.json').read_text()) if (self.work / 'report.json').exists() else {}
        require(not self.report or self.report['planDigest'] == fingerprint(plan), 'A different release plan already owns this staging directory')
        self.report.pop('complete', None)
        self.report.update(version=plan['version'], source=plan['source'], revision=plan['revision'], planDigest=fingerprint(plan))

    def record(self, stage, result):
        with self.report_lock:
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
            body, headers['Content-Type'] = binary, release_content_type(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('name', [''])[0])
        if multipart:
            name, data = multipart
            boundary = 'BiliMusic' + uuid.uuid4().hex
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {release_content_type(name)}\r\n\r\n'.encode() + data + f'\r\n--{boundary}--\r\n'.encode())
            headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
        if body is not None:
            headers['Content-Length'] = str(len(body))
        try:
            upload_timeout = max(180, min(900, 60 + len(body or b'') / (128 * 1024)))
            with self.opener.open(urllib.request.Request(url, data=body, headers=headers, method=method), timeout=upload_timeout) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raise ApiError(channel, method, urllib.parse.urlparse(url).path, error.code) from None

    def release(self, channel):
        try:
            release = self.api(channel, '/releases/tags/' + self.plan['tag'])
            if release is None:
                raise ApiError(channel, 'GET', '/releases/tags/' + self.plan['tag'], 404)
        except ApiError as error:
            if error.status != 404:
                raise
            require('previousUpdater' not in self.plan, 'Platform patches require an existing published release')
            # New versions start as public prereleases so package URLs can be
            # verified before promotion and before the website is switched.
            self.api(channel, '/commits/' + self.plan['source'])
            try:
                tag = self.api(channel, '/commits/' + self.plan['tag'])
                if tag is None:
                    raise ApiError(channel, 'GET', '/commits/' + self.plan['tag'], 404)
                require(tag['sha'] == self.plan['source'], 'Existing tag points at a different source')
            except ApiError as tag_error:
                if tag_error.status != 404 and not (channel == 'github' and tag_error.status == 422):
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

    def public_url(self, channel, name, version=None):
        host = 'https://github.com/' if channel == 'github' else 'https://gitee.com/'
        tag = 'v' + version if version else self.plan['tag']
        return host + self.plan['repos'][channel] + '/releases/download/' + tag + '/' + urllib.parse.quote(name)

    def asset_matches(self, channel, release, existing, asset):
        if existing['size'] != asset['size']:
            return False
        identity = {'channel': channel, 'releaseId': release['id'], 'assetId': existing['id'],
                    'name': existing.get('name', asset['name']), 'size': existing['size'],
                    'updatedAt': existing.get('updated_at')}
        key = channel + ':' + asset['name']
        if channel == 'github' and existing.get('digest'):
            if existing['digest'] != 'sha256:' + asset['sha256'] or existing.get('state') != 'uploaded':
                return False
            method = 'server-sha256'
        else:
            with self.report_lock:
                cached = self.report.get('verifiedAssets', {}).get(key)
            if cached and all(cached.get(k) == v for k, v in identity.items()) and cached.get('sha256') == asset['sha256'] and cached.get('method') == 'downloaded-sha256':
                return True
            result = self.download_attachment(channel, release, existing)
            if result['size'] != asset['size'] or result['sha256'] != asset['sha256']:
                return False
            method = 'downloaded-sha256'
        with self.report_lock:
            self.report.setdefault('verifiedAssets', {})[key] = identity | {'sha256': asset['sha256'], 'method': method}
            save_json(self.work / 'report.json', self.report)
        return True

    def download_attachment(self, channel, release, existing, destination=None):
        # Immutable API IDs avoid cached filename redirects and bypass the
        # server's unreliable connection to the github.com web frontend.
        path = f'/releases/assets/{existing["id"]}' if channel == 'github' else f'/releases/{release["id"]}/attach_files/{existing["id"]}/download'
        url = self.base(channel) + path
        request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + self.secrets[channel], 'User-Agent': 'BiliMusic-release-workflow', 'Accept': 'application/octet-stream'})
        expected = {'size': existing['size'], 'sha256': (existing.get('digest') or '').removeprefix('sha256:') or None}
        try:
            with self.opener.open(request, timeout=60) as response:
                data = response.read(expected['size'] + 1)
                sha256 = hashlib.sha256(data).hexdigest()
                require(len(data) == expected['size'] and (not expected['sha256'] or sha256 == expected['sha256']), 'Attachment data mismatch')
                if destination:
                    temporary = Path(str(destination) + '.download-tmp')
                    temporary.write_bytes(data)
                    temporary.replace(destination)
                return {'size': len(data), 'sha256': sha256}
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308):
                raise RuntimeError(channel + ' attachment download HTTP ' + str(error.code)) from None
            return public_download(error.headers['Location'], expected, destination)

    def stage_asset(self, channel, release, asset):
        data = (self.work / 'assets' / asset['name']).read_bytes()
        require(len(data) == asset['size'] and hashlib.sha256(data).hexdigest() == asset['sha256'], 'Staged asset corrupted')
        for attempt in range(3):
            try:
                existing = next((a for a in self.list_assets(channel, release) if a['name'] == asset['name']), None)
                # A cancelled GitHub upload can leave an empty starter entry.
                # Remove only that unusable placeholder in an unpublished release.
                if existing and channel == 'github' and release.get('prerelease') and existing.get('state') == 'starter' and existing['size'] == 0:
                    self.delete_asset(channel, release, existing)
                    existing = None
                if existing and self.asset_matches(channel, release, existing, asset):
                    return
                if existing:
                    require(not asset['binary'], 'Binary name is already used; choose a revision-specific filename')
                    backup = self.work / 'original-assets' / channel
                    backup.mkdir(parents=True, exist_ok=True)
                    proof = json.loads((self.work / 'metadata-backup-proof.json').read_text())
                    require(proof['planDigest'] == fingerprint(self.plan), 'Metadata backup belongs to another plan')
                    original = next((x for x in proof['results'] if x['channel'] == channel and x['name'] == asset['name']), None)
                    require(original and (original['id'] == existing['id'] or existing.get('state') not in ('uploaded', None)), 'Metadata attachment changed concurrently')
                    saved = (backup / asset['name']).read_bytes()
                    require(len(saved) == original['size'] and hashlib.sha256(saved).hexdigest() == original['sha256'], 'Original metadata backup missing or corrupted')
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
        for platform, evidence in self.plan['ciRuns'].items():
            run = evidence['run'] if isinstance(evidence, dict) else evidence
            data = self.api('github', f'/actions/runs/{run}')
            source = self.plan.get('platformSources', {}).get(platform, self.plan['source'])
            require(data['conclusion'] == 'success', 'Build failed: ' + platform)
            if data['head_sha'] != source:
                # workflow_dispatch may check out a pinned source_ref rather
                # than the workflow's own head. Verify the actual CI output.
                require(isinstance(evidence, dict) and data.get('event') == 'workflow_dispatch', 'Build provenance mismatch: ' + platform)
                artifacts = self.api('github', f'/actions/runs/{run}/artifacts?per_page=100')['artifacts']
                matches = [a for a in artifacts if a['name'] == evidence['artifact'] and not a['expired']]
                require(len(matches) == 1, 'CI artifact missing or ambiguous: ' + platform)
                raw = self.ci_archive(matches[0]['id'])
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    require(archive.testzip() is None, 'Corrupt CI artifact')
                    notice = json.loads(archive.read(evidence['notice']))
                    require(notice['sourceCommit'] == source and notice['version'] == self.plan['version'], 'CI source notice mismatch: ' + platform)
                    package = archive.read(evidence['package'])
                    package_hash = hashlib.sha256(package).hexdigest()
                    require(any(a['binary'] and a['size'] == len(package) and a['sha256'] == package_hash for a in self.plan['assets']), 'CI package mismatch: ' + platform)
        self.record('ci', self.plan['ciRuns'])

    def ci_archive(self, artifact_id):
        request = urllib.request.Request(self.base('github') + f'/actions/artifacts/{artifact_id}/zip', headers={'Authorization': 'Bearer ' + self.secrets['github'], 'User-Agent': 'BiliMusic-release-workflow'})
        try:
            response = self.opener.open(request, timeout=60)
        except urllib.error.HTTPError as error:
            require(error.code == 302 and error.headers.get('Location', '').startswith('https://'), 'Unexpected CI artifact response')
            # The signed CDN URL must never receive the API bearer token.
            response = urllib.request.urlopen(error.headers['Location'], timeout=120)
        with response:
            raw = response.read(64 * 1024 * 1024 + 1)
        require(len(raw) <= 64 * 1024 * 1024, 'CI artifact exceeds size limit')
        return raw

    def stage(self):
        self.check_ci()
        releases = {channel: self.release(channel) for channel in ('github', 'gitee')}
        def upload_channel(channel):
            for asset in self.plan['assets']:
                if asset['binary']:
                    self.stage_asset(channel, releases[channel], asset)
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(upload_channel, releases))
        self.record('staged', {'binaryAssets': sum(a['binary'] for a in self.plan['assets']) * len(releases)})
        if 'originalMetadata' not in self.report:
            originals = []
            for channel, release in releases.items():
                for existing in self.list_assets(channel, release):
                    asset = next((a for a in self.plan['assets'] if a['name'] == existing['name'] and not a['binary']), None)
                    if not asset:
                        continue
                    if channel == 'github' and existing.get('digest') == 'sha256:' + asset['sha256']:
                        continue
                    originals.append({'channel': channel, 'name': existing['name'], 'id': existing['id'], 'size': existing['size'], 'sha256': (existing.get('digest') or '').removeprefix('sha256:') or None, 'url': self.public_url(channel, existing['name'])})
            self.record('originalMetadata', originals)

    def documentation_bundle(self):
        members = [a for a in self.plan['assets'] if not a['binary'] and a['name'] not in ('SHA256SUMS.txt', 'build-info.json', 'updater.json')]
        if not members:
            return None
        archive_name = f'RELEASE_DOCUMENTS-{self.plan["revision"]}.tar.xz' if 'previousUpdater' in self.plan else 'RELEASE_DOCUMENTS.tar.xz'
        path = self.work / 'assets' / archive_name
        with tarfile.open(path, 'w:xz', preset=6) as archive:
            for asset in sorted(members, key=lambda a: a['name']):
                data = (self.work / 'assets' / asset['name']).read_bytes()
                require(len(data) == asset['size'] and hashlib.sha256(data).hexdigest() == asset['sha256'], 'Documentation input changed')
                info = tarfile.TarInfo(asset['name']); info.size = len(data); info.mode = 0o644
                archive.addfile(info, io.BytesIO(data))
        raw = path.read_bytes()
        self.record('documentationBundle', {'name': path.name, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                                           'members': [{k: a[k] for k in ('name', 'size', 'sha256')} for a in members]})
        return {'name': path.name, 'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'binary': False}

    def finish_release(self):
        verification = json.loads((self.work / 'download-verification.json').read_text())
        require(verification['planDigest'] == fingerprint(self.plan), 'Download verification belongs to another plan')
        downloads = verification['results']
        expected_count = len({c['url'] for p in self.plan['manifest']['platforms'] for c in p['channels']})
        require(len(downloads) == expected_count and len({d['url'] for d in downloads}) == expected_count, 'Expected every manifest download to be verified')
        for package in self.plan['manifest']['platforms']:
            for channel in package['channels']:
                require(channel['url'] == self.public_url(channel['id'], package['file'], package.get('version', self.plan['version'])), 'Unexpected public download URL')
                match = next((d for d in downloads if d['url'] == channel['url']), None)
                require(match and match['size'] == package['size'] and match['sha256'] == package['sha256'], 'Public download proof mismatch')
                require(match.get('verification', 'full-download') in ('full-download', 'uploaded-hash-and-public-headers'), 'Unknown download verification method')
                if match.get('verification') == 'uploaded-hash-and-public-headers':
                    receipt = self.report.get('verifiedAssets', {}).get(channel['id'] + ':' + package['file'])
                    require(receipt and match.get('uploadProof') == receipt and receipt['sha256'] == package['sha256'] and receipt['size'] == package['size'], 'Upload digest proof missing or changed')
        self.record('downloads', downloads)
        releases = {channel: self.release(channel) for channel in ('github', 'gitee')}
        documents = self.documentation_bundle()
        def upload_metadata(channel):
            release = releases[channel]
            if channel == 'gitee' and documents:
                self.stage_asset(channel, release, documents)
            for asset in self.plan['assets']:
                if not asset['binary'] and (channel != 'gitee' or not documents or asset['name'] in ('SHA256SUMS.txt', 'build-info.json', 'updater.json')):
                    self.stage_asset(channel, release, asset)
            title = next(line[2:] for line in self.plan['notes'].splitlines() if line.startswith('# '))
            document_note = f'\n许可及独立签名文件收录于 `{documents["name"]}`。\n' if documents else ''
            self.api(channel, f'/releases/{release["id"]}', 'PATCH', {'tag_name': self.plan['tag'], 'name': title, 'body': self.plan['notes'] + document_note, 'prerelease': 'false'} if channel == 'gitee' else {'name': title, 'body': self.plan['notes'], 'prerelease': False, 'make_latest': 'true'})
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(upload_metadata, releases))
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

    def activate_updater(self):
        updater = self.plan.get('updater')
        if updater is None:
            return
        previous = self.plan.get('previousUpdater')
        site_feed = Path(self.plan['siteRoot']) / 'updater.json'
        if previous is not None:
            require(site_feed.exists() and json.loads(site_feed.read_text()) in (previous, updater), 'Live updater changed concurrently')
        # Every archive/signature was uploaded and hash-verified before exposing this feed.
        for channel in ('github', 'gitee'):
            path = '/contents/website/updater.json'
            try:
                current = self.api(channel, path + '?ref=main')
            except ApiError as error:
                if error.status != 404:
                    raise
                current = {}
            installed = json.loads(base64.b64decode(current['content'])) if current.get('content') else None
            if installed == updater:
                continue
            require(previous is None or installed == previous, 'Update feed changed concurrently: ' + channel)
            payload = {'message': f'Publish {self.plan["version"]} signed updater [skip ci]', 'branch': 'main',
                       'content': base64.b64encode((json.dumps(updater, ensure_ascii=False, indent=2) + '\n').encode()).decode()}
            if current.get('sha'):
                payload['sha'] = current['sha']
            self.api(channel, path, 'PUT' if current.get('sha') or channel == 'github' else 'POST', payload)
        temporary = site_feed.with_suffix('.json.publish-tmp')
        save_json(temporary, updater)
        temporary.replace(site_feed)
        self.record('updater', {'version': updater['version'], 'platforms': list(updater['platforms'])})

    site_filing_pending = False

    def get_site(self, path):
        raw = subprocess.check_output(['curl', '--resolve', self.plan['siteHost'] + ':443:127.0.0.1', '-fsS', '--max-time', '10', 'https://' + self.plan['siteHost'] + path], stderr=subprocess.PIPE, timeout=15)
        return json.loads(raw)

    def activate(self, verify_public=True):
        require(len(self.report.get('downloads', [])) >= 8, 'Cannot activate before eight downloads are verified')
        expected_urls = {c['url'] for p in self.plan['manifest']['platforms'] for c in p['channels']}
        require({d['url'] for d in self.report['downloads']} == expected_urls, 'Cannot activate before every manifest download is verified')
        run = lambda args: subprocess.check_output(args, stderr=subprocess.PIPE, timeout=60)
        result = deploy_site(self.plan['siteRoot'], self.work, self.plan['manifest'], self.plan['previous'], run, self.get_site)
        self.record('website', result)
        self.activate_updater()
        for channel in ('github', 'gitee'):
            self.mirror(channel)
            self.record('mirror-' + channel, {'version': self.plan['version']})
        endpoints = ['https://' + self.plan['siteHost'] + '/api/v1/releases',
                     'https://gitee.com/' + self.plan['repos']['gitee'] + '/raw/main/website/releases.json',
                     'https://raw.githubusercontent.com/' + self.plan['repos']['github'] + '/main/website/releases.json']
        if self.site_filing_pending:
            self.record('websitePublic', {'status': 'pending-icp-filing', 'url': endpoints[0], 'serverManifestVerified': True})
            endpoints = endpoints[1:]
        if not verify_public:
            return
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

    def verify_manifest_proof(self):
        proof = json.loads((self.work / 'public-manifest-verification.json').read_text())
        require(proof.get('planDigest') == fingerprint(self.plan), 'Manifest verification belongs to another plan')
        urls = ['https://gitee.com/' + self.plan['repos']['gitee'] + '/raw/main/website/releases.json',
                'https://raw.githubusercontent.com/' + self.plan['repos']['github'] + '/main/website/releases.json']
        if not self.site_filing_pending:
            urls.insert(0, 'https://' + self.plan['siteHost'] + '/api/v1/releases')
        results = proof.get('results', [])
        require(len(results) == len(urls) and {r.get('url') for r in results} == set(urls), 'Every public manifest must be verified')
        require(all(r.get('manifest') == self.plan['manifest'] for r in results), 'Public manifest contents differ from the release')
        self.record('publicManifests', {'urls': urls, 'sha256': fingerprint(self.plan['manifest']), 'verifiedBy': 'publishing-workstation'})

    def prune(self, keep_superseded=False):
        require('publicManifests' in self.report, 'Cannot remove old assets before all update sources are verified')
        new = {a['name'] for a in self.plan['assets']} | {p['file'] for p in self.plan['manifest']['platforms']}
        def updater_files(feed):
            archives = {Path(urllib.parse.urlsplit(entry['url']).path).name for entry in feed.get('platforms', {}).values()}
            return archives | {name + '.sig' for name in archives}
        new |= updater_files(self.plan.get('updater', {}))
        old = ({p['file'] for p in self.plan['previous']['platforms']} | updater_files(self.plan.get('previousUpdater', {}))) - new
        removed = []
        if not keep_superseded:
            for channel in ('github', 'gitee'):
                release = self.release(channel)
                for asset in self.list_assets(channel, release):
                    if asset['name'] in old:
                        self.delete_asset(channel, release, asset)
                        removed.append({'channel': channel, 'file': asset['name']})
        self.record('removedSupersededBinaries', removed)
        self.report.pop('lastFailure', None)
        self.record('complete', {'version': self.plan['version'], 'source': self.plan['source'], 'verifiedDownloadCount': len(self.report['downloads']), 'downloadCountPreserved': True})


def remote_main(work, phase, site_filing_pending=False, keep_superseded=False):
    secrets = json.loads(sys.stdin.readline())  # Encrypted SSH stdin; never persisted.
    plan = json.loads((Path(work) / 'plan.json').read_text())
    publisher = Publisher(plan, secrets, work)
    filing_receipt = Path(work) / 'site-filing-pending.json'
    if filing_receipt.exists():
        require(json.loads(filing_receipt.read_text())['planDigest'] == fingerprint(plan), 'Filing acknowledgement belongs to another plan')
        site_filing_pending = True
    publisher.site_filing_pending = site_filing_pending
    try:
        with publication_lock(plan['siteRoot'], fingerprint(plan), work) as owner:
            if phase == 'stage':
                publisher.stage()
            elif phase == 'activate':
                publisher.finish_release()
                publisher.activate(verify_public=False)
            else:
                publisher.verify_manifest_proof()
                publisher.prune(keep_superseded)
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
        inspect = "from pathlib import Path\nimport hashlib,json\nroot=Path(" + repr(work + '/assets') + ")\nresult={}\nfor path in root.iterdir():\n if path.is_file():\n  h=hashlib.sha256()\n  with path.open('rb') as f:\n   for chunk in iter(lambda:f.read(131072),b''):h.update(chunk)\n  result[path.name]={'size':path.stat().st_size,'sha256':h.hexdigest()}\nprint(json.dumps(result))\n"
        _, index_out, index_error = ssh.exec_command("python3 - <<'PY'\n" + inspect + 'PY', timeout=60)
        staged = json.loads(index_out.read().decode())
        require(index_out.channel.recv_exit_status() == 0, 'Cannot inspect existing staged files')
        uploaded = 0
        with ssh.open_sftp() as sftp:
            for asset in plan['assets']:
                if staged.get(asset['name']) != {'size': asset['size'], 'sha256': asset['sha256']}:
                    sftp.put(str(bundle / asset['name']), work + '/assets/' + asset['name'])
                    uploaded += 1
            sftp.put(str(bundle / 'release-plan.json'), work + '/plan.json')
            sftp.put(str(Path(__file__).resolve()), work + '/publish_release.py')
            if args.site_filing_pending:
                with sftp.open(work + '/site-filing-pending.json', 'w') as acknowledgement:
                    acknowledgement.write(json.dumps({'planDigest': fingerprint(plan), 'status': 'pending-icp-filing'}))
        print(json.dumps({'stagedInputs': len(plan['assets']), 'uploaded': uploaded, 'reused': len(plan['assets']) - uploaded}), flush=True)
        def run_phase(phase):
            secrets = {name: subprocess.check_output([cli, 'auth', 'token'], text=True, stderr=subprocess.DEVNULL).strip() for name, cli in [('github', 'gh'), ('gitee', 'gitee')]}
            cmd = 'python3 ' + shlex.quote(work + '/publish_release.py') + ' --remote-work ' + shlex.quote(work) + ' --remote-phase ' + phase + (' --site-filing-pending' if args.site_filing_pending else '') + (' --keep-superseded' if args.keep_superseded else '')
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
        if getattr(args, 'stage_only', False):
            print(json.dumps({'stage': 'stagedOnly', 'status': 'ready for activation'}), flush=True)
            return
        previous_bundle = Path(args.previous_bundle).resolve() if args.previous_bundle else bundle.parent / ('BiliMusic-' + plan['previous']['version'] + '-release')
        subprocess.run(['node', str(Path(__file__).with_name('backup_release_metadata.mjs')), str(bundle / 'release-report.json'), str(bundle), str(previous_bundle)], check=True)
        metadata_proof = json.loads((bundle / 'metadata-backup-proof.json').read_text())
        with ssh.open_sftp() as sftp:
            for channel in ('github', 'gitee'):
                directory = work + '/original-assets/' + channel
                ssh.exec_command('mkdir -p ' + shlex.quote(directory))[1].channel.recv_exit_status()
                for item in metadata_proof['results']:
                    if item['channel'] == channel:
                        sftp.put(str(bundle / 'original-assets' / channel / item['name']), directory + '/' + item['name'])
            sftp.put(str(bundle / 'metadata-backup-proof.json'), work + '/metadata-backup-proof.json')
        verification = bundle / 'download-verification.json'
        cached = json.loads(verification.read_text()) if verification.exists() else {}
        expected = {c['url']: (p['size'], p['sha256']) for p in plan['manifest']['platforms'] for c in p['channels']}
        uploaded_report = json.loads((bundle / 'release-report.json').read_text())
        valid = cached_downloads_valid(plan, cached, uploaded_report, args.full_download_audit)
        if not valid:
            subprocess.run(['node', str(Path(__file__).with_name('verify_release_downloads.mjs')), str(bundle / 'release-plan.json'), str(verification), fingerprint(plan), '--upload-proof', str(bundle / 'release-report.json')] + (['--full-download'] if args.full_download_audit else []), check=True)
        else:
            print(json.dumps({'stage': 'publicDownloads', 'status': 'reused verified proof'}), flush=True)
        with ssh.open_sftp() as sftp:
            sftp.put(str(verification), work + '/download-verification.json')
        run_phase('activate')
        public_proof = bundle / 'public-manifest-verification.json'
        activated = json.loads((bundle / 'release-report.json').read_text())
        filing_pending = args.site_filing_pending or activated.get('websitePublic', {}).get('status') == 'pending-icp-filing'
        subprocess.run(['node', str(Path(__file__).with_name('verify_release_manifests.mjs')), str(bundle / 'release-plan.json'), str(public_proof), fingerprint(plan)] + (['filing-pending'] if filing_pending else []), check=True)
        with ssh.open_sftp() as sftp:
            sftp.put(str(public_proof), work + '/public-manifest-verification.json')
        run_phase('finalize')
        report = json.loads((bundle / 'release-report.json').read_text())
        require(report.get('complete', {}).get('verifiedDownloadCount') == len(expected), 'Incomplete release report')
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
    parser.add_argument('--stage-only', action='store_true', help='Upload and verify binaries without activating release or website')
    parser.add_argument('--site-filing-pending', action='store_true', help='Publish verified site configuration while explicitly recording public access pending ICP filing')
    parser.add_argument('--full-download-audit', action='store_true', help='Audit every public installer by downloading and hashing it again')
    parser.add_argument('--keep-superseded', action='store_true', help='Keep superseded installer assets available for rollback')
    parser.add_argument('--previous-bundle', help='Optional original release directory used to reuse verified metadata backups')
    parser.add_argument('--remote-work', help=argparse.SUPPRESS)
    parser.add_argument('--remote-phase', choices=['stage', 'activate', 'finalize'], help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.remote_work:
            require(args.remote_phase, 'Remote phase is required')
            remote_main(args.remote_work, args.remote_phase, args.site_filing_pending, args.keep_superseded)
        else:
            require(args.bundle and (args.plan_only or args.ssh_host), 'Provide --bundle and --ssh-host (or --plan-only)')
            local_main(args)
    except Exception as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
