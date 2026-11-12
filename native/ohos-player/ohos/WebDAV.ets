import { rcp } from '@kit.RemoteCommunicationKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

export interface WebDAVUpload { url: string; authorization: string; bodyBase64: string }
export interface WebDAVResponse { status: number; errorCode?: number }

// Only HTTP transport differs. Rust owns the snapshot, destination, merge,
// validation and acknowledgement; no music-library logic lives here.
export async function putWebDAV(args: WebDAVUpload): Promise<WebDAVResponse> {
  if (!/^https:\/\/dav\.jianguoyun\.com\/[^?#]*\/BiliMusic-sync-v1\/\d+\/[0-9a-f-]{36}\.json$/i.test(args.url) ||
      !/^Basic [A-Za-z0-9+/]+=*$/.test(args.authorization) || args.bodyBase64.length > 16 * 1024 * 1024) {
    throw new Error('Invalid WebDAV upload');
  }
  const bytes = new util.Base64Helper().decodeSync(args.bodyBase64);
  if (bytes.byteLength > 12 * 1024 * 1024) throw new Error('WebDAV upload exceeds size limit');
  const headers: rcp.RequestHeaders = { 'Content-Type': 'application/json', 'Authorization': args.authorization,
    'Content-Length': String(bytes.byteLength) };
  const configuration: rcp.Configuration = { transfer: { autoRedirect: false, timeout: { connectMs: 10000, transferMs: 30000 } } };
  const request = new rcp.Request(args.url, 'PUT', headers,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), undefined, undefined, configuration);
  const session = rcp.createSession();
  try {
    const response = await session.fetch(request);
    hilog.info(0xB110, 'BiliMusicSync', 'Native WebDAV PUT bytes=%{public}d status=%{public}d', bytes.byteLength, response.statusCode);
    return { status: response.statusCode };
  } catch (error) {
    const code = (error as BusinessError).code;
    hilog.warn(0xB110, 'BiliMusicSync', 'Native WebDAV PUT bytes=%{public}d networkCode=%{public}d', bytes.byteLength, code);
    return { status: 0, errorCode: code };
  } finally { session.close(); }
}
