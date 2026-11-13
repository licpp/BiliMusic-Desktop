import { http } from '@kit.NetworkKit';
import { image } from '@kit.ImageKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

// The media service needs native image data; the React <img> is independent.
// Keep one decoded cover and reject late responses after a track change.
export class Artwork {
  private generation: number = 0;
  private request: http.HttpRequest | null = null;
  private pixels: image.PixelMap | null = null;

  clear(): void {
    this.generation += 1;
    this.request?.destroy(); this.request = null;
    this.pixels?.release().catch(() => {}); this.pixels = null;
  }

  async load(value: string | undefined, install: (pixels: image.PixelMap) => Promise<void>): Promise<void> {
    this.clear();
    const url = value?.trim().replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://');
    if (!url || !url.startsWith('https://')) return;
    const generation = this.generation;
    const request = http.createHttp(); this.request = request;
    let source: image.ImageSource | null = null;
    let pixels: image.PixelMap | null = null;
    let stage: string = 'request';
    try {
      const response = await request.request(url, {
        method: http.RequestMethod.GET, expectDataType: http.HttpDataType.ARRAY_BUFFER,
        header: { 'Referer': 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0 BiliMusic' },
        connectTimeout: 5000, readTimeout: 8000, maxLimit: 4 * 1024 * 1024
      });
      if (generation !== this.generation) return;
      const bytes = response.result as ArrayBuffer;
      if (response.responseCode !== 200 || bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) return;
      stage='decode';
      source = image.createImageSource(bytes);
      const info = await source.getImageInfo();
      const scale = Math.min(1, 384 / Math.max(info.size.width, info.size.height));
      stage='pixels';
      pixels = await source.createPixelMap({ desiredSize: {
        width: Math.max(1, Math.round(info.size.width * scale)), height: Math.max(1, Math.round(info.size.height * scale))
      } });
      if (generation !== this.generation) return;
      stage='publish';
      await install(pixels);
      if (generation !== this.generation) return;
      this.pixels = pixels; pixels = null;
    } catch (error) {
      // Artwork must not stop audio, and URLs/credentials never enter the log.
      if (generation === this.generation) hilog.warn(0xB110, 'BiliMusicPlayer', 'Artwork failed; stage=%{public}s code=%{public}d',stage,(error as BusinessError).code ?? -1);
    } finally {
      await pixels?.release().catch(() => {});
      await source?.release().catch(() => {});
      if (this.request === request) { this.request = null; request.destroy(); }
    }
  }
}
