import { createHash } from 'node:crypto';
import { HttpError } from './validation.mjs';

export const feedbackStatuses = ['new', 'in_progress', 'resolved', 'closed'];
export const feedbackStatusTimestamp = (status, next, timestamp) =>
  `CASE WHEN ${status} IS DISTINCT FROM ${next} THEN clock_timestamp() ELSE ${timestamp} END`;
const LOOKUP_LIMIT = 120;
const REPLY_LIMIT = 20;
const trackingKeyFormat = /^[A-Za-z0-9_-]{43}$/;

export async function initializeFeedbackTracking(pool) {
  await pool.query(`ALTER TABLE feedback
    ADD COLUMN IF NOT EXISTS anonymous boolean,
    ADD COLUMN IF NOT EXISTS tracking_key_hash text CHECK (tracking_key_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN IF NOT EXISTS status_changed_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_user_reply_at timestamptz;
    CREATE UNIQUE INDEX IF NOT EXISTS feedback_tracking_key_idx ON feedback(tracking_key_hash);
    CREATE TABLE IF NOT EXISTS feedback_user_replies (
      id uuid PRIMARY KEY,
      feedback_id uuid NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS feedback_user_replies_feedback_idx
      ON feedback_user_replies(feedback_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS feedback_lookup_limits (
      address_hash text PRIMARY KEY, count integer NOT NULL, window_start timestamptz NOT NULL
    );`);
}

export async function removeExpiredFeedback(pool) {
  await pool.query(`DELETE FROM feedback f WHERE f.created_at < now() - interval '180 days'
    AND f.category <> 'copyright' AND f.original_category IS DISTINCT FROM 'copyright' AND f.status <> 'in_progress'
    AND (f.status NOT IN ('closed','resolved') OR
      GREATEST(f.created_at,f.status_changed_at,f.last_user_reply_at) < now() - interval '180 days')`);
}

export async function admitFeedbackLookup(pool, addressHash) {
  const { rows: [allowed] } = await pool.query(`INSERT INTO feedback_lookup_limits AS limits
    (address_hash,count,window_start) VALUES($1,1,statement_timestamp())
    ON CONFLICT(address_hash) DO UPDATE SET
      count=CASE WHEN limits.window_start <= EXCLUDED.window_start - interval '1 hour' THEN 1 ELSE limits.count+1 END,
      window_start=CASE WHEN limits.window_start <= EXCLUDED.window_start - interval '1 hour' THEN EXCLUDED.window_start ELSE limits.window_start END
    WHERE limits.window_start <= EXCLUDED.window_start - interval '1 hour' OR limits.count < $2
    RETURNING 1`, [addressHash, LOOKUP_LIMIT]);
  if (allowed) return;
  const { rows: [limit] } = await pool.query(`SELECT
    CEIL(EXTRACT(epoch FROM window_start + interval '1 hour' - statement_timestamp()))::integer AS wait
    FROM feedback_lookup_limits WHERE address_hash=$1`, [addressHash]);
  const error = new HttpError(429, '查询反馈过于频繁，请稍后再试。', 'feedback_rate_limited');
  error.retryAfter = Math.max(1, limit?.wait ?? 0);
  throw error;
}

export async function lookupFeedback(pool, input) {
  const trackingKey = input?.trackingKey;
  if (typeof trackingKey !== 'string' || !trackingKeyFormat.test(trackingKey) ||
      Object.keys(input).length !== 1) throw new HttpError(400, '反馈查询凭据格式不正确。');
  const hash = createHash('sha256').update(trackingKey).digest('hex');
  const { rows: [item] } = await pool.query(`SELECT f.id,f.status,f.created_at,f.status_changed_at,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',reply.id,'body',reply.body,
      'createdAt',to_char(reply.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ORDER BY reply.created_at,reply.id)
      FROM (SELECT id,body,created_at FROM feedback_user_replies
        WHERE feedback_id=f.id ORDER BY created_at DESC,id DESC LIMIT $2) reply),'[]'::jsonb) AS replies
    FROM feedback f WHERE f.tracking_key_hash=$1 AND f.anonymous=false`, [hash, REPLY_LIMIT]);
  if (!item) throw new HttpError(404, '没有找到这条反馈。', 'feedback_not_found');
  const { id, status, created_at: createdAt, status_changed_at: statusChangedAt, replies } = item;
  const completedAt = status === 'resolved' ? statusChangedAt : null;
  return { id, status, createdAt, ...(statusChangedAt && { statusChangedAt }), ...(completedAt && { completedAt }), replies };
}
