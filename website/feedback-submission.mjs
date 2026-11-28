import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { HttpError, validateFeedback } from './validation.mjs';

const MAX_TEXT_BYTES = 24_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 10_000_000;
const MAX_IMAGES = 3;
const MAX_UPLOAD_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + MAX_TEXT_BYTES + 8192;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const HOURLY_FEEDBACK_LIMIT = 5;
const DAILY_FEEDBACK_LIMIT = 12;
const HOURLY_ATTEMPT_LIMIT = 10;
const DAILY_ATTEMPT_LIMIT = 24;
const hourExpired = "limits.window_start <= EXCLUDED.window_start - interval '1 hour'";
const dayExpired = "limits.daily_window_start IS NULL OR limits.daily_window_start <= EXCLUDED.daily_window_start - interval '24 hours'";

// Keep the private image encoder within the website container's memory budget.
sharp.cache(false);
sharp.concurrency(1);
let imageWork = Promise.resolve();

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, '反馈内容或图片过大。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '反馈内容或图片过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function parseFeedback(text, policyVersion, options) {
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new HttpError(413, '反馈内容过长。');
  let body;
  try { body = JSON.parse(text); }
  catch { throw new HttpError(400, '反馈格式不正确。'); }
  return validateFeedback(body, policyVersion, options);
}

export async function readFeedbackLookup(req) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, '请提交 JSON 格式。');
  }
  const body = await readBody(req, 512);
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new HttpError(400, '反馈查询格式不正确。'); }
}

export async function readFeedbackSubmission(req, policyVersion, options) {
  const type = req.headers['content-type'] || '';
  const mediaType = type.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json') {
    const body = await readBody(req, MAX_TEXT_BYTES);
    return { feedback: parseFeedback(body.toString('utf8'), policyVersion, options), images: [] };
  }
  if (mediaType !== 'multipart/form-data') throw new HttpError(415, '请通过本站反馈表单提交。');

  const body = await readBody(req, MAX_UPLOAD_BYTES);
  let form;
  try { form = await new Response(body, { headers: { 'Content-Type': type } }).formData(); }
  catch { throw new HttpError(400, '无法读取反馈附件，请重新选择图片。'); }

  const [input, duplicate] = form.getAll('feedback');
  if (typeof input !== 'string' || duplicate !== undefined || [...form.keys()].some(key => key !== 'feedback' && key !== 'images')) {
    throw new HttpError(400, '反馈格式不正确。');
  }
  const feedback = parseFeedback(input, policyVersion, options);
  const images = form.getAll('images');
  if (images.length > MAX_IMAGES) throw new HttpError(400, '最多上传 3 张图片。');
  for (const image of images) {
    if (typeof image === 'string' || image.size === 0) throw new HttpError(400, '请选择有效的图片。');
    if (image.size > MAX_IMAGE_BYTES) throw new HttpError(413, '每张图片最多 2 MB。');
  }
  return { feedback, images };
}

