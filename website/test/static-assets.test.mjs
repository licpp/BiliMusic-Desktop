import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function startTestServer(port) {
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: siteDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) return proc;
    } catch {}
    await delay(100);
  }
  proc.kill();
  throw new Error('Test server failed to start');
}

test('static JPEG images return image/jpeg and support ETag 304 caching', async () => {
  const port = 33180 + Math.floor(Math.random() * 500);
  const proc = await startTestServer(port);
  try {
    const jpg = await fetch(`http://127.0.0.1:${port}/assets/qq-community.jpg`);
    assert.equal(jpg.status, 200);
    assert.equal(jpg.headers.get('content-type'), 'image/jpeg');
    const etag = jpg.headers.get('etag');
    assert.ok(etag, 'ETag should be set on static images');
    assert.match(jpg.headers.get('cache-control') || '', /max-age=86400/);

    const cached = await fetch(`http://127.0.0.1:${port}/assets/qq-community.jpg`, {
      headers: { 'If-None-Match': etag },
    });
    assert.equal(cached.status, 304);

    const robots = await fetch(`http://127.0.0.1:${port}/robots.txt`);
    assert.equal(robots.status, 200);
    assert.match(robots.headers.get('content-type') || '', /^text\/plain/);

    const sitemap = await fetch(`http://127.0.0.1:${port}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type') || '', /^application\/xml/);
  } finally {
    proc.kill('SIGTERM');
  }
});
