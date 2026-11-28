import pg from 'pg';
import { feedbackStatuses, feedbackStatusTimestamp } from '../feedback-tracking.mjs';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const [command, id, status] = process.argv.slice(2);
  if (command === 'status') {
    if (!/^[0-9a-f-]{36}$/.test(id || '') || !feedbackStatuses.includes(status)) {
      throw new Error('Usage: npm run feedback -- status <id> new|in_progress|resolved|closed');
    }
    const { rows } = await pool.query(`UPDATE feedback SET status=$1,
      status_changed_at=${feedbackStatusTimestamp('status', '$1', 'status_changed_at')},
      updated_at=GREATEST(clock_timestamp(),updated_at+interval '1 microsecond')
      WHERE id=$2 AND ($1 <> 'closed' OR status='closed' OR tracking_key_hash IS NULL) RETURNING id,status`, [status, id]);
    if (!rows.length) throw new Error('未更改状态。若需要关闭可追踪的反馈，请在反馈工作台填写原因。');
    console.log(rows);
  } else {
    const rows = await pool.query('SELECT id,category,title,message,platform,version,contact,contact_email,status,created_at FROM feedback ORDER BY created_at DESC LIMIT 30');
    console.log(JSON.stringify(rows.rows,null,2));
  }
} finally { await pool.end(); }
