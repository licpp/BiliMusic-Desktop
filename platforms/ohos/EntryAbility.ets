import { RustAbility } from '@ohos-rs/ability';
import { AbilityConstant, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import native from 'libbilimusic_lib.so';
import { PlayerPlugin } from './PlayerPlugin';

export default class EntryAbility extends RustAbility {
  public moduleName: string = 'bilimusic_lib';
  public defaultPage: boolean = true;
  public mode: 'xcomponent' | 'webview' = 'webview';
  private player: PlayerPlugin | null = null;

  async onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): Promise<void> {
    this.player = new PlayerPlugin(this.context);
    native.tauriOhosPluginInitialize(raw => this.player?.dispatch(raw),
      this.context.filesDir, this.context.cacheDir, this.context.tempDir);
    await super.onCreate(want, launchParam);
  }

  async onWindowStageCreate(stage: window.WindowStage): Promise<void> {
    const win = stage.getMainWindowSync();
    this.player?.setWindow(win);
    await win.setWindowLayoutFullScreen(false);
    await super.onWindowStageCreate(stage);
  }

  async onDestroy(): Promise<void> {
    try { await this.player?.destroy(); }
    finally { native.tauriOhosPluginClose(); await super.onDestroy(); }
  }
}
