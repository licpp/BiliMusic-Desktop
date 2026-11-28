import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { policy } from './policy.mjs';
import { HttpError } from './validation.mjs';
import { admitFeedbackRequest, initializeFeedbackSubmissions, readFeedbackLookup, readFeedbackSubmission, saveFeedback } from './feedback-submission.mjs';
import { createFeedbackAdmin, initializeFeedbackAdmin } from './feedback-admin.mjs';
import { admitFeedbackLookup, initializeFeedbackTracking, lookupFeedback, removeExpiredFeedback } from './feedback-tracking.mjs';
import { updaterManifest, validateUpdateDownload } from './updater.mjs';
import { releases, resolveDownload } from './releases.mjs';
import { apkDownloadPath, apkDownloadPrefix, serveApk } from './apk-downloads.mjs';
import { initializeDownloadStats, recordDownload, getDownloadStats } from './downloads.mjs';

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
    CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback(created_at DESC);`);
  await initializeDownloadStats(pool);
  await initializeFeedbackSubmissions(pool);
  await initializeFeedbackTracking(pool);
  await initializeFeedbackAdmin(pool);
}
function clientAddress(req) {
  const forwarded = process.env.TRUST_PROXY === 'true' ? req.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
  return forwarded || req.socket.remoteAddress || 'unknown';
}
function clientAddressHash(req) {
  return createHmac('sha256', process.env.IP_HASH_SECRET).update(clientAddress(req)).digest('hex');
}
const handleFeedbackAdmin = createFeedbackAdmin({ pool, origin, clientAddress });
let activeFeedbackUploads = 0;
async function housekeeping() {
  if (!pool) return;
  await pool.query(`DELETE FROM feedback_limits WHERE GREATEST(window_start,daily_window_start) < now() - interval '24 hours';
    DELETE FROM feedback_lookup_limits WHERE window_start < now() - interval '24 hours';`);
  await removeExpiredFeedback(pool);
}
await housekeeping();
const cleanup = setInterval(() => housekeeping().catch(() => console.error('Feedback cleanup failed')), 3600000); cleanup.unref();
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
  const json = (status, data) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' }); res.end(JSON.stringify(data)); };
  try {
    // Versioned API leaves room for future account/sync services; retain original paths for existing clients.
    const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/api\/v1(?=\/)/, '/api');
    if (await handleFeedbackAdmin(req, res, path, json)) return;
    if (req.method === 'GET' && path === '/api/policy') return json(200, policy);
    if (req.method === 'GET' && path === '/api/health') {
      try { if (!pool) return json(503, { status:'preview', feedback:false }); await pool.query('SELECT 1'); return json(200, { status:'ok', feedback:true }); }
      catch { return json(503, { status:'unavailable', feedback:false }); }
    }
    if (req.method === 'GET' && path === '/api/updater') {
      const manifest = updaterManifest();
      if (!manifest) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return; }
      return json(200, manifest);
    }
    if (req.method === 'POST' && path === '/api/update-download') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请提交 JSON 格式。');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024) throw new HttpError(413, '请求过长。'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, '请求格式不正确。'); }
      const data = validateUpdateDownload(body, releases);
      let recorded = false;
      if (pool) { try { await recordDownload(pool, data.version, data.platform, data.source); recorded = true; } catch { console.error('Update download statistics unavailable'); } }
      return json(200, { recorded });
    }
    if (req.method === 'GET' && path === '/api/releases') return json(200, releases);
    if (req.method === 'GET' && path === '/api/download-stats') {
      if (!pool) throw new HttpError(503, '下载统计暂不可用。');
      return json(200, await getDownloadStats(pool, releases.version));
    }
    if (req.method === 'POST' && path === '/api/download') {
      if (req.headers.origin !== origin) throw new HttpError(403, '请通过本站下载入口操作。');
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '请提交 JSON 格式。');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new HttpError(413, '请求过长。'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, '请求格式不正确。'); }
      const download = resolveDownload(body, policy.version);
      let downloadStats;
      // Stats are best-effort; a database outage must not prevent installation.
      if (pool) {
        try {
          await recordDownload(pool, releases.version, body.platform, body.source);
          downloadStats = await getDownloadStats(pool, releases.version);
        } catch { console.error('Download statistics unavailable'); }
      }
      return json(200, { ...download, ...(downloadStats ? { downloadStats } : {}) });
    }
    if (path === '/api/app/feedback/status') {
      if (req.method !== 'POST') throw new HttpError(405, '不支持此操作。');
      if (req.headers.origin !== undefined) throw new HttpError(403, '请通过 BiliMusic 客户端查询。');
      if (!pool) throw new HttpError(503, '反馈服务暂未连接，请稍后重试。');
      await admitFeedbackLookup(pool, clientAddressHash(req));
      return json(200, await lookupFeedback(pool, await readFeedbackLookup(req)));
    }
    if ((req.method === 'POST' && path === '/api/feedback') || path === '/api/app/feedback') {
      if (req.method !== 'POST') throw new HttpError(405, '不支持此操作。');
      const app = path === '/api/app/feedback';
      if (app && req.headers.origin !== undefined) throw new HttpError(403, '请通过 BiliMusic 客户端提交。');
      if (!app && req.headers.origin !== origin) throw new HttpError(403, '请通过本站反馈表单提交。');
      if (!pool) throw new HttpError(503, '反馈服务暂未连接，请稍后重试。');
      const mediaType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      const upload = mediaType === 'multipart/form-data';
      if (!upload && mediaType !== 'application/json') throw new HttpError(415, '请通过反馈表单提交。');
      if (upload && activeFeedbackUploads >= 2) {
        res.setHeader('Retry-After', '5');
        throw new HttpError(503, '图片上传繁忙，请稍后重试。');
      }
      if (upload) activeFeedbackUploads += 1;
      try {
        const hash = clientAddressHash(req);
        await admitFeedbackRequest(pool, hash, { app });
        const data = await readFeedbackSubmission(req, policy.version, { app });
        const id = await saveFeedback(pool, data, policy.version, hash);
        return json(201, { id, message:'反馈已收到，谢谢你帮助 BiliMusic 变得更好。' });
      } finally {
        if (upload) activeFeedbackUploads -= 1;
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '不支持此操作。');
    if (path.startsWith(apkDownloadPrefix)) {
      return await serveApk(req, res, releases.platforms.find(platform => apkDownloadPath(platform) === path));
    }
    const parsedUrl = new URL(req.url, 'http://localhost');
    const relative = path === '/' ? 'index.html' : /^\/admin\/feedback\/?$/.test(path) ? 'feedback-admin.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const adminPage = relative === 'feedback-admin.html';
    if (adminPage) res.setHeader('X-Robots-Tag', 'noindex');
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep) || relative.split('/').some(x => x.startsWith('.'))) throw new HttpError(404, '页面不存在。');
    let info; try { info = await stat(file); } catch { throw new HttpError(404, '页面不存在。'); }
    if (!info.isFile()) throw new HttpError(404, '页面不存在。');
    const ext = extname(file).toLowerCase();
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const isHtml = ext === '.html';
    const isAsset = relative.startsWith('assets/') || Boolean(parsedUrl.searchParams.get('v'));
    const cacheControl = adminPage ? 'no-store' : isHtml ? 'no-cache' : isAsset ? 'public, max-age=86400, stale-while-revalidate=604800' : 'public, max-age=3600';
    const headers = {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'ETag': etag,
      'Last-Modified': info.mtime.toUTCString(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch (error) {
    if (res.destroyed) return;
    if ((error.status === 413 || error.status === 429) && !req.complete) res.setHeader('Connection', 'close');
    if (error.retryAfter !== undefined) res.setHeader('Retry-After', String(error.retryAfter));
    if (!(error instanceof HttpError)) console.error('Request failed:', error.code || error.name);
    if (!res.headersSent) {
      json(error.status || 503, error instanceof HttpError
        ? { message: error.message, code: error.code }
        : { message: '服务暂时不可用，请稍后重试。' });
    }
    else res.end();
  }
});
server.requestTimeout = 60000; server.headersTimeout = 10000;
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`BiliMusic website: http://${process.env.HOST || '127.0.0.1'}:${port}`));
async function shutdown() { clearInterval(cleanup); server.close(); await pool?.end(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
