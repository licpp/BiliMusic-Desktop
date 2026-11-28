import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { createFeedbackAdmin, hashFeedbackAdminPassword, initializeFeedbackAdmin } from '../feedback-admin.mjs';
import { initializeFeedbackSubmissions } from '../feedback-submission.mjs';
import { initializeFeedbackTracking } from '../feedback-tracking.mjs';
import { HttpError } from '../validation.mjs';

const credentials = { username: 'admin', password: 'test-account-passphrase' };
const origin = 'https://bilimusic.example';
const env = {
  FEEDBACK_ADMIN_USERNAME: credentials.username,
  FEEDBACK_ADMIN_PASSWORD_HASH: await hashFeedbackAdminPassword(credentials.password),
};
const prefix = '/api/v1/admin/feedback';
const id = '69661df0-b78f-486b-aabc-ed53365381b3';
const imageId = '8bdab067-d8c7-4d5d-9db3-4eea1a0d1f68';

async function exercise(t, options = {}) {
  const calls = [];
  const handler = createFeedbackAdmin({
    pool: { async query(statement, args) {
      calls.push({ statement, args });
      return { rows: [{ id, mime_type: 'image/png', data: Buffer.from('test image'), total: 1, items: [{ id }] }] };
    } }, origin, env, ...options,
  });
  const server = createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url, origin).pathname.replace('/api/v1/', '/api/');
      if (!await handler(req, res, path, json)) json(404, {});
    } catch (error) {
      json(error instanceof HttpError ? error.status : 500, { message: error.message });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const request = (path = '', { method = 'GET', body, cookie, requestOrigin = options.origin ?? origin, headers } = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${prefix}${path}`, {
      method,
      headers: { Origin: requestOrigin, ...(cookie && { Cookie: cookie }), ...(body && { 'Content-Type': 'application/json' }), ...headers },
      ...(body && { body: JSON.stringify(body) }),
    });
  const login = (data = credentials, requestOptions = {}) => request('/session', { method: 'POST', body: data, ...requestOptions });
  return { calls, request, login };
}

test('disabled or non-HTTPS public admin returns 503', async t => {
  const disabled = await exercise(t, { env: {} });
  assert.equal((await disabled.request('/session')).status, 503);
  const publicHttp = await exercise(t, { origin: 'http://bilimusic.example' });
  assert.equal((await publicHttp.login()).status, 503);
  assert.deepEqual(publicHttp.calls, []);
});

test('every data route requires a live session and edits require same origin', async t => {
  const { calls, request, login } = await exercise(t);
  for (const path of ['', `/${id}`, `/${id}/images/${imageId}`, '/session']) {
    const response = await request(path);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await login(credentials, { requestOrigin: 'https://other.example' })).status, 403);
  assert.equal((await login({ ...credentials, password: 'incorrect-password' })).status, 401);
  assert.deepEqual(calls, []);

  const response = await login();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-bilimusic-feedback=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
  const cookie = setCookie.split(';', 1)[0];
  assert.equal((await request('/session', { cookie })).status, 200);
  assert.equal((await request('/session', { cookie: `${cookie}1` })).status, 401);
  assert.equal((await request(`/${id}`, { method: 'PATCH', body: {}, cookie, requestOrigin: 'https://other.example' })).status, 403);
  assert.equal((await request('/session', { method: 'DELETE', cookie, requestOrigin: 'https://other.example' })).status, 403);
  assert.deepEqual(calls, []);

  const logout = await request('/session', { method: 'DELETE', cookie });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0; Secure$/);
  assert.equal((await request(`/${id}`, { cookie })).status, 401);
});

test('localhost sessions expire and omit Secure only on local HTTP', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { request, login } = await exercise(t, { origin: 'http://127.0.0.1:3180' });
  const response = await login();
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^bilimusic-feedback-local=.*; HttpOnly; SameSite=Strict; Max-Age=28800$/);
  const cookie = setCookie.split(';', 1)[0];
  assert.equal((await request('/session', { cookie })).status, 200);
  now += 8 * 60 * 60 * 1000 + 1;
  assert.equal((await request('/session', { cookie })).status, 401);
});

test('admin API filters list, permits only editable fields and ties images to their feedback', async t => {
  const { calls, request, login } = await exercise(t);
  const response = await login();
  const cookie = response.headers.get('set-cookie').split(';', 1)[0];
  const result = await request('?status=new&category=bug&q=hello&platform=Android&sort=activity&page=2', { cookie });
  assert.equal(result.status, 200);
  const list = await result.json();
  assert.deepEqual({ items: list.items, total: list.total, page: list.page, pageSize: list.pageSize }, { items: [{ id }], total: 1, page: 2, pageSize: 25 });
  assert.deepEqual(calls.at(-1).args, ['new', 'bug', 'hello', 25, 25, 'Android', null, null]);
  assert.match(calls.at(-1).statement, /ORDER BY activity_at DESC/);
  assert.equal((await request('?status=invalid', { cookie })).status, 400);
  assert.equal((await request('?sort=unknown', { cookie })).status, 400);
  assert.equal((await request('?platform=unknown', { cookie })).status, 400);
  assert.equal((await request('?platform=Linux&q=uid%3A9007199254740993', { cookie })).status, 200);
  assert.deepEqual(calls.at(-1).args, [null, null, null, 25, 0, 'Linux', '9007199254740993', null]);
  assert.match(calls.at(-1).statement, /bilibili_uid = \$7/);
  assert.equal((await request('?q=uid%3A0123', { cookie })).status, 400);
  const emailSearch = { method: 'POST', body: { q: 'email:replies@example.com' } };
  assert.equal((await request('', emailSearch)).status, 401);
  assert.equal((await request('', { ...emailSearch, cookie, requestOrigin: 'https://other.example' })).status, 403);
  assert.equal((await request('', { ...emailSearch, cookie })).status, 200);
  assert.deepEqual(calls.at(-1).args, [null, null, null, 25, 0, null, null, 'replies@example.com']);
  assert.match(calls.at(-1).statement, /lower\(contact_email\) = lower\(\$8\)/);
  assert.equal((await request('', { method: 'POST', body: { q: 'email:replies' }, cookie })).status, 400);
  assert.equal((await request('', { method: 'POST', body: { q: ['invalid'] }, cookie })).status, 400);

  const edit = { category: 'suggestion', status: 'in_progress', title: ' New title ', message: ' New detailed description. ' };
  assert.equal((await request(`/${id}`, { method: 'PATCH', body: { ...edit, contact: 'new contact' }, cookie })).status, 400);
  assert.equal((await request(`/${id}`, { method: 'PATCH', body: { ...edit, contact_email: 'new@example.com' }, cookie })).status, 400);
  assert.equal((await request(`/${id}`, { method: 'PATCH', body: { ...edit, bilibili_uid: '123' }, cookie })).status, 400);
  assert.equal((await request(`/${id}`, { method: 'PATCH', body: edit, cookie })).status, 200);
  assert.deepEqual(calls.at(-1).args, [id, 'suggestion', 'New title', 'New detailed description.', 'in_progress']);
  assert.match(calls.at(-1).statement, /original_message=COALESCE\(f.original_message/);
  assert.match(calls.at(-1).statement, /updated_at=GREATEST\(clock_timestamp\(\),f.updated_at\+interval '1 microsecond'\)/);
  assert.equal((await request('/not-a-uuid', { cookie })).status, 404);

  const image = await request(`/${id}/images/${imageId}`, { cookie });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal(image.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(await image.text(), 'test image');
  assert.deepEqual(calls.at(-1).args, [id, imageId]);
});

test('only same-origin administrators can append internal feedback notes', async t => {
  const calls = [];
  const { request, login } = await exercise(t, { pool: { async query(statement, args) {
    calls.push({ statement, args });
    return { rows: [{ id: args[0], author: args[2], body: args[3], created_at: '2026-11-28T10:00:00.000Z' }] };
  } } });
  const path = `/${id}/notes`;
  const note = { author: '  Yu  ', body: '<b> Reproduced </b>\nNew line' };
  const body = { method: 'POST', body: note };
  assert.equal((await request(path, body)).status, 401);
  const cookie = (await login()).headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await request(path, { ...body, cookie, requestOrigin: 'https://other.example' })).status, 403);
  assert.equal((await request(path, { ...body, cookie, body: { body: '   ' } })).status, 400);
  assert.equal((await request(path, { ...body, cookie, body: { body: 'x'.repeat(2001) } })).status, 400);
  assert.equal((await request(path, { ...body, cookie, body: { ...note, author: 'x'.repeat(33) } })).status, 400);
  assert.deepEqual(calls, []);
  const saved = await request(path, { ...body, cookie });
  assert.equal(saved.status, 201);
  const data = (await saved.json()).note;
  assert.match(data.id, /^[\da-f-]{36}$/);
  assert.deepEqual(calls.at(-1).args.slice(1), [id, 'Yu', note.body]);
  assert.match(calls.at(-1).statement, /^INSERT INTO feedback_admin_notes/);
  const nameless = await request(path, { ...body, cookie, body: { body: '  More information.  ' } });
  assert.deepEqual(calls.at(-1).args.slice(1), [id, 'admin', 'More information.']);
  assert.equal(nameless.status, 201);
});

test('edit preconditions distinguish stale updates and deleted feedback', async t => {
  const calls = [];
  let feedbackExists = true;
  const { request, login } = await exercise(t, { pool: { async query(statement, args) {
    calls.push({ statement, args });
    return { rows: [], rowCount: Number(feedbackExists && statement.startsWith('SELECT 1 ')) };
  } } });
  const cookie = (await login()).headers.get('set-cookie').split(';', 1)[0];
  const expected_updated_at = '2026-11-28T15:20:30.123456Z';
  const body = { category: 'bug', title: 'New title', message: 'Detailed error description.', status: 'resolved', expected_updated_at };
  const edit = { method: 'PATCH', body, cookie };
  assert.equal((await request(`/${id}`, edit)).status, 409);
  assert.match(calls.at(-2).statement, /f.updated_at IS NOT DISTINCT FROM \$6::timestamptz/);
  assert.equal(calls.at(-2).args.at(-1), expected_updated_at);
  feedbackExists = false;
  assert.equal((await request(`/${id}`, edit)).status, 404);
  assert.equal((await request(`/${id}`, { ...edit, body: { ...body, expected_updated_at: '2026-02-30T15:20:30.123456Z' } })).status, 400);
});

test('login is rate limited per address and also across rotating addresses', async t => {
  let timestamp = Date.now();
  t.mock.method(Date, 'now', () => timestamp);
  const { login } = await exercise(t, { clientAddress: req => req.headers['x-test-address'] });
  const incorrect = { ...credentials, password: 'incorrect-password' };
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await login(incorrect, { headers: { 'X-Test-Address': 'first' } })).status, 401);
  }
  const blocked = await login(credentials, { headers: { 'X-Test-Address': 'first' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '900');
  for (let index = 0; index < 54; index += 1) {
    const response = await login(incorrect, { headers: { 'X-Test-Address': `address-${index}` } });
    assert.equal(response.status, 401);
  }
  assert.equal((await login(credentials, { headers: { 'X-Test-Address': 'new-address' } })).status, 429);
  timestamp += 15 * 60 * 1000 + 1;
  assert.equal((await login(credentials, { headers: { 'X-Test-Address': 'first' } })).status, 200);
});

test('password hashes use new random salt and migrations preserve existing rows', async () => {
  const generated = await hashFeedbackAdminPassword(credentials.password);
  assert.match(generated, /^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.notEqual(generated, env.FEEDBACK_ADMIN_PASSWORD_HASH);
  assert.match(await hashFeedbackAdminPassword('Th8!k29+'), /^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{64}$/);
  await assert.rejects(hashFeedbackAdminPassword('short'), /8/);
  await initializeFeedbackAdmin({ async query(sql) {
    assert.match(sql, /^ALTER TABLE feedback/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS original_message/);
    assert.match(sql, /REFERENCES feedback\(id\) ON DELETE CASCADE/);
    assert.doesNotMatch(sql, /\bDROP\b|\bDELETE FROM\b/);
  } });
});

test('PostgreSQL preserves concurrent notes and rejects stale feedback edits', {
  skip: !process.env.FEEDBACK_TEST_DATABASE_URL, timeout: 30_000,
}, async t => {
  const schema = `feedback_admin_test_${randomUUID().replaceAll('-', '')}`;
  const connection = new URL(process.env.FEEDBACK_TEST_DATABASE_URL);
  const database = new pg.Pool({ connectionString: connection.href });
  connection.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: connection.href });
  try {
    await database.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE feedback (
      id uuid PRIMARY KEY,category text NOT NULL,title text NOT NULL,message text NOT NULL,
      platform text NOT NULL,version text NOT NULL,contact text NOT NULL,policy_version text NOT NULL,
      status text NOT NULL,created_at timestamptz NOT NULL
    )`);
    const latestId = randomUUID();
    const windowsId = randomUUID();
    await pool.query(`INSERT INTO feedback(id,category,title,message,platform,version,contact,policy_version,status,created_at)
      VALUES ($1,'bug','Report one','Detailed description one.','Android','','','fixture','new','2025-11-01T12:00:00Z'),
      ($2,'bug','Report two','Detailed description two.','Android','','','fixture','resolved','2025-11-02T12:00:00Z'),
      ($3,'bug','Report three','Detailed description three.','Windows','','','fixture','in_progress','2025-11-03T12:00:00Z')`, [id, latestId, windowsId]);
    await pool.query(`CREATE TABLE feedback_limits (address_hash text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL);
      INSERT INTO feedback_limits VALUES ('legacy-network',now(),2)`);
    await initializeFeedbackSubmissions(pool);
    await initializeFeedbackSubmissions(pool);
    await initializeFeedbackTracking(pool);
    await initializeFeedbackTracking(pool);
    assert.deepEqual((await pool.query('SELECT bilibili_uid, environment, contact_email FROM feedback WHERE id=$1', [id])).rows,
      [{ bilibili_uid: null, environment: null, contact_email: null }]);
    assert.deepEqual((await pool.query("SELECT count, daily_count FROM feedback_limits WHERE address_hash='legacy-network'")).rows,
      [{ count: 2, daily_count: 0 }]);
    await initializeFeedbackAdmin(pool);
    await initializeFeedbackAdmin(pool);
    const { request, login } = await exercise(t, { pool });
    const cookie = (await login()).headers.get('set-cookie').split(';', 1)[0];
    const read = async (path, options = {}, status = 200) => {
      const response = await request(path, { ...options, cookie });
      assert.equal(response.status, status);
      return response.json();
    };
    const { item: initial } = await read(`/${id}`);
    assert.deepEqual(initial.notes, []);
    assert.equal(initial.updated_at, null);
    const oldest = await read('?sort=oldest&platform=Android');
    assert.deepEqual(oldest.items.map(item => item.id), [id, latestId]);
    const counts = await read('?status=new&category=bug&platform=Android&q=report');
    assert.deepEqual(counts.counts, { all: 2, new: 1, in_progress: 0, resolved: 1, closed: 0 });
    assert.equal(counts.total, 1);

    const notesPath = `/${id}/notes`;
    const created = await Promise.all(['已复现', '请补充日志'].map((body, index) => read(notesPath, {
      method: 'POST', body: { body, author: `协作者 ${index + 1}` },
    }, 201)));
    const { item: afterNotes } = await read(`/${id}`);
    assert.deepEqual(new Set(afterNotes.notes.map(note => note.id)), new Set(created.map(result => result.note.id)));
    assert.equal(afterNotes.updated_at, initial.updated_at);
    const active = await read('?sort=activity');
    assert.equal(active.items[0].id, id);
    assert.equal(active.items[0].note_count, 2);
    assert.ok(Date.parse(active.items[0].activity_at) > Date.parse(active.items[0].created_at));
    assert.equal('notes' in active.items[0], false);

    const edit = title => ({ method: 'PATCH', cookie, body: {
      title, category: 'bug', message: 'Detailed description one.', status: 'in_progress', expected_updated_at: initial.updated_at,
    } });
    const saved = await Promise.all(['First title', 'Second title'].map(title => request(`/${id}`, edit(title))));
    assert.deepEqual(saved.map(response => response.status).sort(), [200, 409]);
    const { item: current } = await saved.find(response => response.ok).json();
    assert.match(current.updated_at, /\.\d{6}Z$/);
    const next = edit('Third title');
    next.body.expected_updated_at = current.updated_at;
    const { item: updated } = await read(`/${id}`, next);
    assert.notEqual(updated.updated_at, current.updated_at);
    assert.equal(updated.original_title, 'Report one');
    assert.equal(updated.notes.length, 2);
    await pool.query('DELETE FROM feedback WHERE id=$1', [id]);
    assert.equal((await pool.query('SELECT id FROM feedback_admin_notes WHERE feedback_id=$1', [id])).rowCount, 0);
    await read(notesPath, { method: 'POST', body: { body: '这条反馈已经不存在' } }, 404);
  } finally {
    await pool.end();
    await database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await database.end();
  }
});