function inputFormat(data) {
  if (data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function normalizeImage(file) {
  const data = Buffer.from(await file.arrayBuffer());
  const format = inputFormat(data);
  if (!format) throw new HttpError(415, '图片须为 JPEG、PNG 或 WebP。');
  let output;
  try {
    const image = sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== format || metadata.pages > 1) throw new Error('Unsupported image');
    if (metadata.depth !== 'uchar') throw new HttpError(400, '请将截图转换为普通 8 位 JPEG、PNG 或 WebP 后重试。');
    output = await image.autoOrient().resize(2400, 2400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '有图片尺寸过大或无法读取，请裁剪后重试。');
  }
  if (output.length > MAX_IMAGE_BYTES) throw new HttpError(413, '有图片过大，请缩小后再试。');
  return output;
}

function normalizeImages(images) {
  const job = imageWork.then(async () => {
    const normalized = [];
    for (const image of images) normalized.push(await normalizeImage(image));
    return normalized;
  });
  imageWork = job.then(() => undefined, () => undefined);
  return job;
}

export async function initializeFeedbackSubmissions(pool) {
  await pool.query(`ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS bilibili_uid text CHECK (bilibili_uid ~ '^[1-9][0-9]{0,18}$'),
    ADD COLUMN IF NOT EXISTS environment jsonb CHECK (jsonb_typeof(environment) = 'object'),
    ADD COLUMN IF NOT EXISTS contact_email text CHECK (char_length(contact_email) <= 254);
    CREATE INDEX IF NOT EXISTS feedback_bilibili_uid_idx ON feedback(bilibili_uid) WHERE bilibili_uid IS NOT NULL;
    CREATE TABLE IF NOT EXISTS feedback_limits (
      address_hash text PRIMARY KEY, count integer NOT NULL, window_start timestamptz NOT NULL
    );
    ALTER TABLE feedback_limits
      ADD COLUMN IF NOT EXISTS hourly_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS daily_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS daily_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS daily_window_start timestamptz;
    CREATE TABLE IF NOT EXISTS feedback_images (
    id uuid PRIMARY KEY,
    feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
    position smallint NOT NULL CHECK (position >= 0 AND position < ${MAX_IMAGES}),
    mime_type text NOT NULL,
    byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= ${MAX_IMAGE_BYTES}),
    data bytea NOT NULL CHECK (octet_length(data) = byte_size),
    UNIQUE (feedback_id, position)
  )`);
}

async function takeFeedbackSlot(db, addressHash, submission, retryable = false) {
  const count = submission ? 1 : 0;
  const attempt = submission ? 0 : 1;
  const quota = await db.query(`INSERT INTO feedback_limits AS limits
    (address_hash,count,hourly_attempts,window_start,daily_count,daily_attempts,daily_window_start)
    VALUES($1,$2,$3,statement_timestamp(),$2,$3,statement_timestamp())
    ON CONFLICT(address_hash) DO UPDATE SET
      count=CASE WHEN ${hourExpired} THEN EXCLUDED.count ELSE limits.count+EXCLUDED.count END,
      hourly_attempts=CASE WHEN ${hourExpired} THEN EXCLUDED.hourly_attempts ELSE limits.hourly_attempts+EXCLUDED.hourly_attempts END,
      window_start=CASE WHEN ${hourExpired} THEN EXCLUDED.window_start ELSE limits.window_start END,
      daily_count=CASE WHEN ${dayExpired} THEN EXCLUDED.daily_count ELSE limits.daily_count+EXCLUDED.daily_count END,
      daily_attempts=CASE WHEN ${dayExpired} THEN EXCLUDED.daily_attempts ELSE limits.daily_attempts+EXCLUDED.daily_attempts END,
      daily_window_start=CASE WHEN ${dayExpired} THEN EXCLUDED.daily_window_start ELSE limits.daily_window_start END
    WHERE (${hourExpired} OR (($4 OR limits.count < ${HOURLY_FEEDBACK_LIMIT})
      AND ($3=0 OR limits.hourly_attempts < ${HOURLY_ATTEMPT_LIMIT})))
    AND (${dayExpired} OR (($4 OR limits.daily_count < ${DAILY_FEEDBACK_LIMIT})
      AND ($3=0 OR limits.daily_attempts < ${DAILY_ATTEMPT_LIMIT})))
    RETURNING 1`, [addressHash, count, attempt, retryable]);
  if (quota.rowCount) return;

  const { rows: [limit] } = await db.query(`SELECT
    CASE WHEN (NOT $3 AND count >= ${HOURLY_FEEDBACK_LIMIT}) OR ($2 AND hourly_attempts >= ${HOURLY_ATTEMPT_LIMIT})
      THEN CEIL(EXTRACT(epoch FROM window_start + interval '1 hour' - statement_timestamp()))::integer END AS hour_wait,
    CASE WHEN (NOT $3 AND daily_count >= ${DAILY_FEEDBACK_LIMIT}) OR ($2 AND daily_attempts >= ${DAILY_ATTEMPT_LIMIT})
      THEN CEIL(EXTRACT(epoch FROM daily_window_start + interval '24 hours' - statement_timestamp()))::integer END AS day_wait
    FROM feedback_limits WHERE address_hash=$1`, [addressHash, !submission, retryable]);
  const daily = limit?.day_wait > 0;
  const error = new HttpError(429, daily
    ? '当前网络已达到 24 小时反馈上限，请稍后再试。'
    : '当前网络提交反馈较频繁，请稍后再试。', 'feedback_rate_limited');
  error.retryAfter = Math.max(1, limit?.hour_wait ?? 0, limit?.day_wait ?? 0);
  throw error;
}

// Bound requests before reading or decoding attachments. Invalid forms can be corrected
// using the separate submission allowance, which is recorded with the saved feedback.
export function admitFeedbackRequest(pool, addressHash, { app = false } = {}) {
  // An app retry can still retrieve a committed receipt when write quota is full.
  return takeFeedbackSlot(pool, addressHash, false, app);
}

async function existingTrackedSubmission(db, feedback) {
  if (!feedback.trackingKeyHash) return null;
  const { rows: [item] } = await db.query(
    'SELECT id,bilibili_uid,anonymous FROM feedback WHERE tracking_key_hash=$1', [feedback.trackingKeyHash],
  );
  if (!item) return null;
  if (item.anonymous !== false || item.bilibili_uid !== feedback.bilibiliUid) {
    throw new HttpError(400, '这份反馈查询凭据与当前提交不匹配。');
  }
  return item.id;
}

export async function saveFeedback(pool, { feedback, images }, policyVersion, addressHash) {
  const existing = await existingTrackedSubmission(pool, feedback);
  if (existing) return existing;
  const id = randomUUID();
  const insert = `INSERT INTO feedback(id,category,title,message,platform,version,contact,policy_version,
    bilibili_uid,environment,contact_email,anonymous,tracking_key_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT(tracking_key_hash) DO NOTHING RETURNING id`;
  const fields = [id, feedback.category, feedback.title, feedback.message, feedback.platform, feedback.version, feedback.contact, policyVersion,
    feedback.bilibiliUid ?? null, feedback.environment ?? null, feedback.email ?? null, feedback.anonymous ?? null, feedback.trackingKeyHash ?? null];
  const normalized = images.length ? await normalizeImages(images) : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [created] } = await client.query(insert, fields);
    if (!created) {
      const replayed = await existingTrackedSubmission(client, feedback);
      if (!replayed) throw new HttpError(503, '反馈服务暂不可用，请稍后重试。');
      await client.query('COMMIT');
      return replayed;
    }
    await takeFeedbackSlot(client, addressHash, true);
    for (const [position, data] of normalized.entries()) {
      await client.query(`INSERT INTO feedback_images(id,feedback_id,position,mime_type,byte_size,data)
        VALUES($1,$2,$3,'image/webp',$4,$5)`, [randomUUID(), id, position, data.length, data]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return id;
}
