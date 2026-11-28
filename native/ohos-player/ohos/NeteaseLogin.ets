import { url } from '@kit.ArkTS';
import { ComponentContent, window } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';

const LOGIN_PAGE = 'https://music.163.com/#/login';
const COOKIE_SITE = 'https://music.163.com/';
const COOKIE_POLL_MS = 500;
const LOGIN_TIMEOUT_MS = 300_000;

export interface NeteaseLoginResult {
  status: 'authorized' | 'cancelled' | 'timeout' | 'failed';
  musicU?: string;
  csrf?: string;
}

function isNeteaseUrl(value: string): boolean {
  try {
    const parsed = url.URL.parseURL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      (!parsed.port || parsed.port === '443') && (host === '163.com' || host.endsWith('.163.com'));
  } catch (_) {
    return false;
  }
}

function readSession(controller: webview.WebviewController): NeteaseLoginResult | undefined {
  let cookies: string;
  try {
    if (!isNeteaseUrl(controller.getUrl())) return undefined;
    cookies = webview.WebCookieManager.fetchCookieSync(COOKIE_SITE, true);
  } catch (_) {
    // ArkWeb throws while the document has no cookie yet.
    return undefined;
  }
  let musicU = '';
  let csrf = '';
  for (const pair of cookies.split(';')) {
    const equals = pair.indexOf('=');
    if (equals < 1) continue;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (name === 'MUSIC_U') musicU = value;
    else if (name === '__csrf') csrf = value;
  }
  return musicU ? { status: 'authorized', musicU, csrf } : undefined;
}

class NeteaseDialogData {
  readonly controller = new webview.WebviewController();
  readonly light: boolean;
  readonly onClose: () => void;
  readonly onLoadFailure: () => void;

  constructor(light: boolean, onClose: () => void, onLoadFailure: () => void) {
    this.light = light;
    this.onClose = onClose;
    this.onLoadFailure = onLoadFailure;
  }
}

@Builder
function loginPage(data: NeteaseDialogData) {
  Column() {
    Row() {
      Text('网易云音乐登录')
        .fontSize(17)
        .fontWeight(FontWeight.Medium)
        .fontColor(data.light ? '#203044' : '#EFF6FB')
        .layoutWeight(1)
      Button('关闭', { buttonStyle: ButtonStyleMode.TEXTUAL })
        .height(44)
        .fontColor(data.light ? '#067988' : '#72D7E4')
        .onClick(() => data.onClose())
    }
    .width('100%')
    .padding({ left: 16, right: 8 })
    Web({ src: LOGIN_PAGE, controller: data.controller, incognitoMode: true })
      .width('100%')
      .layoutWeight(1)
      .javaScriptAccess(true)
      .domStorageAccess(true)
      .multiWindowAccess(false)
      .keyboardAvoidMode(WebKeyboardAvoidMode.RESIZE_VISUAL)
      .onLoadIntercept(event => event.data.isMainFrame() && !isNeteaseUrl(event.data.getRequestUrl()))
      .onErrorReceive(event => {
        if (event.request.isMainFrame()) data.onLoadFailure();
      })
  }
  .width('94%')
  .height('86%')
  .constraintSize({ maxWidth: 640 })
  .backgroundColor(data.light ? '#F4F6FA' : '#101D27')
  .borderRadius(20)
  .clip(true)
}

export class NeteaseLoginDialog {
  private closeCurrent?: () => Promise<void>;

  async open(win: window.Window, light: boolean): Promise<NeteaseLoginResult> {
    if (this.closeCurrent) return { status: 'failed' };
    const ui = win.getUIContext();
    const prompt = ui.getPromptAction();
    return new Promise<NeteaseLoginResult>(resolve => {
      let poll = -1;
      let timeout = -1;
      let opening = Promise.resolve();
      let closing: Promise<void> | undefined;
      const finish = (result: NeteaseLoginResult): Promise<void> => {
        if (closing) return closing;
        clearInterval(poll);
        clearTimeout(timeout);
        // A cancel can reach us before ArkUI has finished opening the dialog.
        closing = opening.then(() => prompt.closeCustomDialog(content)).catch(() => {}).then(() => {
          try { content.dispose(); } catch (_) { /* The window may already be gone. */ }
          this.closeCurrent = undefined;
          resolve(result);
        });
        return closing;
      };
      const data = new NeteaseDialogData(light,
        () => { void finish({ status: 'cancelled' }); },
        () => { void finish({ status: 'failed' }); });
      const content = new ComponentContent(ui, wrapBuilder(loginPage), data);
      this.closeCurrent = () => finish({ status: 'cancelled' });
      try {
        opening = prompt.openCustomDialog(content, {
          autoCancel: false,
          onDidDisappear: () => { void finish({ status: 'cancelled' }); },
        });
      } catch (_) {
        void finish({ status: 'failed' });
        return;
      }
      timeout = setTimeout(() => { void finish({ status: 'timeout' }); }, LOGIN_TIMEOUT_MS);
      opening.then(() => {
        if (closing) return;
        poll = setInterval(() => {
          const result = readSession(data.controller);
          if (result) void finish(result);
        }, COOKIE_POLL_MS);
      }).catch(() => { void finish({ status: 'failed' }); });
    });
  }

  async cancel(): Promise<void> {
    await this.closeCurrent?.();
  }
}
