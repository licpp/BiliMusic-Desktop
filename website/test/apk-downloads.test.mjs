import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { apkDownloadPath, serveApk } from '../apk-downloads.mjs';
import { resolveDownload } from '../releases.mjs';

test('the Gitee phone and car APK buttons use first-party links', () => {
  for (const platform of ['android', 'android-large', 'android-large-armv7']) {
    const request = { platform, consent:true, policyVersion:'current' };
    const gitee = resolveDownload({ ...request, source:'gitee' }, 'current');
    const github = resolveDownload({ ...request, source:'github' }, 'current');
    assert.equal(gitee.url, `/downloads/apk/${gitee.file}`);
    assert.ok(github.url.startsWith('https://github.com/'));
    assert.equal(gitee.sha256, github.sha256);
  }
});

test('the APK response keeps its name and MIME type for full and resumed downloads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bilimusic-apk-test-'));
  const platform = { status:'available', file:'app.apk', size:7, sha256:'a'.repeat(64), channels:[{ id:'gitee', url:'https://gitee.com/' }] };
  const asset = pathToFileURL(directory + '/');
  await writeFile(new URL(platform.file, asset), 'apkdata');
  const server = createServer((req, res) => {
    const selected = req.url === apkDownloadPath(platform) ? platform : undefined;
    serveApk(req, res, selected, asset).catch(error => res.writeHead(error.status || 500).end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive:true, force:true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = base + apkDownloadPath(platform);
  const head = await fetch(url, { method:'HEAD' });
  assert.equal(head.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(head.headers.get('content-disposition'), 'attachment; filename="app.apk"');
  assert.equal(head.headers.get('content-length'), '7');
  assert.equal(await (await fetch(url)).text(), 'apkdata');
  const part = await fetch(url, { headers:{ Range:'bytes=3-' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 3-6/7');
  assert.equal(await part.text(), 'data');
  const pastEnd = await fetch(url, { headers:{ Range:'bytes=7-' } });
  assert.equal(pastEnd.status, 416);
  assert.equal((await fetch(base + '/downloads/apk/other.apk')).status, 404);
});
