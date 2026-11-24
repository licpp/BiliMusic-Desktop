import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './validation.mjs';

export const apkDownloadPrefix = '/downloads/apk/';

export function apkDownloadPath(platform) {
  if (platform.status === 'available' && /^[\w.-]+\.apk$/.test(platform.file) &&
      platform.channels.some(channel => channel.id === 'gitee' && channel.url)) {
    return apkDownloadPrefix + platform.file;
  }
}

export async function serveApk(req, res, platform, directory = new URL('./apk-downloads/', import.meta.url)) {
  if (!platform) throw new HttpError(404, '安装包不存在。');
  const file = new URL(platform.file, directory);
  const info = await stat(file).catch(error => {
    if (error.code === 'ENOENT') throw new HttpError(503, '安装包暂不可下载，请重试或选择 GitHub。');
    throw error;
  });
  const { size } = info;
  if (!info.isFile() || size !== platform.size) throw new HttpError(503, '安装包暂不可下载，请重试或选择 GitHub。');
  const etag = `"${platform.sha256}"`;
  const headers = {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Disposition': `attachment; filename="${platform.file}"`,
    'Cache-Control': 'public, max-age=3600',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  const range = !req.headers['if-range'] || req.headers['if-range'] === etag
    ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '') : null;
  const partial = range && (range[1] || range[2]);
  let start = 0;
  let end = size - 1;
  if (partial) {
    start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    if (range[1] && range[2]) end = Math.min(end, Number(range[2]));
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD') res.end();
  else await pipeline(createReadStream(file, { start, end }), res);
}
