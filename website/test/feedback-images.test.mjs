import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { hashFeedbackAdminPassword } from '../feedback-admin.mjs';
import { readFeedbackSubmission, saveFeedback } from '../feedback-submission.mjs';
import { removeExpiredFeedback } from '../feedback-tracking.mjs';
import { policy } from '../policy.mjs';

const feedback = {
  category: 'bug', platform: 'Android', version: '0.4.6', contact: '',
  title: '歌词高度异常', message: '展开歌词后顶部留白过多，附上复现截图。',
  website: '', consent: true, policyVersion: policy.version,
};

function upload(images, input = feedback) {
  const form = new FormData();
  form.set('feedback', JSON.stringify(input));
  for (const image of images) form.append('images', image, 'screenshot.png');
  return form;
}

async function parse(form) {
  const response = new Response(form);
  const request = Readable.from([Buffer.from(await response.arrayBuffer())]);
  request.headers = { 'content-type': response.headers.get('content-type') };
  return readFeedbackSubmission(request, policy.version);
}

test('feedback upload rejects too many and oversized images before writing', async () => {
  const image = new Blob(['picture'], { type: 'image/png' });
  await assert.rejects(parse(upload(Array(4).fill(image))), { status: 400 });
  const oversized = new Blob([Buffer.alloc(2 * 1024 * 1024 + 1)], { type: 'image/png' });
  await assert.rejects(parse(upload([oversized])), { status: 413 });
});

test('an SVG disguised as a PNG and a corrupt PNG are rejected before starting a transaction', async () => {
  const pool = { connect: () => assert.fail('Should not write rejected feedback') };
  const spoofed = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/png' });
  const corrupt = new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' });
  await assert.rejects(saveFeedback(pool, await parse(upload([spoofed])), policy.version), { status: 415 });
  await assert.rejects(saveFeedback(pool, await parse(upload([corrupt])), policy.version), { status: 400 });
});

test('small compressed files cannot make the server decode oversized or 16-bit images', async () => {
  const pool = { connect: () => assert.fail('Should not write rejected feedback') };
  const pixels = (width, height) => sharp({ create: { width, height, channels: 4, background: '#297787b0' } });
  const wide = await pixels(5000, 3000).png().toBuffer();
  const depth = await pixels(20, 10).toColourspace('rgb16').png().toBuffer();
  for (const image of [wide, depth]) {
    const data = await parse(upload([new Blob([image], { type: 'image/png' })]));
    await assert.rejects(saveFeedback(pool, data, policy.version), { status: 400 });
  }
});

