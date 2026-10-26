import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const [command, id, status] = process.argv.slice(2);
  if (command === 'status') {
    if (!/^[0-9a-f-]{36}$/.test(id || '') || !['new','in_progress','resolved'].includes(status)) throw new Error('Usage: npm run feedback -- status <id> new|in_progress|resolved');
    console.log((await pool.query('UPDATE feedback SET status=$1 WHERE id=$2 RETURNING id,status',[status,id])).rows);
  } else {
    const rows = await pool.query('SELECT id,category,title,message,platform,version,contact,status,created_at FROM feedback ORDER BY created_at DESC LIMIT 30');
    console.log(JSON.stringify(rows.rows,null,2));
  }
} finally { await pool.end(); }
