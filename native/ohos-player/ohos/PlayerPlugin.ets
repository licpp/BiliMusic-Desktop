import { common, Want, wantAgent } from '@kit.AbilityKit';
import { avSession } from '@kit.AVSessionKit';
import { media } from '@kit.MediaKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { asset } from '@kit.AssetStoreKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { deviceInfo, BusinessError } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Artwork } from './Artwork';
import { putWebDAV, WebDAVUpload } from './WebDAV';
import native from 'libbilimusic_lib.so';

interface Request { id: number; plugin: string; command: string; payload: string }
interface Args {
  data?: string; url?: string; id?: string; title?: string; artist?: string; coverUrl?: string;
  position?: number; volume?: number; playing?: boolean; collectionRef?: string;
  rate?: number; seamless?: boolean; action?: string; value?: number | string; profilePath?: string;
  key?: string; remove?: boolean;
}
interface Snapshot {
  id: string; status: string; position: number; duration: number; rate: number;
  sleepDeadline: number; sleepDuration: number; sleepExpired: boolean;
  stopped: boolean; error?: string; action?: string; floatingLyricsEnabled?: boolean; revision?: number; sequence?: number; seekRevision?: number;
}
interface LyricsPayload { action: string; enabled?: boolean; id?: string; lrc?: string; fontSize?: number; locked?: boolean }
interface LyricsResult { supported: boolean; enabled: boolean; reason?: string; fontSizeSupported?: boolean; lockSupported?: boolean }
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
  private desiredPlaying: boolean = false;
  private cancelSourceSwitch: (() => void) | null = null;
  private cancelPreparation: (() => void) | null = null;
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
  private artwork: Artwork = new Artwork();
  private artworkReady: Promise<void> = Promise.resolve();
  private mediaRevision: number = 0;
  private mediaAdvancedAt: number = 0;
  private watchdogPosition: number = -1;
  private desktopLyricsLocked: boolean = false;
  private desktopLyricsEnabled: boolean = false;
  private lyricId: string = '';
  private lyricText: string = '';
  private lyricTimer: number = -1;
  private stateSequence: number = 0;
  private seekRevision: number = 0;
  private pendingSeek: number = -1;
  private currentMetadata: avSession.AVMetadata | null = null;
  private metadataTasks: Promise<void> = Promise.resolve();

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.timer = setInterval(() => {
      this.accountListening();
      if (this.player?.state === 'playing' && (this.status === 'playing' || this.status === 'buffering')) {
        const position = this.player.currentTime;
        if (position > this.watchdogPosition + 10 && this.watchdogPosition >= 0) this.mediaAdvancedAt = Date.now();
        this.watchdogPosition = position;
        if (Date.now() - this.mediaAdvancedAt >= 12000) {
          this.accountListening(true); this.desiredPlaying = false; this.error = '音频缓冲超时，请重试'; this.status = 'error';
          this.player.pause().catch(() => {});
          hilog.warn(0xB110, 'BiliMusicPlayer', 'Playback stalled; revision=%{public}d', this.mediaRevision);
        }
      }
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
    if (request.plugin === 'ohos-player' && request.command === 'play') this.cancelSourceSwitch?.();
    if (request.plugin === 'ohos-player' && request.command === 'webdav_put') {
      // Uploads must not queue playback controls behind a slow connection.
      this.upload(request);
      return;
    }
    if (request.plugin === 'ohos-player' && request.command === 'control') {
      const args = JSON.parse(request.payload) as Args;
      if (args.action === 'pause' || args.action === 'stop' || this.cancelSourceSwitch !== null && ['seek','rate','volume','collection'].includes(args.action ?? '')) {
        // A preparation promise must never delay a user's pause/stop intent.
        this.control(args).then(() => native.tauriOhosPluginResponse(request.id,true,JSON.stringify(new EmptyResult())))
          .catch(() => native.tauriOhosPluginResponse(request.id,false,JSON.stringify({message:'无法停止播放，请重试'} as BridgeError)));
        return;
      }
    }
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

  private async upload(request: Request): Promise<void> {
    try {
      if (this.destroyed) throw new Error('Ability is closed');
      const result = await putWebDAV(JSON.parse(request.payload) as WebDAVUpload);
      native.tauriOhosPluginResponse(request.id, true, JSON.stringify(result));
    } catch (_) {
      native.tauriOhosPluginResponse(request.id, false, JSON.stringify({ message: 'Invalid WebDAV upload' } as BridgeError));
    }
  }

  private async command(command: string, args: Args): Promise<Object> {
    if (command === 'lyrics') return this.lyrics(JSON.parse(args.data ?? '{}') as LyricsPayload);
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
    return { revision:this.mediaRevision,sequence:++this.stateSequence,seekRevision:this.seekRevision,id: this.id, status: this.status, position: Math.max(0, (this.pendingSeek >= 0 ? this.pendingSeek : this.player?.currentTime ?? 0) / 1000),
      duration: Math.max(0, (this.player?.duration ?? 0) / 1000), rate: this.rate,
      sleepDeadline: this.sleepingAt, sleepDuration: this.sleepDuration, sleepExpired: this.sleepExpired,
      stopped: this.id.length === 0, error: this.error || undefined, floatingLyricsEnabled: this.desktopLyricsEnabled };
  }

  private emit(action?: string): void {
    if (this.destroyed) return;
    const state = this.snapshot(); state.action = action;
    native.bilimusicOhosState(JSON.stringify(state));
    this.updateSessionPosition();
  }

  private updateSessionPosition(): void {
    if (!this.session) return;
    const playback: avSession.AVPlaybackState = {
      state: this.status === 'playing' ? avSession.PlaybackState.PLAYBACK_STATE_PLAY : avSession.PlaybackState.PLAYBACK_STATE_PAUSE,
      speed: this.rate, position: { elapsedTime: Math.max(0,this.player?.currentTime ?? 0), updateTime: Date.now() }
    };
    this.session.setAVPlaybackState(playback).catch(() => {});
  }

  private async lyrics(args: LyricsPayload): Promise<LyricsResult> {
    if (args.action === 'update') {
      this.lyricId = args.id ?? ''; this.lyricText = (args.lrc ?? '').slice(0,200000);
      if (this.currentMetadata?.assetId === this.lyricId) await this.setMetadata(this.mediaRevision,this.currentMetadata);
      return { supported: true, enabled: this.desktopLyricsEnabled };
    }
    const supported = deviceInfo.sdkApiVersion >= 23 && await avSession.isDesktopLyricSupported().catch(() => false);
    if (!supported) return { supported: false, enabled: false, reason: '需要支持桌面歌词的 HarmonyOS 6.1 或更新系统' };
    if (args.action === 'configure') { this.desktopLyricsLocked=args.locked === true; if(this.session) await this.session.setDesktopLyricState({isLocked:this.desktopLyricsLocked}); }
    if (args.action === 'enable') {
      await this.ensureSession();
      await this.session?.setDesktopLyricState({isLocked:this.desktopLyricsLocked});
      await this.session?.enableDesktopLyric(args.enabled === true);
      await this.session?.setDesktopLyricVisible(args.enabled === true);
      this.desktopLyricsEnabled = args.enabled === true;
      clearInterval(this.lyricTimer);
      if (this.desktopLyricsEnabled) this.lyricTimer = setInterval(() => this.updateSessionPosition(),100);
      this.emit();
    }
    return { supported, enabled: this.desktopLyricsEnabled, fontSizeSupported: false, lockSupported: true };
  }

  private enqueueControl(action: string, value: number = 0): void {
    if (action === 'pause' || action === 'stop') { this.control({action,value}).catch(() => {}); return; }
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

  private setMetadata(revision: number, metadata: avSession.AVMetadata): Promise<void> {
    this.metadataTasks = this.metadataTasks.catch(() => {}).then(async () => {
      if (revision === this.mediaRevision && !this.destroyed) {
        const merged: avSession.AVMetadata = { assetId:metadata.assetId,title:metadata.title,artist:metadata.artist,duration:metadata.duration,mediaImage:metadata.mediaImage,
          lyric:this.lyricId === metadata.assetId ? this.lyricText : '' };
        await this.session?.setAVMetadata(merged); this.currentMetadata=merged;
      }
    });
    return this.metadataTasks;
  }

  private async play(args: Args): Promise<void> {
    if (!args.url || !args.id || !/^http:\/\/127\.0\.0\.1:\d+\//.test(args.url)) throw new Error('Invalid playback source');
    if(args.seamless && this.player && this.id===args.id){await this.switchSource(args);return;}
    this.cancelSourceSwitch?.();
    const revision = ++this.mediaRevision;
    this.desiredPlaying = args.playing !== false;
    this.pendingSeek = -1;
    this.artwork.clear();
    this.accountListening(true);
    if (this.player) { await this.player.release(); this.player = null; }
    await this.ensureSession();
    if (revision !== this.mediaRevision) return;
    this.id = args.id; this.title = args.title ?? 'BiliMusic'; this.artist = args.artist ?? '';
    this.collectionRef = args.collectionRef ?? ''; this.error = ''; this.status = this.desiredPlaying ? 'buffering' : 'paused';
    this.mediaAdvancedAt = Date.now(); this.watchdogPosition = -1;
    this.rate = args.rate ?? 1; this.volume = args.volume ?? 0.7;
    this.previousPosition = -1; this.previousId = ''; this.sessionId = util.generateRandomUUID(true);
    const player = await media.createAVPlayer();
    if (revision !== this.mediaRevision) { await player.release(); return; }
    this.player = player;
    player.on('seekDone', () => { if (this.player !== player) return; this.pendingSeek = -1; this.mediaAdvancedAt = Date.now(); this.watchdogPosition = player.currentTime; this.emit(); });
    player.on('audioInterrupt', event => {
      // Pause on focus loss and unplugged outputs; never resume unexpectedly.
      if (event.hintType !== 0) this.enqueueControl('pause');
    });
    try { await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('音频准备超时，请重试')), 12000);
      this.cancelPreparation = () => { clearTimeout(timeout); reject(new Error('播放已取消')); };
      player.on('error', error => {
        if (this.player !== player) return;
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
    }); } catch(error) { if(revision !== this.mediaRevision) return; throw new Error(String(error)); } finally { this.cancelPreparation=null; }
    player.setVolume(this.volume); this.applyRate(this.rate);
    if ((args.position ?? 0) > 0) player.seek((args.position ?? 0) * 1000);
    const metadata: avSession.AVMetadata = { assetId: this.id, title: this.title, artist: this.artist, duration: player.duration };
    await this.setMetadata(revision, metadata);
    this.artworkReady = this.artwork.load(args.coverUrl, async pixels => {
      const covered: avSession.AVMetadata = { assetId: metadata.assetId, title: metadata.title, artist: metadata.artist,
        duration: metadata.duration, mediaImage: pixels };
      await this.setMetadata(revision, covered);
    });
    if (revision !== this.mediaRevision || this.player !== player) return;
    if (this.desiredPlaying) { await this.startBackground(); if (this.desiredPlaying && revision === this.mediaRevision) await player.play(); else await this.stopBackground(); }
    else { this.status = 'paused'; this.emit(); }
  }

  private async switchSource(args: Args): Promise<void> {
    const original=this.player,revision=this.mediaRevision,seek=this.seekRevision;
    if(!original || args.id!==this.id) throw new Error('当前歌曲已变更');
    const candidate=await media.createAVPlayer();let cancelled=false;let handoffRevision=-1;
    let ready: (()=>void) | null=null;let failed: ((error:Error)=>void) | null=null;let seekDone: (()=>void) | null=null;
    const cancel=()=>{cancelled=true;failed?.(new Error('音质切换已取消'));};this.cancelSourceSwitch=cancel;
    const valid=():boolean=>!cancelled && this.player===original && this.mediaRevision===revision && this.seekRevision===seek;
    candidate.on('error',error=>{if(this.player===candidate){this.error=error.message;this.status='error';this.emit();}else failed?.(new Error('新音源无法播放，已保留原音质'));});
    candidate.on('audioInterrupt',event=>{if(this.player===candidate && event.hintType!==0)this.enqueueControl('pause');});
    candidate.on('seekDone',()=>{seekDone?.();seekDone=null;if(this.player===candidate){this.pendingSeek=-1;this.emit();}});
    candidate.on('stateChange',async state=>{
      if(this.player===candidate){if(state==='playing')this.status='playing';else if(state==='paused')this.status='paused';else if(state==='completed'){this.accountListening(true);this.status='paused';this.emit('ended');return;}this.emit();return;}
      if(cancelled)return;
      try{if(state==='initialized')await candidate.prepare();else if(state==='prepared')ready?.();else if(state==='error')failed?.(new Error('新音源无法播放，已保留原音质'));}catch(error){failed?.(new Error(String(error)));}
    });
    try{
      await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('新音源准备超时，已保留原音质')),12000);ready=()=>{clearTimeout(timeout);resolve();};failed=(error:Error)=>{clearTimeout(timeout);reject(error);};candidate.url=args.url ?? '';});
      if(!valid())throw new Error('音质切换已取消');
      candidate.setVolume(0);
      const position=Math.max(0,original.currentTime);
      if(position>0)await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('新音源定位超时，已保留原音质')),5000);seekDone=()=>{clearTimeout(timeout);resolve();};failed=(error:Error)=>{clearTimeout(timeout);reject(error);};candidate.seek(position);});
      if(!valid())throw new Error('音质切换已取消');
      const rates=[0.75,1,1.25,1.75,2,0.5,1.5,3,0.25,0.125];candidate.setSpeed(rates.indexOf(this.rate) as media.PlaybackSpeed);
      this.accountListening(true);if(original.state==='playing')await original.pause();
      if(!valid())throw new Error('音质切换已取消');
      this.player=candidate;this.mediaRevision+=1;handoffRevision=this.mediaRevision;this.previousPosition=-1;this.mediaAdvancedAt=Date.now();this.watchdogPosition=-1;this.pendingSeek=-1;
      candidate.setVolume(this.volume);if(this.desiredPlaying){await this.startBackground();if(this.desiredPlaying)await candidate.play();}else this.status='paused';
      try{await original.release();}catch{}this.emit();
    }catch(error){
      if(this.player===candidate && this.mediaRevision===handoffRevision){this.player=original;this.mediaRevision+=1;this.previousPosition=-1;this.error='';}
      if(this.player===original && this.desiredPlaying && original.state==='paused'){await original.play();}
      throw new Error(String(error));
    }finally{if(this.cancelSourceSwitch===cancel)this.cancelSourceSwitch=null;if(this.player!==candidate){try{await candidate.release();}catch{}}}
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
      case 'resume': this.desiredPlaying = true; this.mediaAdvancedAt = Date.now(); this.watchdogPosition = -1; this.error = ''; if (this.player) { const player=this.player; await this.startBackground(); if(this.desiredPlaying && this.player===player) await player.play(); else await this.stopBackground(); } break;
      case 'pause':
        this.desiredPlaying = false;
        this.accountListening(true); this.status = 'paused';
        if (this.player?.state === 'playing') await this.player.pause();
        await this.stopBackground(); break;
      case 'stop':
        this.desiredPlaying = false;
        this.mediaRevision += 1; this.cancelSourceSwitch?.(); this.cancelPreparation?.(); this.artwork.clear();
        this.accountListening(true); await this.player?.release(); this.player = null;
        this.id = ''; this.status = 'paused'; await this.stopBackground(); break;
      case 'seek': this.seekRevision += 1; this.pendingSeek = Math.max(0, value * 1000); this.mediaAdvancedAt = Date.now(); this.watchdogPosition = -1; this.accountListening(true); this.previousPosition = -1; this.player?.seek(Math.max(0, value * 1000)); break;
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
    this.mediaRevision += 1; this.cancelSourceSwitch?.(); this.cancelPreparation?.(); this.artwork.clear();
    this.accountListening(true); this.destroyed = true; clearInterval(this.timer); clearInterval(this.lyricTimer);
    await this.metadataTasks.catch(() => {});
    await this.player?.release(); await this.stopBackground(); await this.session?.destroy();
  }
}
