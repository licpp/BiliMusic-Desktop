import { common, Want, wantAgent } from '@kit.AbilityKit';
import { avSession } from '@kit.AVSessionKit';
import { media } from '@kit.MediaKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { asset } from '@kit.AssetStoreKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import native from 'libbilimusic_lib.so';

interface Request { id: number; plugin: string; command: string; payload: string }
interface Args {
  url?: string; id?: string; title?: string; artist?: string; coverUrl?: string;
  position?: number; volume?: number; playing?: boolean; collectionRef?: string;
  rate?: number; action?: string; value?: number | string; profilePath?: string;
  key?: string; remove?: boolean;
}
interface Snapshot {
  id: string; status: string; position: number; duration: number; rate: number;
  sleepDeadline: number; sleepDuration: number; sleepExpired: boolean;
  stopped: boolean; error?: string; action?: string;
}
class EmptyResult {}
interface BridgeError { message: string }
interface SecretResult { value?: string }
interface ListeningSample {
  scope: string; trackId: string; seconds?: number; position?: number;
  observedAt: number; sessionId?: string; collectionRef?: string;
}

// Only Harmony system APIs live here. Search, playlists, lyrics, database and
// account/WebDAV merge logic remain in the shared React + Rust application.
export class PlayerPlugin {
  private context: common.UIAbilityContext;
  private player: media.AVPlayer | null = null;
  private session: avSession.AVSession | null = null;
  private win: window.Window | null = null;
  private tasks: Promise<void> = Promise.resolve();
  private id: string = '';
  private title: string = 'BiliMusic';
  private artist: string = '';
  private status: string = 'paused';
  private volume: number = 0.7;
  private rate: number = 1;
  private collectionRef: string = '';
  private profilePath: string = '';
  private previousScope: string = '';
  private previousId: string = '';
  private previousPosition: number = -1;
  private previousAt: number = 0;
  private positionSavedAt: number = 0;
  private listeningSeconds: number = 0;
  private sessionId: string = util.generateRandomUUID(true);
  private sleepingAt: number = 0;
  private sleepDuration: number = 0;
  private sleepExpired: boolean = false;
  private timer: number = -1;
  private background: boolean = false;
  private destroyed: boolean = false;
  private error: string = '';

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.timer = setInterval(() => {
      this.accountListening();
      if (this.sleepingAt > 0 && Date.now() >= this.sleepingAt) {
        this.sleepingAt = 0; this.sleepExpired = true;
        this.enqueueControl('pause');
      }
      this.emit();
    }, 1000);
  }

  setWindow(win: window.Window): void { this.win = win; }

  dispatch(raw: string): void {
    const request = JSON.parse(raw) as Request;
    this.tasks = this.tasks.catch(() => {}).then(async () => {
      try {
        if (this.destroyed) throw new Error('Ability is closed');
        if (request.plugin !== 'ohos-player') throw new Error('Unsupported native plugin');
        const result = await this.command(request.command, JSON.parse(request.payload) as Args);
        native.tauriOhosPluginResponse(request.id, true, JSON.stringify(result));
      } catch (error) {
        native.tauriOhosPluginResponse(request.id, false, JSON.stringify({ message: String(error) } as BridgeError));
      }
    });
  }

  private async command(command: string, args: Args): Promise<Object> {
    if (command === 'snapshot') return this.snapshot();
    if (command === 'secret') return this.secret(args);
    if (command === 'observe_listening') { this.profilePath = args.profilePath ?? ''; return new EmptyResult(); }
    if (command === 'open_url') {
      if (!args.url?.startsWith('https://bilimusic.cn/')) throw new Error('Unsupported URL');
      await this.context.startAbility({ action: 'ohos.want.action.viewData', uri: args.url }); return new EmptyResult();
    }
    if (command === 'play') { await this.play(args); return new EmptyResult(); }
    if (command === 'control') { await this.control(args); return new EmptyResult(); }
    throw new Error(`Unsupported native command: ${command}`);
  }

  private snapshot(): Snapshot {
    return { id: this.id, status: this.status, position: Math.max(0, (this.player?.currentTime ?? 0) / 1000),
      duration: Math.max(0, (this.player?.duration ?? 0) / 1000), rate: this.rate,
      sleepDeadline: this.sleepingAt, sleepDuration: this.sleepDuration, sleepExpired: this.sleepExpired,
      stopped: this.id.length === 0, error: this.error || undefined };
  }

  private emit(action?: string): void {
    if (this.destroyed) return;
    const state = this.snapshot(); state.action = action;
    native.bilimusicOhosState(JSON.stringify(state));
    if (this.session) {
      const playback: avSession.AVPlaybackState = {
        state: this.status === 'playing' ? avSession.PlaybackState.PLAYBACK_STATE_PLAY : avSession.PlaybackState.PLAYBACK_STATE_PAUSE,
        speed: this.rate, position: { elapsedTime: state.position * 1000, updateTime: Date.now() }
      };
      this.session.setAVPlaybackState(playback).catch(() => {});
    }
  }

  private enqueueControl(action: string, value: number = 0): void {
    this.tasks = this.tasks.catch(() => {}).then(() => this.control({ action, value })).catch((error: BusinessError) => {
      this.error = String(error); this.status = 'error'; this.emit();
    });
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return;
    this.session = await avSession.createAVSession(this.context, 'BiliMusic', 'audio');
    this.session.on('play', () => this.enqueueControl('resume'));
    this.session.on('pause', () => this.enqueueControl('pause'));
    this.session.on('stop', () => this.enqueueControl('stop'));
    this.session.on('seek', position => this.enqueueControl('seek', position / 1000));
    this.session.on('playNext', () => this.emit('next'));
    this.session.on('playPrevious', () => this.emit('previous'));
    await this.session.activate();
  }

  private async startBackground(): Promise<void> {
    if (this.background) return;
    const want: Want = { bundleName: 'app.bilimusic.harmony', abilityName: 'EntryAbility' };
    const agent = await wantAgent.getWantAgent({ wants: [want], operationType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0, wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG] });
    await backgroundTaskManager.startBackgroundRunning(this.context, backgroundTaskManager.BackgroundMode.AUDIO_PLAYBACK, agent);
    this.background = true;
  }

  private async stopBackground(): Promise<void> {
    if (!this.background) return;
    await backgroundTaskManager.stopBackgroundRunning(this.context);
    this.background = false;
  }

  private async play(args: Args): Promise<void> {
    if (!args.url || !args.id || !/^http:\/\/127\.0\.0\.1:\d+\//.test(args.url)) throw new Error('Invalid playback source');
    this.accountListening(true);
    if (this.player) { await this.player.release(); this.player = null; }
    await this.ensureSession();
    this.id = args.id; this.title = args.title ?? 'BiliMusic'; this.artist = args.artist ?? '';
    this.collectionRef = args.collectionRef ?? ''; this.error = ''; this.status = 'buffering';
    this.rate = args.rate ?? 1; this.volume = args.volume ?? 0.7;
    this.previousPosition = -1; this.previousId = ''; this.sessionId = util.generateRandomUUID(true);
    const player = await media.createAVPlayer(); this.player = player;
    player.on('audioInterrupt', event => {
      // Pause on focus loss and unplugged outputs; never resume unexpectedly.
      if (event.hintType !== 0) this.enqueueControl('pause');
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('音频准备超时，请重试')), 20000);
      player.on('error', error => {
        hilog.error(0xB110, 'BiliMusicPlayer', 'AVPlayer error code=%{public}d', error.code);
        clearTimeout(timeout); this.accountListening(true);
        this.error = error.message; this.status = 'error'; this.emit();
        reject(new Error(error.message));
      });
      // AVPlayer retains one callback per event. Register preparation and live
      // playback transitions together so the ready callback cannot replace them.
      player.on('stateChange', async state => {
        if (this.player !== player) return;
        hilog.info(0xB110, 'BiliMusicPlayer', 'AVPlayer state=%{public}s', state);
        try {
          if (state === 'initialized') { await player.prepare(); return; }
          if (state === 'prepared') { clearTimeout(timeout); resolve(); return; }
          if (state === 'playing') this.status = 'playing';
          else if (state === 'paused') { this.accountListening(true); this.status = 'paused'; }
          else if (state === 'completed') {
            this.accountListening(true); this.status = 'paused'; this.previousPosition = -1;
            this.emit('ended'); this.stopBackground().catch(() => {}); return;
          }
          else if (state === 'error') {
            clearTimeout(timeout); reject(new Error('音频无法播放')); return;
          }
          this.emit();
        } catch (error) { clearTimeout(timeout); reject(new Error(String(error))); }
      });
      player.url = args.url ?? '';
    });
    player.setVolume(this.volume); this.applyRate(this.rate);
    if ((args.position ?? 0) > 0) player.seek((args.position ?? 0) * 1000);
    await this.session?.setAVMetadata({ assetId: this.id, title: this.title, artist: this.artist, duration: player.duration });
    if (args.playing !== false) { await this.startBackground(); await player.play(); }
    else { this.status = 'paused'; this.emit(); }
  }

  private applyRate(rate: number): void {
    const rates = [0.75, 1, 1.25, 1.75, 2, 0.5, 1.5, 3, 0.25, 0.125];
    const index = rates.indexOf(rate);
    if (index < 0) throw new Error('不支持的播放速度');
    this.player?.setSpeed(index as media.PlaybackSpeed); this.rate = rate;
  }

  private async control(args: Args): Promise<void> {
    const value = typeof args.value === 'number' ? args.value : 0;
    switch (args.action) {
      case 'prepare': break;
      case 'resume': if (this.player) { await this.startBackground(); await this.player.play(); } break;
      case 'pause':
        this.accountListening(true);
        if (this.player?.state === 'playing') await this.player.pause();
        await this.stopBackground(); break;
      case 'stop':
        this.accountListening(true); await this.player?.release(); this.player = null;
        this.id = ''; this.status = 'paused'; await this.stopBackground(); break;
      case 'seek': this.accountListening(true); this.previousPosition = -1; this.player?.seek(Math.max(0, value * 1000)); break;
      case 'volume': this.volume = Math.max(0, Math.min(1, value)); this.player?.setVolume(this.volume); break;
      case 'rate': this.accountListening(true); this.applyRate(value); break;
      case 'collection':
        if (args.id === this.id) { this.accountListening(true); this.collectionRef = args.collectionRef ?? ''; } break;
      case 'sleepStart':
        if (value < 1 || value > 10800) throw new Error('无效的定时长度');
        this.sleepDuration = value; this.sleepingAt = Date.now() + value * 1000; this.sleepExpired = false; break;
      case 'sleepRepeat': this.sleepingAt = Date.now() + this.sleepDuration * 1000; this.sleepExpired = false; break;
      case 'sleepDismiss': this.sleepExpired = false; break;
      case 'sleepCancel': this.sleepingAt = 0; this.sleepExpired = false; break;
      case 'theme':
        await this.win?.setWindowSystemBarProperties({ statusBarContentColor: value === 1 ? '#203044' : '#FFFFFF',
          navigationBarContentColor: value === 1 ? '#203044' : '#FFFFFF' }); break;
      case 'immersive': break; // ArkWeb occupies the same safe-area window in both modes.
      default: throw new Error(`Unsupported playback action: ${args.action}`);
    }
    this.emit();
  }

  private accountListening(flush: boolean = false): void {
    if (!this.profilePath) return;
    let scope = '';
    try { scope = fileIo.readTextSync(this.profilePath); } catch (_) { return; }
    const now = Date.now();
    const position = this.status === 'playing' ? Math.max(0, (this.player?.currentTime ?? 0) / 1000) : -1;
    if (scope === this.previousScope && this.id === this.previousId && position >= 0 && this.previousPosition >= 0) {
      const elapsed = Math.max(0, (now - this.previousAt) / 1000);
      const advanced = Math.max(0, (position - this.previousPosition) / this.rate);
      // Ignore seeks and large scheduling gaps; listening time never counts a jump.
      if (elapsed <= 5 && advanced <= elapsed + 0.5) this.listeningSeconds += Math.min(advanced, elapsed);
    } else {
      this.flushListening(this.previousScope, this.previousId, now);
      this.sessionId = util.generateRandomUUID(true);
    }
    this.previousScope = scope; this.previousId = this.id; this.previousPosition = position; this.previousAt = now;
    if (flush || this.listeningSeconds >= 15) this.flushListening(scope, this.id, now);
    if ((flush || now - this.positionSavedAt >= 15000) && scope && this.id) {
      this.positionSavedAt = now;
      const state = this.snapshot();
      const saved = state.position < 1 || (state.duration > 0 && state.position >= state.duration - 1) ? 0 : state.position;
      const sample: ListeningSample = { scope, trackId: this.id, position: saved,
        observedAt: now, collectionRef: this.collectionRef || undefined };
      native.bilimusicOhosListening(JSON.stringify(sample));
    }
  }

  private flushListening(scope: string, id: string, now: number): void {
    const seconds = this.listeningSeconds; this.listeningSeconds = 0;
    if (!scope || !id || seconds <= 0) return;
    const sample: ListeningSample = { scope, trackId: id, seconds, observedAt: now, sessionId: this.sessionId };
    native.bilimusicOhosListening(JSON.stringify(sample));
  }

  private async secret(args: Args): Promise<SecretResult> {
    if (!args.key?.startsWith('sync-')) throw new Error('Invalid credential key');
    const encoder = new util.TextEncoder();
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, encoder.encodeInto(args.key));
    if (args.remove) {
      try { await asset.remove(query); }
      catch (error) { if ((error as BusinessError).code !== asset.ErrorCode.NOT_FOUND) throw new Error(String(error)); }
      return new EmptyResult();
    }
    if (typeof args.value === 'string') {
      try {
        const attributes: asset.AssetMap = new Map();
        attributes.set(asset.Tag.SECRET, encoder.encodeInto(args.value));
        await asset.update(query, attributes);
      }
      catch (error) {
        if ((error as BusinessError).code !== asset.ErrorCode.NOT_FOUND) throw new Error(String(error));
        const attributes: asset.AssetMap = new Map();
        attributes.set(asset.Tag.ALIAS, encoder.encodeInto(args.key));
        attributes.set(asset.Tag.SECRET, encoder.encodeInto(args.value));
        attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
        await asset.add(attributes);
      }
      return new EmptyResult();
    }
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const entries = await asset.query(query);
      if (entries.length === 0) return new EmptyResult();
      return { value: util.TextDecoder.create('utf-8').decodeWithStream(entries[0].get(asset.Tag.SECRET) as Uint8Array) };
    } catch (error) { if ((error as BusinessError).code === asset.ErrorCode.NOT_FOUND) return new EmptyResult(); throw new Error(String(error)); }
  }

  async destroy(): Promise<void> {
    this.accountListening(true); this.destroyed = true; clearInterval(this.timer);
    await this.player?.release(); await this.stopBackground(); await this.session?.destroy();
  }
}
