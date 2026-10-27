import { readFile } from 'node:fs/promises';
import { HttpError } from './validation.mjs';
export const releases = JSON.parse(await readFile(new URL('./releases.json', import.meta.url), 'utf8'));
export function resolveDownload(input, policyVersion, manifest = releases) {
  if (!input || input.consent !== true || input.policyVersion !== policyVersion) throw new HttpError(400, '请阅读并确认最新使用声明后下载。');
  const platform = manifest.platforms.find(item => item.id === input.platform);
  const channel = platform?.channels.find(item => item.id === input.source);
  if (platform?.status !== 'available' || !channel?.url) throw new HttpError(409, '该平台或下载源尚未准备好。');
  const url = new URL(channel.url);
  const prefixes = { github: 'https://github.com/licpp/BiliMusic-Desktop/releases/download/', gitee: 'https://gitee.com/yoaker/BiliMusic-Desktop/releases/download/' };
  if (!prefixes[channel.id] || !url.href.startsWith(prefixes[channel.id])) throw new HttpError(503, '下载地址配置异常，请通过反馈联系维护者。');
  return { url: url.href, file: platform.file, sha256: platform.sha256 };
}
