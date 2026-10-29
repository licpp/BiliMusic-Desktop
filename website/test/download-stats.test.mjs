import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { recordDownload, getDownloadStats } from '../downloads.mjs';

// Explicit integration opt-in; all tables live in a disposable, isolated schema.
test('download counts survive concurrent requests/restarts and isolate versions', {
  skip: !process.env.DOWNLOAD_STATS_TEST_DATABASE_URL, timeout:30000,
}, async () => {
  const admin = new pg.Pool({ connectionString:process.env.DOWNLOAD_STATS_TEST_DATABASE_URL });
  const schema = `download_test_${randomUUID().replaceAll('-','')}`;
  const connection = new URL(process.env.DOWNLOAD_STATS_TEST_DATABASE_URL);
  connection.searchParams.set('options',`-c search_path=${schema}`);
  const db = new pg.Pool({ connectionString:connection.href });
  const base = 'http://127.0.0.1:3182';
  let child;
  async function start() {
    child = spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{
      env:{...process.env,DATABASE_URL:connection.href,PORT:'3182',HOST:'127.0.0.1',PUBLIC_ORIGIN:base,IP_HASH_SECRET:'isolated-download-test-secret-1234567890'},
      stdio:'ignore',
    });
    for(let i=0;i<100;i++) {
      if(child.exitCode !== null) throw new Error('Isolated test server exited');
      try { if((await fetch(base+'/api/v1/health')).ok) return; } catch {}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('Isolated test server did not start');
  }
  async function stop() {
    if(child && child.exitCode === null) { const done=once(child,'exit');child.kill('SIGTERM');await done; }
    child=undefined;
  }
  const get = path => fetch(base+path).then(r=>r.json());
  const post = (body,origin=base) => fetch(base+'/api/v1/download',{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body),
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await start();
    const manifest=await get('/api/v1/releases'), policy=await get('/api/v1/policy');
    const input={platform:'mac',source:'gitee',consent:true,policyVersion:policy.version};
    const initial=await get('/api/v1/download-stats');assert.equal(initial.total,0);
    assert.equal((await post({...input,consent:false})).status,400);
    assert.equal((await post({...input,platform:'unknown'})).status,409);
    assert.equal((await post(input,'https://other.test')).status,403);
    assert.equal((await get('/api/v1/download-stats')).total,0);
    await Promise.all(Array.from({length:32},async()=>{
      const response=await post(input);assert.equal(response.status,200);
      assert.ok((await response.json()).url.includes('/releases/download/'));
    }));
    await recordDownload(db,'old-version','windows','github');
    await recordDownload(db,'old-version','android','gitee');
    const stats=await get('/api/v1/download-stats');
    assert.equal(stats.total,34);
    assert.equal(stats.versions.find(x=>x.version===manifest.version).downloads,32);
    assert.equal(stats.versions.find(x=>x.version==='old-version').downloads,2);
    const future=await getDownloadStats(db,'future-version');
    assert.equal(future.total,34);assert.equal(future.versions.find(x=>x.version==='future-version').downloads,0);
    await stop();await start();
    const restored=await get('/api/v1/download-stats');
    assert.equal(restored.total,34);assert.equal(restored.startedAt,initial.startedAt);
    // Only the disposable schema is affected. Statistics failures must not block downloads.
    await db.query('DROP TABLE download_counts');
    assert.equal((await fetch(base+'/api/v1/download-stats')).status,503);
    const fallback=await post(input);assert.equal(fallback.status,200);assert.ok((await fallback.json()).url);
  } finally {
    await stop();await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
