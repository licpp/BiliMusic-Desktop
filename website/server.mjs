import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';
import pg from 'pg';
import { policy } from './policy.mjs';
import { HttpError, validateFeedback } from './validation.mjs';

const port = Number(process.env.PORT || 3180);
const origin = new URL(process.env.PUBLIC_ORIGIN || `http://localhost:${port}`).origin;
const root = resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 5000 }) : null;
if (pool && (process.env.IP_HASH_SECRET || '').length < 32) throw new Error('IP_HASH_SECRET must contain at least 32 characters');
pool?.on('error', () => console.error('Database connection error'));
if (pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback (
    id uuid PRIMARY KEY, category text NOT NULL, title text NOT NULL, message text NOT NULL,
    platform text NOT NULL, version text NOT NULL DEFAULT '', contact text NOT NULL DEFAULT '',
    policy_version text NOT NULL, status text NOT NULL DEFAULT 'new', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS feedback_limits (address_hash text PRIMARY KEY, count integer NOT NULL, window_start timestamptz NOT NULL);
    CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback(created_at DESC);`);
}
async function housekeeping() {
  await pool?.query("DELETE FROM feedback_limits WHERE window_start < now() - interval '24 hours'; DELETE FROM feedback WHERE created_at < now() - interval '180 days' AND category <> 'copyright' AND status <> 'in_progress'");
}
await housekeeping();
const cleanup = setInterval(() => housekeeping().catch(() => console.error('Feedback cleanup failed')), 3600000); cleanup.unref();
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  const json = (status, data) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/policy') return json(200, policy);
    if (req.method === 'GET' && path === '/api/health') {
      try { if (!pool) return json(503, { status:'preview', feedback:false }); await pool.query('SELECT 1'); return json(200, { status:'ok', feedback:true }); }
      catch { return json(503, { status:'unavailable', feedback:false }); }
    }
    if (req.method === 'GET' && path === '/api/releases') return json(200, { version:'0.1.4', platforms:[{ id:'mac', name:'macOS', status:'coming_soon' },{ id:'windows', name:'Windows', status:'coming_soon' }] });
    if (req.method === 'POST' && path === '/api/feedback') {
      if (req.headers.origin !== origin) throw new HttpError(403, '请通过本站反馈表单提交。');
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请提交 JSON 格式。');
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 24000) throw new HttpError(413, '反馈内容过长。'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, '反馈格式不正确。'); }
      const data = validateFeedback(body, policy.version);
      if (!pool) throw new HttpError(503, '反馈服务暂未连接，请稍后重试。');
      const ip = process.env.TRUST_PROXY === 'true' ? req.headers['x-forwarded-for']?.split(',').at(-1)?.trim() || req.socket.remoteAddress : req.socket.remoteAddress;
      const hash = createHmac('sha256', process.env.IP_HASH_SECRET).update(ip || 'unknown').digest('hex');
      const quota = await pool.query(`INSERT INTO feedback_limits(address_hash, count, window_start) VALUES($1,1,now())
        ON CONFLICT(address_hash) DO UPDATE SET count=CASE WHEN feedback_limits.window_start < now()-interval '1 hour' THEN 1 ELSE feedback_limits.count+1 END,
        window_start=CASE WHEN feedback_limits.window_start < now()-interval '1 hour' THEN now() ELSE feedback_limits.window_start END
        RETURNING count`, [hash]);
      if (quota.rows[0].count > 5) { res.setHeader('Retry-After','3600'); throw new HttpError(429, '提交较频繁，请一小时后再试。'); }
      const id = randomUUID();
      await pool.query('INSERT INTO feedback(id,category,title,message,platform,version,contact,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [id,data.category,data.title,data.message,data.platform,data.version,data.contact,policy.version]);
      return json(201, { id, message:'反馈已收到，谢谢你帮助 BiliMusic 变得更好。' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持此操作。');
    const relative = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep) || relative.split('/').some(x => x.startsWith('.'))) throw new HttpError(404, '页面不存在。');
    let info; try { info = await stat(file); } catch { throw new HttpError(404, '页面不存在。'); }
    if (!info.isFile()) throw new HttpError(404, '页面不存在。');
    res.writeHead(200, { 'Content-Type':mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch (error) {
    if (!(error instanceof HttpError)) console.error('Request failed:', error.code || error.name);
    if (!res.headersSent) json(error.status || 503, { message: error instanceof HttpError ? error.message : '服务暂时不可用，请稍后重试。' });
    else res.end();
  }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`BiliMusic website: http://${process.env.HOST || '127.0.0.1'}:${port}`));
async function shutdown() { clearInterval(cleanup); server.close(); await pool?.end(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