test('app and website feedback share limits, store private details and support moderation on PostgreSQL', {
  skip: !process.env.FEEDBACK_TEST_DATABASE_URL, timeout: 30_000,
}, async () => {
  const schema = `feedback_test_${randomUUID().replaceAll('-', '')}`;
  const connection = new URL(process.env.FEEDBACK_TEST_DATABASE_URL);
  const db = new pg.Pool({ connectionString: connection.href });
  connection.searchParams.set('options', `-c search_path=${schema}`);
  const isolated = new pg.Pool({ connectionString: connection.href });
  let site;
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address();
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const admin = `${origin}/api/v1/admin/feedback`;
    const password = 'fixture-password-for-feedback';
    site = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: {
      ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, HOST: '127.0.0.1', DATABASE_URL: connection.href,
      IP_HASH_SECRET: 'fixture-unique-feedback-test-secret', FEEDBACK_ADMIN_USERNAME: 'fixture-admin',
      FEEDBACK_ADMIN_PASSWORD_HASH: await hashFeedbackAdminPassword(password), TRUST_PROXY: 'true',
    }, stdio: ['ignore', 'ignore', 'inherit'] });
    const waitForSite = async () => {
      for (let attempt = 0; attempt < 100 && site.exitCode === null; attempt += 1) {
        const ready = await fetch(`${origin}/api/v1/health`).catch(() => null);
        if (ready?.ok) return;
        await setTimeout(50);
      }
      assert.fail('Test website did not start');
    };
    await waitForSite();
    const headers = { Origin: origin, 'Content-Type': 'application/json' };
    const jsonHeaders = { 'Content-Type': 'application/json' };
    const webEndpoint = `${origin}/api/v1/feedback`;
    const appEndpoint = `${origin}/api/v1/app/feedback`;
    const submit = (url, input, requestHeaders = jsonHeaders) => fetch(url, {
      method: 'POST', headers: requestHeaders, body: JSON.stringify(input),
    });
    assert.equal((await fetch(appEndpoint)).status, 405);
    assert.equal((await submit(appEndpoint, feedback, headers)).status, 403);
    assert.equal((await submit(webEndpoint, feedback)).status, 403);
    assert.equal((await fetch(`${origin}/api/v1/policy`).then(response => response.json())).version, policy.version);
    const stale = await submit(appEndpoint, { ...feedback, policyVersion: '2026-11-28' });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'feedback_policy_changed');
    const text = await submit(webEndpoint, { ...feedback, contact: 'fixture@example.com' }, headers);
    assert.equal(text.status, 201);
    const { id: websiteId } = await text.json();
    const png = await sharp({ create: { width: 50, height: 25, channels: 3, background: '#297787' } })
      .withExif({ IFD0: { Copyright: 'fixture metadata' } }).png().toBuffer();
    const screenshot = await fetch(webEndpoint, {
      method: 'POST', headers: { Origin: origin }, body: upload([new Blob([png], { type: 'image/png' })]),
    });
    assert.equal(screenshot.status, 201);
    const { id } = await screenshot.json();
    const anonymous = await submit(appEndpoint, { ...feedback, platform: 'Linux' });
    assert.equal(anonymous.status, 201);
    const { id: anonymousId } = await anonymous.json();
    const uid = '9007199254740993';
    const email = 'Reply+Audio@Example.com';
    const environment = { system: 'Android 10', webview: 'Android WebView 66.0.3359.158', largeScreen: true, apiLevel: 29 };
    const appScreenshot = await fetch(appEndpoint, {
      method: 'POST', body: upload([new Blob([png], { type: 'image/png' })], {
        ...feedback, platform: 'Android Large Screen', email, contact: 'QQ 12345', shareBilibiliUid: true, bilibiliUid: uid, environment,
      }),
    });
    assert.equal(appScreenshot.status, 201);
    const appReceipt = await appScreenshot.json();
    assert.deepEqual(Object.keys(appReceipt).sort(), ['id', 'message']);
    const appId = appReceipt.id;
    assert.equal((await submit(appEndpoint, { ...feedback, shareBilibiliUid: true, bilibiliUid: `${uid}1` })).status, 201);
    const limited = await submit(webEndpoint, feedback, headers);
    assert.equal(limited.status, 429);
    const hourlyRetry = Number(limited.headers.get('retry-after'));
    assert.ok(hourlyRetry > 0 && hourlyRetry <= 3600);
    assert.equal((await limited.json()).code, 'feedback_rate_limited');
    const rollHour = () => isolated.query("UPDATE feedback_limits SET window_start=clock_timestamp()-interval '2 hours'");
    await rollHour();
    for (let index = 0; index < 5; index += 1) assert.equal((await submit(appEndpoint, feedback)).status, 201);
    await rollHour();
    for (let index = 0; index < 2; index += 1) assert.equal((await submit(webEndpoint, feedback, headers)).status, 201);
    const dailyLimited = await submit(appEndpoint, feedback);
    assert.equal(dailyLimited.status, 429);
    const dailyRetry = Number(dailyLimited.headers.get('retry-after'));
    assert.ok(dailyRetry > 3600 && dailyRetry <= 86400);
    assert.match((await dailyLimited.json()).message, /24 小时/);
    await isolated.query("UPDATE feedback_limits SET daily_window_start=clock_timestamp()-interval '25 hours'");
    assert.equal((await submit(appEndpoint, feedback)).status, 201);

    const attemptIP = '192.0.2.78';
    for (let hour = 0; hour < 3; hour += 1) {
      if (hour) await rollHour();
      for (let index = 0; index < (hour === 2 ? 4 : 10); index += 1) {
        const invalid = await submit(appEndpoint, { ...feedback, title: '' }, { ...jsonHeaders, 'X-Forwarded-For': attemptIP });
        assert.equal(invalid.status, 400);
      }
      if (hour === 0 || hour === 2) {
        const client = createConnection({ port, host: '127.0.0.1' });
        client.setTimeout(2000, () => client.destroy(new Error('Server waited for a rate-limited upload body')));
        await once(client, 'connect');
        client.write([
          'POST /api/v1/app/feedback HTTP/1.1', `Host: 127.0.0.1:${port}`, `X-Forwarded-For: ${attemptIP}`,
          'Content-Type: multipart/form-data; boundary=limited', 'Content-Length: 1048576', '', '',
        ].join('\r\n'));
        const chunks = [];
        for await (const chunk of client) chunks.push(chunk);
        const response = Buffer.concat(chunks).toString();
        assert.match(response, /^HTTP\/1\.1 429/);
        assert.match(response, /connection: close/i);
        assert.match(response, /retry-after: \d+/i);
        if (hour === 2) assert.match(response, /24 小时/);
      }
    }
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => submit(appEndpoint, feedback, {
      ...jsonHeaders, 'X-Forwarded-For': '192.0.2.79',
    })));
    assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 201, 201, 201, 201, 429, 429, 429]);

    const trackingKey = randomBytes(32).toString('base64url');
    const trackingKeyHash = createHash('sha256').update(trackingKey).digest('hex');
    const trackable = { ...feedback, anonymous: false, shareBilibiliUid: true, bilibiliUid: uid, trackingKeyHash };
    const trackedHeaders = { ...jsonHeaders, 'X-Forwarded-For': '192.0.2.80' };
    const trackedReceipts = await Promise.all(Array.from({ length: 3 }, async () => {
      const response = await submit(appEndpoint, trackable, trackedHeaders);
      assert.equal(response.status, 201);
      return response.json();
    }));
    const trackedId = trackedReceipts[0].id;
    assert.ok(trackedReceipts.every(receipt => receipt.id === trackedId));
    assert.equal((await submit(appEndpoint, { ...trackable, bilibiliUid: '123' }, trackedHeaders)).status, 400);
    const explicitAnonymous = await submit(appEndpoint, { ...feedback, anonymous: true }, trackedHeaders);
    assert.equal(explicitAnonymous.status, 201);
    const explicitAnonymousId = (await explicitAnonymous.json()).id;
    for (let index = 0; index < 3; index += 1) assert.equal((await submit(appEndpoint, feedback, trackedHeaders)).status, 201);
    const replayAtQuota = await submit(appEndpoint, trackable, trackedHeaders);
    assert.equal(replayAtQuota.status, 201);
    assert.equal((await replayAtQuota.json()).id, trackedId);
    assert.equal((await submit(appEndpoint, feedback, trackedHeaders)).status, 429);
    assert.deepEqual((await isolated.query('SELECT id,anonymous FROM feedback WHERE tracking_key_hash=$1', [trackingKeyHash])).rows,
      [{ id: trackedId, anonymous: false }]);

    const lookup = (key, requestHeaders = jsonHeaders) => submit(`${appEndpoint}/status`, { trackingKey: key }, requestHeaders);
    assert.equal((await fetch(`${appEndpoint}/status`)).status, 405);
    assert.equal((await lookup(trackingKey, headers)).status, 403);
    assert.equal((await lookup(trackedId)).status, 400);
    const unknown = await lookup(randomBytes(32).toString('base64url'));
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, 'feedback_not_found');
    const trackingResponse = await lookup(trackingKey);
    assert.equal(trackingResponse.status, 200);
    assert.equal(trackingResponse.headers.get('cache-control'), 'no-store');
    const tracking = await trackingResponse.json();
    assert.deepEqual(Object.keys(tracking).sort(), ['createdAt', 'id', 'replies', 'status']);
    assert.equal(tracking.id, trackedId);
    assert.equal(tracking.status, 'new');
    assert.deepEqual(tracking.replies, []);
    assert.equal((await fetch(admin)).status, 401);
    assert.equal((await fetch(`${admin}/${appId}`)).status, 401);
    const login = await fetch(`${admin}/session`, { method: 'POST', headers, body: JSON.stringify({ username: 'fixture-admin', password }) });
    assert.equal(login.status, 200);
    const Cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const auth = { ...headers, Cookie };
    const callAdmin = (path, method, body) => fetch(admin + path, { method, headers: auth, body: JSON.stringify(body) });
    const trackedPath = '/' + trackedId;
    assert.equal((await callAdmin(`/${explicitAnonymousId}/replies`, 'POST', { body: '无法发送到匿名回执' })).status, 400);
    assert.equal((await callAdmin(`${trackedPath}/notes`, 'POST', { body: '仅供同事排查', author: '管理员' })).status, 201);
    assert.equal((await callAdmin(`${trackedPath}/replies`, 'POST', { body: '我们已收到这条反馈。' })).status, 201);
    const closingEdit = { category: feedback.category, title: feedback.title, message: feedback.message, status: 'closed', expected_updated_at: null };
    const missingReason = await callAdmin(trackedPath, 'PATCH', closingEdit);
    assert.equal(missingReason.status, 400);
    assert.equal((await missingReason.json()).code, 'feedback_close_reply_required');
    assert.equal((await callAdmin(trackedPath, 'PATCH', { ...closingEdit, reply: '关闭原因', expected_updated_at: '2026-11-28T13:00:00.000Z' })).status, 409);
    const beforeClosing = await lookup(trackingKey).then(response => response.json());
    assert.equal(beforeClosing.status, 'new');
    assert.deepEqual(beforeClosing.replies.map(reply => reply.body), ['我们已收到这条反馈。']);
    const closeResponse = await callAdmin(trackedPath, 'PATCH', { ...closingEdit, reply: '与已有反馈重复，进度会在原反馈处理。' });
    assert.equal(closeResponse.status, 200);
    const closed = (await closeResponse.json()).item;
    assert.equal(closed.tracked, true);
    assert.equal(closed.notes.length, 1);
    assert.equal(closed.replies.length, 2);
    const trackedClosed = await lookup(trackingKey).then(response => response.json());
    assert.deepEqual(Object.keys(trackedClosed).sort(), ['createdAt', 'id', 'replies', 'status', 'statusChangedAt']);
    assert.equal(trackedClosed.status, 'closed');
    assert.ok(trackedClosed.statusChangedAt);
    assert.deepEqual(trackedClosed.replies.map(reply => Object.keys(reply).sort()), [['body', 'createdAt', 'id'], ['body', 'createdAt', 'id']]);
    assert.deepEqual(trackedClosed.replies.map(reply => reply.body), ['我们已收到这条反馈。', '与已有反馈重复，进度会在原反馈处理。']);
    const closedFilter = await fetch(`${admin}?status=closed`, { headers: auth }).then(response => response.json());
    assert.deepEqual(closedFilter.items.map(entry => entry.id), [trackedId]);
    const editedClosed = (await (await callAdmin(trackedPath, 'PATCH', {
      ...closingEdit, title: '更新后的反馈标题', expected_updated_at: closed.updated_at,
    })).json()).item;
    assert.equal(editedClosed.status_changed_at, closed.status_changed_at);
    const reopened = await callAdmin(trackedPath, 'PATCH', {
      ...closingEdit, status: 'in_progress', expected_updated_at: editedClosed.updated_at,
    });
    assert.equal(reopened.status, 200);
    const trackedReopened = await lookup(trackingKey).then(response => response.json());
    assert.equal(trackedReopened.status, 'in_progress');
    assert.equal(Object.hasOwn(trackedReopened, 'completedAt'), false);
    assert.equal(trackedReopened.replies.length, 2);
    const reopenedItem = (await reopened.json()).item;
    const resolveResponse = await callAdmin(trackedPath, 'PATCH', {
      ...closingEdit, status: 'resolved', expected_updated_at: reopenedItem.updated_at,
    });
    assert.equal(resolveResponse.status, 200);
    const trackedResolved = await lookup(trackingKey).then(response => response.json());
    assert.equal(trackedResolved.status, 'resolved');
    assert.equal(trackedResolved.completedAt, trackedResolved.statusChangedAt);
    await isolated.query("UPDATE feedback_lookup_limits SET count=120");
    const lookupLimited = await lookup(trackingKey);
    assert.equal(lookupLimited.status, 429);
    assert.ok(Number(lookupLimited.headers.get('retry-after')) > 0);
    await isolated.query("UPDATE feedback_lookup_limits SET window_start=clock_timestamp()-interval '2 hours'");
    assert.equal((await lookup(trackingKey)).status, 200);
    const accountSearch = await fetch(`${admin}?q=uid%3A${uid}`, { headers: auth }).then(response => response.json());
    assert.deepEqual(new Set(accountSearch.items.map(entry => entry.id)), new Set([appId, trackedId]));
    const emailSearch = async address => fetch(admin, {
      method: 'POST', headers: auth, body: JSON.stringify({ q: address }),
    }).then(response => response.json());
    const matches = await emailSearch(`email:${email.toLowerCase()}`);
    assert.deepEqual(matches.items.map(entry => entry.id), [appId]);
    assert.equal(Object.hasOwn(matches.items[0], 'contact_email'), false);
    assert.deepEqual((await emailSearch('fixture@example.com')).items.map(entry => entry.id), [websiteId]);
    const appItem = (await fetch(`${admin}/${appId}`, { headers: auth }).then(response => response.json())).item;
    assert.equal(appItem.bilibili_uid, uid);
    assert.equal(appItem.contact_email, email);
    assert.equal(appItem.contact, 'QQ 12345');
    assert.deepEqual(appItem.environment, environment);
    assert.equal(appItem.images.length, 1);
    const oldItem = (await fetch(`${admin}/${websiteId}`, { headers: auth }).then(response => response.json())).item;
    assert.equal(oldItem.contact, 'fixture@example.com');
    assert.equal(oldItem.contact_email, null);
    assert.equal(oldItem.bilibili_uid, null);
    const anonymousItem = (await fetch(`${admin}/${anonymousId}`, { headers: auth }).then(response => response.json())).item;
    assert.equal(anonymousItem.bilibili_uid, null);
    assert.equal(anonymousItem.environment, null);
    const filter = await fetch(`${admin}?q=${id}&category=bug&status=new`, { headers: auth });
    const { items, total } = await filter.json();
    assert.equal(total, 1);
    assert.equal(items[0].image_count, 1);
    const detail = await fetch(`${admin}/${id}`, { headers: auth });
    const { item } = await detail.json();
    const imageUrl = `${admin}/${id}/images/${item.images[0].id}`;
    assert.equal((await fetch(imageUrl)).status, 401);
    const image = await fetch(imageUrl, { headers: auth });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/webp');
    assert.equal(image.headers.get('cache-control'), 'no-store');
    const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
    assert.equal(metadata.exif, undefined);
    assert.equal(metadata.width, 50);
    const newMessage = '已经复现，后续会检查歌词页的顶部安全区。';
    const patch = await fetch(`${admin}/${id}`, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify({ title: feedback.title, message: newMessage, status: 'in_progress', category: 'other' }),
    });
    assert.equal(patch.status, 200);
    const updated = (await patch.json()).item;
    assert.equal(updated.message, newMessage);
    assert.equal(updated.original_message, feedback.message);
    assert.equal(updated.original_category, 'bug');
    await isolated.query('DELETE FROM feedback WHERE id=$1', [id]);
    assert.equal((await isolated.query('SELECT id FROM feedback_images WHERE feedback_id=$1', [id])).rowCount, 0);
    assert.equal((await fetch(imageUrl, { headers: auth })).status, 404);
    await isolated.query("UPDATE feedback SET created_at=clock_timestamp()-interval '181 days' WHERE id=$1", [trackedId]);
    await removeExpiredFeedback(isolated);
    assert.equal((await lookup(trackingKey)).status, 200);
    await isolated.query(`UPDATE feedback SET status_changed_at=clock_timestamp()-interval '181 days'
      WHERE id=$1`, [trackedId]);
    await removeExpiredFeedback(isolated);
    assert.equal((await lookup(trackingKey)).status, 200);
    await isolated.query(`UPDATE feedback SET last_user_reply_at=clock_timestamp()-interval '181 days'
      WHERE id=$1`, [trackedId]);
    await removeExpiredFeedback(isolated);
    assert.equal((await lookup(trackingKey)).status, 404);
    assert.equal((await isolated.query('SELECT id FROM feedback_user_replies WHERE feedback_id=$1', [trackedId])).rowCount, 0);
    assert.equal((await isolated.query('SELECT id FROM feedback_admin_notes WHERE feedback_id=$1', [trackedId])).rowCount, 0);
    assert.equal((await fetch(`${admin}/session`, { method: 'DELETE', headers: auth })).status, 204);
    assert.equal((await fetch(admin, { headers: auth })).status, 401);
  } finally {
    if (site?.exitCode === null) {
      const stopped = once(site, 'exit');
      site.kill('SIGTERM');
      await stopped;
    }
    await isolated.end();
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.end();
  }
});
