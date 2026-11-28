import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { feedbackCategories, feedbackPlatforms, HttpError, isBilibiliUid, isFeedbackEmail } from './validation.mjs';
import { feedbackStatuses as statuses, feedbackStatusTimestamp } from './feedback-tracking.mjs';

const deriveKey = promisify(scrypt);
const scryptOptions = { N: 2 ** 14, r: 8, p: 5 };
const prefix = '/api/admin/feedback';
const hashFormat = /^scrypt-v1:([0-9a-f]{32}):([0-9a-f]{64})$/;
const uuidFormat = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sessionFormat = /^[A-Za-z0-9_-]{43}$/;
const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
const listOrders = new Map([
  ['newest', 'created_at DESC,id DESC'],
  ['oldest', 'created_at ASC,id ASC'],
  ['activity', 'activity_at DESC,created_at DESC,id DESC'],
]);
const pageSize = 25;
const sessionSeconds = 8 * 60 * 60;
const loginWindowMs = 15 * 60 * 1000;
const utcTimestamp = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

export async function hashFeedbackAdminPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 1024) {
    throw new Error('管理员密码至少需要 8 个字符，且不能超过 1024 字节。');
  }
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 32, scryptOptions);
  return `scrypt-v1:${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function initializeFeedbackAdmin(pool) {
  await pool.query(`ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS original_category text,
    ADD COLUMN IF NOT EXISTS original_title text,
    ADD COLUMN IF NOT EXISTS original_message text,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz;
    CREATE TABLE IF NOT EXISTS feedback_admin_notes (
      id uuid PRIMARY KEY, feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
      author text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS feedback_admin_notes_feedback_idx ON feedback_admin_notes(feedback_id,created_at,id);`);
}

const digest = value => createHash('sha256').update(value).digest();

async function readJson(req, limit) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, '请提交 JSON 格式。');
  }
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, '请求过长。');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      req.resume();
      throw new HttpError(413, '请求过长。');
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求格式不正确。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求格式不正确。');
  return body;
}

function validateEdit(body) {
  const { category, status, expected_updated_at: expectedUpdatedAt } = body;
  if (!feedbackCategories.includes(category)) throw new HttpError(400, '请选择反馈分类。');
  if (!statuses.includes(status)) throw new HttpError(400, '请选择处理状态。');
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (title.length < 3 || title.length > 120 || message.length < 10 || message.length > 5000 ||
      title.includes('\0') || message.includes('\0')) {
    throw new HttpError(400, '请检查标题和描述的长度。');
  }
  if (Object.keys(body).some(key => !['category', 'status', 'title', 'message', 'expected_updated_at', 'reply'].includes(key))) {
    throw new HttpError(400, '存在无法修改的反馈字段。');
  }
  if (expectedUpdatedAt != null) {
    if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt.startsWith('0000-') ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(expectedUpdatedAt)) {
      throw new HttpError(400, '反馈版本不正确，请刷新后重试。');
    }
    const time = new Date(expectedUpdatedAt);
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== expectedUpdatedAt.slice(0, 23) + 'Z') {
      throw new HttpError(400, '反馈版本不正确，请刷新后重试。');
    }
  }
  const reply = body.reply === undefined ? null : validateReply(body.reply);
  return { category, title, message, status, expectedUpdatedAt, reply };
}

function validateReply(value) {
  const body = typeof value === 'string' ? value.trim() : '';
  if (!body || body.length > 2000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(body)) {
    throw new HttpError(400, '请填写 2000 字以内的回复。');
  }
  return body;
}

async function listFeedback(pool, params) {
  const status = params.get('status') || null;
  const category = params.get('category') || null;
  const platform = params.get('platform') || null;
  const query = params.get('q')?.trim() || null;
  const uid = /^uid:\s*(.*)$/i.exec(query ?? '')?.[1] ?? null;
  const email = /^email:\s*(.*)$/i.exec(query ?? '')?.[1] ?? (isFeedbackEmail(query) ? query : null);
  const search = uid === null && email === null ? query : null;
  const page = Number(params.get('page') ?? '1');
  const order = listOrders.get(params.get('sort') ?? 'newest');
  if (status && !statuses.includes(status) || category && !feedbackCategories.includes(category) ||
      platform && !feedbackPlatforms.includes(platform) || !order ||
      search && (search.length > 120 || search.includes('\0')) ||
      uid !== null && !isBilibiliUid(uid) ||
      email !== null && !isFeedbackEmail(email) ||
      !Number.isInteger(page) || page < 1 || page > 100000) {
    throw new HttpError(400, '筛选条件不正确。');
  }
  const { rows: [result] } = await pool.query(`WITH filtered AS (
    SELECT id,category,title,platform,version,status,created_at,updated_at,last_user_reply_at FROM feedback
    WHERE ($2::text IS NULL OR category = $2) AND ($6::text IS NULL OR platform = $6)
    AND ($7::text IS NULL OR bilibili_uid = $7)
    AND ($8::text IS NULL OR lower(contact_email) = lower($8) OR lower(contact) = lower($8))
    AND ($3::text IS NULL OR id::text = lower($3) OR bilibili_uid = $3
      OR strpos(lower(title), lower($3)) > 0 OR strpos(lower(message), lower($3)) > 0)
  ), page AS (
    SELECT f.*, GREATEST(f.created_at,f.updated_at,f.last_user_reply_at,(SELECT note.created_at FROM feedback_admin_notes note
      WHERE note.feedback_id=f.id ORDER BY note.created_at DESC,note.id DESC LIMIT 1)) AS activity_at
    FROM filtered f WHERE $1::text IS NULL OR f.status = $1
    ORDER BY ${order} LIMIT $4 OFFSET $5
  ), visible AS (
    SELECT page.*, (SELECT count(*)::integer FROM feedback_images img WHERE img.feedback_id=page.id) AS image_count,
      (SELECT count(*)::integer FROM feedback_admin_notes note WHERE note.feedback_id=page.id) AS note_count FROM page
  ), totals AS (
    SELECT count(*) FILTER (WHERE $1::text IS NULL OR status = $1)::integer AS total,
      jsonb_build_object('all',count(*)::integer,'new',count(*) FILTER (WHERE status='new')::integer,
        'in_progress',count(*) FILTER (WHERE status='in_progress')::integer,
        'resolved',count(*) FILTER (WHERE status='resolved')::integer,
        'closed',count(*) FILTER (WHERE status='closed')::integer) AS counts FROM filtered
  ) SELECT totals.total,totals.counts,
    (SELECT COALESCE(jsonb_agg(visible ORDER BY ${order}),'[]'::jsonb) FROM visible) AS items FROM totals`,
  [status, category, search, pageSize, (page - 1) * pageSize, platform, uid, email]);
  return { ...result, page, pageSize };
}

const detailFields = `f.id,f.category,f.title,f.message,f.platform,f.version,f.contact,f.contact_email,f.policy_version,
  f.status,f.status_changed_at,f.bilibili_uid,f.environment,f.anonymous,
  (f.tracking_key_hash IS NOT NULL AND f.anonymous=false) AS tracked,
  f.created_at,to_char(f.updated_at AT TIME ZONE 'UTC','${utcTimestamp}') AS updated_at,
  f.original_category,f.original_title,f.original_message,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',img.id,'mime_type',img.mime_type,'byte_size',img.byte_size)
    ORDER BY img.position,img.id) FROM feedback_images img WHERE img.feedback_id=f.id),'[]'::jsonb) AS images,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',note.id,'author',note.author,'body',note.body,
    'created_at',to_char(note.created_at AT TIME ZONE 'UTC','${utcTimestamp}'))
    ORDER BY note.created_at,note.id) FROM feedback_admin_notes note WHERE note.feedback_id=f.id),'[]'::jsonb) AS notes,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',reply.id,'body',reply.body,
    'created_at',to_char(reply.created_at AT TIME ZONE 'UTC','${utcTimestamp}'))
    ORDER BY reply.created_at,reply.id) FROM feedback_user_replies reply WHERE reply.feedback_id=f.id),'[]'::jsonb) AS replies`;

async function getFeedbackRecord(pool, id, edit) {
  const compareVersion = edit && edit.expectedUpdatedAt !== undefined;
  const condition = compareVersion ? ' AND f.updated_at IS NOT DISTINCT FROM $6::timestamptz' : '';
  const closingWithoutReply = edit?.status === 'closed' && !edit.reply;
  const requireReply = closingWithoutReply ? " AND (f.tracking_key_hash IS NULL OR f.status='closed')" : '';
  const query = edit ? `WITH edited AS (UPDATE feedback f SET
    original_category=COALESCE(f.original_category, CASE WHEN f.category IS DISTINCT FROM $2 THEN f.category END),
    original_title=COALESCE(f.original_title, CASE WHEN f.title IS DISTINCT FROM $3 THEN f.title END),
    original_message=COALESCE(f.original_message, CASE WHEN f.message IS DISTINCT FROM $4 THEN f.message END),
    category=$2,title=$3,message=$4,status=$5,
    status_changed_at=${feedbackStatusTimestamp('f.status', '$5', 'f.status_changed_at')},
    updated_at=GREATEST(clock_timestamp(),f.updated_at+interval '1 microsecond') WHERE f.id=$1${condition}${requireReply} RETURNING f.*)
    SELECT ${detailFields} FROM edited f` : `SELECT ${detailFields} FROM feedback f WHERE f.id=$1`;
  const args = edit ? [id, edit.category, edit.title, edit.message, edit.status] : [id];
  if (compareVersion) args.push(edit.expectedUpdatedAt);
  const { rows: [item] } = await pool.query(query, args);
  if (item) return item;
  if (edit) {
    const current = await pool.query(`SELECT 1 AS present,status,(tracking_key_hash IS NOT NULL) AS tracked,
      to_char(updated_at AT TIME ZONE 'UTC','${utcTimestamp}') AS updated_at FROM feedback WHERE id=$1`, [id]);
    if (current.rowCount) {
      const actual = current.rows[0];
      const expected = edit.expectedUpdatedAt?.replace(/\.(\d{3})Z$/, (_, ms) => `.${ms}000Z`) ?? null;
      if (closingWithoutReply && actual?.tracked && actual.status !== 'closed' &&
          (!compareVersion || actual.updated_at === expected)) {
        throw new HttpError(400, '关闭这条反馈时，请填写反馈人可见的原因。', 'feedback_close_reply_required');
      }
      throw new HttpError(409, '这条反馈已被其他管理员修改，请重新加载后再保存。');
    }
  }
  throw new HttpError(404, '没有找到这条反馈。');
}

async function appendReply(db, feedbackId, body) {
  const { rows: [reply] } = await db.query(`WITH tracked AS (
    UPDATE feedback SET last_user_reply_at=GREATEST(clock_timestamp(),last_user_reply_at+interval '1 microsecond')
    WHERE id=$2 AND tracking_key_hash IS NOT NULL AND anonymous=false RETURNING id,last_user_reply_at
  ) INSERT INTO feedback_user_replies(id,feedback_id,body,created_at)
    SELECT $1,id,$3,last_user_reply_at FROM tracked
    RETURNING id,body,to_char(created_at AT TIME ZONE 'UTC','${utcTimestamp}') AS created_at`,
  [randomUUID(), feedbackId, body]);
  if (reply) return reply;
  if ((await db.query('SELECT 1 FROM feedback WHERE id=$1', [feedbackId])).rowCount) {
    throw new HttpError(400, '这条反馈无法在应用内接收回复。');
  }
  throw new HttpError(404, '没有找到这条反馈。');
}

async function getFeedback(pool, id, edit) {
  if (!edit?.reply) return getFeedbackRecord(pool, id, edit);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await getFeedbackRecord(client, id, edit);
    const reply = await appendReply(client, id, edit.reply);
    await client.query('COMMIT');
    return { ...item, replies: [...item.replies, reply] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function appendNote(pool, feedbackId, input, username) {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > 2000 || body.includes('\0')) throw new HttpError(400, '请填写 2000 字以内的备注。');
  const name = input.author === undefined ? '' : input.author;
  if (typeof name !== 'string' || name.trim().length > 32 || name.includes('\0')) {
    throw new HttpError(400, '请填写 32 字以内的署名。');
  }
  const { rows: [note] } = await pool.query(`INSERT INTO feedback_admin_notes(id,feedback_id,author,body)
    SELECT $1,id,$3,$4 FROM feedback WHERE id=$2 FOR KEY SHARE
    RETURNING id,author,body,to_char(created_at AT TIME ZONE 'UTC','${utcTimestamp}') AS created_at`,
  [randomUUID(), feedbackId, name.trim() || username, body]);
  if (!note) throw new HttpError(404, '没有找到这条反馈。');
  return note;
}

function sendSessionCookie(res, cookie, secure, token = '') {
  const seconds = token ? sessionSeconds : 0;
  res.setHeader('Set-Cookie', `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`);
}

function sessionKey(req, cookie) {
  const prefix = `${cookie}=`;
  const token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
  return sessionFormat.test(token || '') ? digest(token).toString('hex') : null;
}

export function createFeedbackAdmin({ pool, origin, env = process.env, clientAddress = req => req.socket.remoteAddress }) {
  const site = new URL(origin);
  const secure = site.protocol === 'https:';
  const local = site.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
  const username = env.FEEDBACK_ADMIN_USERNAME?.trim() ?? '';
  const passwordHash = hashFormat.exec(env.FEEDBACK_ADMIN_PASSWORD_HASH ?? '');
  const enabled = Boolean(pool && (secure || local) && username.length > 0 && username.length <= 80 && passwordHash);
  const usernameHash = digest(username);
  const salt = passwordHash && Buffer.from(passwordHash[1], 'hex');
  const expectedKey = passwordHash && Buffer.from(passwordHash[2], 'hex');
  const cookie = secure ? '__Host-bilimusic-feedback' : 'bilimusic-feedback-local';
  const sessions = new Map();
  const addressKey = randomBytes(32);
  let addressAttempts = new Map();
  let windowEnd = 0;
  let attempts = 0;
  let checkingPassword = false;

  async function login(req, res, body) {
    const { username: provided, password } = body;
    if (typeof provided !== 'string' || provided.length > 80 || typeof password !== 'string' ||
        Buffer.byteLength(password) > 1024) {
      throw new HttpError(400, '请输入管理员账号和密码。');
    }
    const now = Date.now();
    const address = createHmac('sha256', addressKey).update(clientAddress(req) || 'unavailable').digest('hex');
    if (now >= windowEnd) {
      windowEnd = now + loginWindowMs;
      attempts = 0;
      addressAttempts = new Map();
    }
    const addressCount = addressAttempts.get(address) || 0;
    if (attempts >= 60 || addressCount >= 6 || checkingPassword) {
      res.setHeader('Retry-After', checkingPassword ? '1' : String(Math.max(1, Math.ceil((windowEnd - now) / 1000))));
      throw new HttpError(429, '登录尝试过于频繁，请稍后再试。');
    }
    attempts += 1;
    addressAttempts.set(address, addressCount + 1);
    checkingPassword = true;
    try {
      const candidate = await deriveKey(password, salt, 32, scryptOptions);
      const accountMatches = timingSafeEqual(digest(provided.trim()), usernameHash);
      if (!timingSafeEqual(candidate, expectedKey) || !accountMatches) throw new HttpError(401, '账号或密码不正确。');
    } finally {
      checkingPassword = false;
    }
    sessions.delete(sessionKey(req, cookie));
    for (const [key, expires] of sessions) {
      if (expires <= now) sessions.delete(key);
    }
    if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token).toString('hex'), now + sessionSeconds * 1000);
    sendSessionCookie(res, cookie, secure, token);
  }

  return async function handleFeedbackAdmin(req, res, path, json) {
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return false;
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) throw new HttpError(503, '反馈管理暂不可用。');
    if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin !== site.origin) {
      throw new HttpError(403, '请通过本站反馈管理页面操作。');
    }
    const sessionPath = `${prefix}/session`;
    const key = sessionKey(req, cookie);
    if (path === sessionPath && req.method === 'POST') {
      await login(req, res, await readJson(req, 8192));
      json(200, { authenticated: true });
      return true;
    }
    if (path === sessionPath && req.method === 'DELETE') {
      sessions.delete(key);
      sendSessionCookie(res, cookie, secure);
      res.writeHead(204);
      res.end();
      return true;
    }
    if (!(sessions.get(key) > Date.now())) {
      sessions.delete(key);
      throw new HttpError(401, '请先登录。');
    }
    if (path === sessionPath) {
      if (req.method !== 'GET') throw new HttpError(405, '不支持此操作。');
      json(200, { authenticated: true });
      return true;
    }
    if (path === prefix) {
      let params = new URL(req.url, site).searchParams;
      if (req.method === 'POST') {
        const body = await readJson(req, 4096);
        if (Object.values(body).some(value => typeof value !== 'string')) {
          throw new HttpError(400, '筛选条件不正确。');
        }
        params = new URLSearchParams(body);
      } else if (req.method !== 'GET') {
        throw new HttpError(405, '不支持此操作。');
      }
      json(200, await listFeedback(pool, params));
      return true;
    }
    const [id, resource, imageId, ...extra] = path.slice(prefix.length + 1).split('/');
    if (!uuidFormat.test(id) || extra.length) {
      throw new HttpError(404, '没有找到这条反馈。');
    }
    if (resource === 'notes' && imageId === undefined) {
      if (req.method !== 'POST') throw new HttpError(405, '不支持此操作。');
      const note = await appendNote(pool, id, await readJson(req, 14_000), username);
      json(201, { note });
      return true;
    }
    if (resource === 'replies' && imageId === undefined) {
      if (req.method !== 'POST') throw new HttpError(405, '不支持此操作。');
      const input = await readJson(req, 14_000);
      json(201, { reply: await appendReply(pool, id, validateReply(input.body)) });
      return true;
    }
    if (resource === 'images' && uuidFormat.test(imageId || '')) {
      if (req.method !== 'GET') throw new HttpError(405, '不支持此操作。');
      const { rows: [image] } = await pool.query('SELECT mime_type,data FROM feedback_images WHERE feedback_id=$1 AND id=$2', [id, imageId]);
      if (!image || !imageTypes.includes(image.mime_type)) throw new HttpError(404, '没有找到这张图片。');
      res.writeHead(200, {
        'Content-Type': image.mime_type,
        'Content-Length': image.data.length,
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(image.data);
      return true;
    }
    if (resource !== undefined) throw new HttpError(404, '没有找到这条反馈。');
    if (req.method !== 'GET' && req.method !== 'PATCH') throw new HttpError(405, '不支持此操作。');
    const edit = req.method === 'PATCH' ? validateEdit(await readJson(req, 36_000)) : null;
    json(200, { item: await getFeedback(pool, id, edit) });
    return true;
  };
}
