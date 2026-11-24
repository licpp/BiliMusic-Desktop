import { OutputGain } from './OutputGain';
import { common, Want, wantAgent } from '@kit.AbilityKit';
import { avSession } from '@kit.AVSessionKit';
import { media } from '@kit.MediaKit';
import { connection } from '@kit.NetworkKit';
import { audio } from '@kit.AudioKit';
import { image } from '@kit.ImageKit';
import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { preferences } from '@kit.ArkData';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { BusinessError, deviceInfo } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { Artwork } from './Artwork';
import { AutomaticResumePolicy, playbackStartPosition } from './ResumePolicy';
import { putWebDAV, WebDAVUpload } from './WebDAV';
import native from 'libbilimusic_lib.so';
import { NativeQueue, QueueUpdate, QueueTrack, ResolveResult, NotificationLyricLine } from './NativeQueue';

interface Request { id: number; plugin: string; command: string; payload: string }
interface Args {
  data?: string; diagnosticId?: string; url?: string; upgradeUrl?: string; id?: string; title?: string; artist?: string;
  album?: string; coverUrl?: string; durationSeconds?: number;
  loudnessGainDb?: number; loudnessEnabled?: boolean; loudnessRevision?: number; settingsRevision?: number;
  position?: number; volume?: number; playing?: boolean; collectionRef?: string;
  rate?: number; seamless?: boolean; action?: string; value?: number | string; accountSession?: string;
  key?: string; remove?: boolean;
  automaticResume?: AutomaticResumePolicy; preserveSession?: boolean; request?: number;
}
interface PlaybackCapabilities {autonomousQueue: boolean; seamlessSourceSwitch: boolean; nativeSleepTimer: boolean; snapshotRebind: boolean}
interface Snapshot {
  capabilities: PlaybackCapabilities;
  engineInstanceId: string; sessionId: string; diagnosticId?: string; sourceRevision: number; autonomousQueue: boolean; queueVersion: number; track?: QueueTrack; expandedEntries?: Record<string, QueueTrack[]>;
  id: string; status: string; position: number; duration: number; rate: number;
  sleepDeadline: number; sleepDuration: number; sleepExpired: boolean;
  stopped: boolean; error?: string; errorCode?: string; action?: string; floatingLyricsEnabled?: boolean; revision?: number; sequence?: number; seekRevision?: number;
}
interface LyricsPayload { lines?: NotificationLyricLine[]; biasMs?: number; subtitles?: boolean; action: string; enabled?: boolean; id?: string; lrc?: string; language?: string; fontSize?: number; locked?: boolean }
interface LyricsResult { supported: boolean; enabled: boolean; reason?: string; fontSizeSupported?: boolean; lockSupported?: boolean }
class EmptyResult {}
interface BridgeError { message: string; code?: string }
interface SecretResult { value?: string }
interface WindowInsets { active: boolean; top: number; right: number; bottom: number; left: number }
interface DiagnosticEnvironment {
  osVersion: string;
  osBuild: string;
  apiLevel: number;
  deviceModel: string;
}
interface PlaybackDiagnosticEvent {
  operation: string; area: string; step: string; outcome: string; engine: string;
  bvid: string; cid: number; elapsedMs: number; code?: string;
}
interface PlaybackDiagnosticPayload { accountSession: string; event: PlaybackDiagnosticEvent }
interface ListeningSample {
  accountSession: string; trackId: string; seconds?: number; position?: number;
  observedAt: number; sessionId?: string; collectionRef?: string;
}

function mediaErrorCode(code?: number): string | undefined {
  return typeof code === 'number' && Number.isSafeInteger(code) ? `ohos_media:${code}` : undefined;
}

// Only Harmony system APIs live here. Search, playlists, lyrics, database and
// account/WebDAV merge logic remain in the shared React + Rust application.
export class PlayerPlugin {
  private engineInstanceId: string = util.generateRandomUUID(true);
  private queue: NativeQueue = new NativeQueue();
  private nativeRequest: number = 0;
  private pendingResolve: ((result: ResolveResult) => void) | null = null;
  private resolveTimer: number = -1;

  private cancelResolution(): void {
    this.nativeRequest += 1;
    native.bilimusicOhosCancelResolve();
    clearTimeout(this.resolveTimer);
    const pending = this.pendingResolve; this.pendingResolve = null;
    pending?.({error:'播放已取消'});
  }
  private receiveResolution(args: Args): void {
    if (args.request !== this.nativeRequest || this.destroyed) return;
    const result = JSON.parse(args.data ?? '{}') as ResolveResult;
    if (result.kind === 'lyrics') {
      const timeline = result.timeline;
      if (!this.pendingResolve && result.id === this.id && result.subtitleRevision === this.subtitleRevision && timeline &&
        (!timeline.subtitles || this.subtitlesEnabled) && (this.lyricId !== this.id || !this.lyricLines.length)) {
        this.applyLyricTimeline({action:'update',id:this.id,lines:timeline.lines,biasMs:timeline.biasMs,lrc:timeline.rawText,subtitles:timeline.subtitles}, true);
      }
      return;
    }
    if (!this.pendingResolve) return;
    clearTimeout(this.resolveTimer);
    const pending = this.pendingResolve; this.pendingResolve = null;
    pending(result);
  }
  private async advance(direction: number, ended: boolean = false, override?: QueueTrack, remote: boolean = false): Promise<void> {
    if (this.sleepExpired || this.destroyed) return;
    if (!remote && direction < 0 && (this.player?.currentTime ?? 0) > 4000) { await this.control({action:'seek',value:0}); return; }
    const track = override ?? this.queue.target(this.id, direction, ended);
    if (remote && (!track || track.id === this.id)) return;
    if (!track) { await this.control({action:'pause'}); return; }
    const accountSession = this.playbackAccount || this.queue.accountSession;
    if (accountSession !== this.queue.accountSession) { await this.control({action:'pause'}); return; }
    this.cancelResolution(); this.cancelSourceSwitch?.(); this.cancelPreparation?.();
    this.accountListening(true);
    this.sessionId = util.generateRandomUUID(true);
    this.beginDiagnostic();
    this.lyricId = '';
    const previous=this.player; this.player=null; this.pendingSeek=-1;
    const request = this.nativeRequest;
    this.setTrackMetadata(track.id, track.title, track.artist, track.album, track.durationSeconds);
    this.status = 'buffering'; this.error = ''; this.desiredPlaying = true;
    this.mediaRevision += 1; this.emit(); void this.setMetadata(this.mediaRevision);
    try {
      // Keep the system playback task alive across the silent resolution gap.
      await this.startBackground();
      await previous?.release();
      if (request !== this.nativeRequest || !this.desiredPlaying) return;
      const result = await new Promise<ResolveResult>((resolve) => {
        this.pendingResolve = resolve;
        this.resolveTimer = setTimeout(()=>{ if(request===this.nativeRequest) {native.bilimusicOhosCancelResolve();this.receiveResolution({request,data:JSON.stringify({error:'后台加载超时，请重新播放',errorCode:'source_timeout'} as ResolveResult)});} },25000);
        const payload = this.queue.payload(track, ended);
        payload.accountSession = accountSession;
        payload.diagnosticId = this.diagnosticId;
        payload.subtitles = this.subtitlesEnabled;
        payload.subtitleLanguage = this.subtitleLanguage;
        payload.subtitleRevision = this.subtitleRevision;
        native.bilimusicOhosResolve(request, JSON.stringify(payload));
      });
      if (request !== this.nativeRequest || accountSession !== this.queue.accountSession || !this.queue.find(track.id) || !this.desiredPlaying || this.destroyed) return;
      if (result.skip && result.entryId) {
        const next=this.queue.skip(result.entryId);
        if(next) {await this.advance(1,false,next);} else {await this.control({action:'pause'});}
        return;
      }
      if (result.error || !result.track || !result.url) {
        this.setPlaybackError(result.error ?? '后台播放地址无效', result.errorCode ?? (result.error ? 'source_unavailable' : 'invalid_source'));
        this.desiredPlaying = false; this.emit(); await this.stopBackground();
        return;
      }
      this.queue.resolved(result);
      if (result.lyrics?.lines.length) {
        this.applyLyricTimeline({action:'update',id:result.track.id,lines:result.lyrics.lines,biasMs:result.lyrics.biasMs,lrc:result.lyrics.rawText,subtitles:result.lyrics.subtitles}, true);
      }
      await this.play({id:result.track.id,title:result.track.title,artist:result.track.artist,album:result.track.album,durationSeconds:result.track.durationSeconds,coverUrl:result.track.coverUrl,url:result.url,upgradeUrl:result.upgradeUrl,position:result.position,
        loudnessGainDb:result.loudnessGainDb,automaticResume:result.automaticResume,collectionRef:this.queue.collectionRef,rate:this.rate,volume:this.volume,playing:true,preserveSession:true,accountSession});
    } catch(error) {
      if(request!==this.nativeRequest || !this.desiredPlaying) return;
      if (this.status !== 'error' || !this.error) {
        this.setPlaybackError('无法启动音频，请重新播放', mediaErrorCode((error as BusinessError).code) ?? 'audio_prepare_failed');
      }
      this.desiredPlaying=false; this.emit(); await this.stopBackground();
    }
  }
  private context: common.UIAbilityContext;
  private player: media.AVPlayer | null = null;
  private session: avSession.AVSession | null = null;
  private sessionActive: boolean = false;
  private sessionActivation: Promise<void> = Promise.resolve();
  private win: window.Window | null = null;
  private lightTheme: boolean = false;
  private windowAppearanceTasks: Promise<void> = Promise.resolve();
  private tasks: Promise<void> = Promise.resolve();
  private id: string = '';
  private systemTitleLyrics: boolean = false;
  private title: string = 'BiliMusic';
  private artist: string = '';
  private album: string = '';
  private listedDuration: number = 0;
  private bluetoothOutput: boolean = false;
  private status: string = 'paused';
  private desiredPlaying: boolean = false;
  private resumeAfterInterruption: boolean = false;
  private interruptionRevision: number = 0;
  private interruptionPause: Promise<void> = Promise.resolve();
  private focusDucked: boolean = false;
  private pendingUpgradeUrl: string = '';
  private upgradeAfterPosition: number = 0;
  private upgradeIntent: number = 0;
  private cancelSourceSwitch: (() => void) | null = null;
  private cancelPreparation: (() => void) | null = null;
  private outputGain: OutputGain = new OutputGain();
  private outputTimer: number = -1;
  private applyOutput(smooth: boolean = false): void {
    clearTimeout(this.outputTimer); this.outputTimer=-1;
    this.outputGain.transition(Date.now(),smooth);
    const player=this.player;
    const tick=():void => {
      if(!player || this.player!==player || this.destroyed || !['prepared','playing','paused','completed'].includes(player.state)) return;
      player.setVolume(this.outputGain.level(this.volume,this.focusDucked ? 0.2 : 1,Date.now()));
      if(this.outputGain.active(Date.now())) this.outputTimer=setTimeout(tick,20);
    };
    tick();
  }
  private volume: number = 1;
  private rate: number = 1;
  private collectionRef: string = '';
  private listeningObserved: boolean = false;
  private playbackAccount: string = '';
  private previousAccount: string = '';
  private previousId: string = '';
  private previousPosition: number = -1;
  private previousAt: number = 0;
  private positionSavedAt: number = 0;
  private initialPositionPending: boolean = false;
  private listeningSeconds: number = 0;
  private sessionId: string = util.generateRandomUUID(true);
  private sleepingAt: number = 0;
  private sleepDuration: number = 0;
  private sleepExpired: boolean = false;
  private timer: number = -1;
  private background: boolean = false;
  private destroyed: boolean = false;
  private error: string = '';
  private errorCode: string = '';
  private artwork: Artwork = new Artwork();
  private artworkReady: Promise<void> = Promise.resolve();
  private mediaRevision: number = 0;
  private mediaAdvancedAt: number = 0;
  private watchdogPosition: number = -1;
  private lyricId: string = '';
  private lyricText: string = '';
  private lyricTimer: number = -1;
  private lyricLines: NotificationLyricLine[] = [];
  private lyricBias: number = 0;
  private lyricSubtitles: boolean = false;
  private lyricFromBackground: boolean = false;
  private subtitlesEnabled: boolean = false;
  private subtitleLanguage: string = '';
  private subtitleRevision: number = 0;
  private cover: image.PixelMap | undefined = undefined;
  private coverRevision: number = 0;
  private metadataSignature: string = '';
  private metadataRetryAt: number = 0;
  private stateSequence: number = 0;
  private seekRevision: number = 0;
  private pendingSeek: number = -1;
  private currentMetadata: avSession.AVMetadata | null = null;
  private metadataTasks: Promise<void> = Promise.resolve();
  private sessionPositionPending: boolean = false;
  private sessionPositionInFlight: boolean = false;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.systemTitleLyrics = preferences.getPreferencesSync(context, {name:'bilimusic-media'}).getSync('lyricTitle',false) === true;
    this.timer = setInterval(() => {
      this.accountListening();
      if (this.player?.state === 'playing' && (this.status === 'playing' || this.status === 'buffering')) {
        const position = this.player.currentTime;
        if (position > this.watchdogPosition + 10 && this.watchdogPosition >= 0) this.mediaAdvancedAt = Date.now();
        this.watchdogPosition = position;
        if (Date.now() - this.mediaAdvancedAt >= 12000) {
          this.accountListening(true); this.desiredPlaying = false; this.setPlaybackError('音频缓冲超时，请重试', 'audio_stalled');
          this.player.pause().catch(() => {});
          hilog.warn(0xB110, 'BiliMusicPlayer', 'Playback stalled; revision=%{public}d', this.mediaRevision);
        }
      }
      if (this.sleepingAt > 0 && Date.now() >= this.sleepingAt) {
        this.sleepingAt = 0; this.sleepExpired = true;
        this.cancelResolution(); this.enqueueControl('pause');
      }
      this.maybeUpgrade();
      this.emit();
    }, 1000);
    this.lyricTimer = setInterval(() => { this.setMetadata(this.mediaRevision).catch(() => {}); },250);
  }

  async setWindow(win: window.Window): Promise<void> {
    this.win = win;
    // Keep the same window geometry when moving between library and playback.
    await win.setWindowLayoutFullScreen(true).catch(() => {});
    await this.applyBarTheme();
  }

  private applyBarTheme(lightTheme?: boolean): Promise<void> {
    const update = this.windowAppearanceTasks.then(async () => {
      if (lightTheme !== undefined) this.lightTheme = lightTheme;
      const win = this.win;
      if (!win || this.destroyed) return;

      const background = this.lightTheme ? '#F4F6FA' : '#071019';
      const text = this.lightTheme ? '#203044' : '#FFFFFF';
      const barBackground = win.getWindowProperties().isLayoutFullScreen ? '#00000000' : background;
      win.setWindowBackgroundColor(background);
      await win.setWindowSystemBarProperties({ statusBarColor: barBackground, navigationBarColor: barBackground,
        statusBarContentColor: text, navigationBarContentColor: text });
    });
    this.windowAppearanceTasks = update.catch(() => {});
    return update;
  }

  private windowInsets(): WindowInsets {
    const insets: WindowInsets = { active: false, top: 0, right: 0, bottom: 0, left: 0 };
    const win = this.win;
    if (!win || this.destroyed) return insets;
    const properties = win.getWindowProperties();
    if (!properties.isLayoutFullScreen) return insets;

    insets.active = true;
    const ui = win.getUIContext();
    const width = properties.windowRect.width;
    const height = properties.windowRect.height;
    for (const type of [window.AvoidAreaType.TYPE_SYSTEM, window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR,
      window.AvoidAreaType.TYPE_CUTOUT]) {
      const area = win.getWindowAvoidArea(type);
      // A physical cutout can report visible=false and sit away from the window edge.
      if (!area.visible && type !== window.AvoidAreaType.TYPE_CUTOUT) continue;
      if (area.topRect.height > 0) insets.top = Math.max(insets.top, area.topRect.top + area.topRect.height);
      if (area.rightRect.width > 0) insets.right = Math.max(insets.right, width - area.rightRect.left);
      if (area.bottomRect.height > 0) insets.bottom = Math.max(insets.bottom, height - area.bottomRect.top);
      if (area.leftRect.width > 0) insets.left = Math.max(insets.left, area.leftRect.left + area.leftRect.width);
    }
    insets.top = ui.px2vp(insets.top);
    insets.right = ui.px2vp(insets.right);
    insets.bottom = ui.px2vp(insets.bottom);
    insets.left = ui.px2vp(insets.left);
    return insets;
  }

  private async respondToWindowControl(request: Request, args: Args): Promise<void> {
    try {
      let result: Object = new EmptyResult();
      if (args.action === 'windowInsets') result = this.windowInsets();
      else await this.applyBarTheme(Number(args.value) === 1);
      native.tauriOhosPluginResponse(request.id, true, JSON.stringify(result));
    } catch (error) {
      native.tauriOhosPluginResponse(request.id, false, JSON.stringify({ message: String(error) } as BridgeError));
    }
  }

  dispatch(raw: string): void {
    const request = JSON.parse(raw) as Request;
    if (request.plugin === 'ohos-player' && request.command === 'diagnostic_environment') {
      const environment: DiagnosticEnvironment = {
        osVersion: deviceInfo.displayVersion,
        osBuild: deviceInfo.osFullName,
        apiLevel: deviceInfo.sdkApiVersion,
        deviceModel: deviceInfo.productModel,
      };
      native.tauriOhosPluginResponse(request.id, true, JSON.stringify(environment));
      return;
    }
    if (request.plugin === 'ohos-player' && request.command === 'resolved') { this.receiveResolution(JSON.parse(request.payload) as Args); native.tauriOhosPluginResponse(request.id,true,JSON.stringify(new EmptyResult())); return; }
    if (request.plugin === 'ohos-player' && request.command === 'queue') {
      try { const owner=this.queue.owner,session=this.queue.accountSession; if(this.queue.update(JSON.parse(request.payload) as QueueUpdate) && (owner!==this.queue.owner || session!==this.queue.accountSession || this.pendingResolve!==null && !this.queue.find(this.id))) { const pending=this.pendingResolve!==null; this.cancelResolution(); if(pending){this.desiredPlaying=false;this.status='paused';this.emit();} } native.tauriOhosPluginResponse(request.id,true,JSON.stringify(new EmptyResult())); }
      catch(error) {native.tauriOhosPluginResponse(request.id,false,JSON.stringify({message:String(error)} as BridgeError));} return;
    }
    if (request.plugin === 'ohos-player' && request.command === 'play') { this.cancelResolution(); this.upgradeIntent += 1; this.pendingUpgradeUrl = ''; this.cancelSourceSwitch?.(); }
    if (request.plugin === 'ohos-player' && request.command === 'webdav_put') {
      // Uploads must not queue playback controls behind a slow connection.
      this.upload(request);
      return;
    }
    if (request.plugin === 'ohos-player' && request.command === 'control') {
      const args = JSON.parse(request.payload) as Args;
      if (args.action === 'networkOnline') {
        try {
          native.tauriOhosPluginResponse(request.id, true, JSON.stringify(connection.hasDefaultNetSync()));
        } catch (error) {
          native.tauriOhosPluginResponse(request.id, false, JSON.stringify({ message: String(error) } as BridgeError));
        }
        return;
      }
      if (args.action === 'theme' || args.action === 'windowInsets') {
        this.respondToWindowControl(request, args);
        return;
      }
      if (args.action === 'loudness' || args.action === 'pause' || args.action === 'stop' || args.action === 'prepare' || this.cancelSourceSwitch !== null && ['seek','rate','volume','collection','loudness'].includes(args.action ?? '')) {
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
        const code = mediaErrorCode((error as BusinessError).code);
        const message = code && request.command === 'play' ? '无法启动音频，请重新播放' : String(error);
        native.tauriOhosPluginResponse(request.id, false, JSON.stringify({ message, code } as BridgeError));
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
    if (command === 'observe_listening') { this.listeningObserved = true; return new EmptyResult(); }
    if (command === 'open_url') {
      if (!args.url?.startsWith('https://bilimusic.cn/')) throw new Error('Unsupported URL');
      await this.context.startAbility({ action: 'ohos.want.action.viewData', uri: args.url }); return new EmptyResult();
    }
    if (command === 'play') { await this.play(args); return new EmptyResult(); }
    if (command === 'control') { await this.control(args); return new EmptyResult(); }
    throw new Error(`Unsupported native command: ${command}`);
  }

  private snapshot(): Snapshot {
    return { capabilities:{autonomousQueue:this.queue.accountSession.length>0,seamlessSourceSwitch:true,nativeSleepTimer:true,snapshotRebind:true},engineInstanceId:this.engineInstanceId,sessionId:this.sessionId,diagnosticId:this.diagnosticId,sourceRevision:this.mediaRevision,autonomousQueue:this.queue.accountSession.length>0,queueVersion:this.queue.version,track:this.queue.find(this.id),expandedEntries:this.queue.expanded,revision:this.mediaRevision,sequence:++this.stateSequence,seekRevision:this.seekRevision,id: this.id, status: this.status, position: Math.max(0, (this.pendingSeek >= 0 ? this.pendingSeek : this.player?.currentTime ?? 0) / 1000),
      duration: Math.max(0, (this.player?.duration ?? 0) / 1000), rate: this.rate,
      sleepDeadline: this.sleepingAt, sleepDuration: this.sleepDuration, sleepExpired: this.sleepExpired,
      stopped: this.id.length === 0, error: this.error || undefined, errorCode: this.error ? this.errorCode || undefined : undefined };
  }

  private diagnosticId: string = util.generateRandomUUID(true);
  private diagnosticSession: string = '';
  private diagnosticStarted: number = 0;
  private diagnosticPlaying: boolean = false;

  private beginDiagnostic(id?: string): void {
    this.diagnosticId = id ?? util.generateRandomUUID(true);
    this.diagnosticSession = this.queue.accountSession;
    this.diagnosticStarted = Date.now();
    this.diagnosticPlaying = false;
  }

  private diagnostic(step: string, outcome: string, code?: string): void {
    const track = this.id.split(':');
    if (!this.diagnosticSession || track.length !== 3 || track[0] !== 'bilibili') return;
    const payload: PlaybackDiagnosticPayload = {
      accountSession: this.diagnosticSession,
      event: {
        operation: this.diagnosticId, area: 'playback', step, outcome, engine: 'ohos-avplayer',
        bvid: track[1], cid: Number(track[2]), elapsedMs: Math.max(0, Date.now() - this.diagnosticStarted), code,
      },
    };
    try { native.bilimusicOhosDiagnostic(JSON.stringify(payload)); } catch (_) {}
  }

  private setPlaybackError(message: string, code: string): void {
    this.diagnostic(this.pendingResolve !== null ? 'source' : this.diagnosticPlaying ? 'control' : 'start', 'failed', code);
    this.error = message;
    this.errorCode = code;
    this.status = 'error';
  }

  private emit(action?: string): void {
    if (this.destroyed) return;
    if (this.status === 'playing' && !this.diagnosticPlaying) {
      this.diagnosticPlaying = true;
      this.diagnostic('start', 'succeeded');
    }
    const state = this.snapshot(); state.action = action;
    native.bilimusicOhosState(JSON.stringify(state));
    this.updateSessionPosition();
  }

  private updateSessionPosition(): void {
    if (!this.session || this.destroyed) return;
    this.sessionPositionPending = true;
    if (!this.sessionPositionInFlight) void this.flushSessionPosition();
  }

  private async flushSessionPosition(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.sessionPositionInFlight = true;
    try {
      // AVSession can be briefly unresponsive. Publish only the most recent
      // position or status after an outstanding request, not every sample.
      while (!this.destroyed && this.session === session && this.sessionPositionPending) {
        this.sessionPositionPending = false;
        const playback: avSession.AVPlaybackState = {
          state: !this.id ? avSession.PlaybackState.PLAYBACK_STATE_STOP : this.status === 'playing' ?
            avSession.PlaybackState.PLAYBACK_STATE_PLAY : avSession.PlaybackState.PLAYBACK_STATE_PAUSE,
          speed: this.rate, position: { elapsedTime: Math.max(0,this.player?.currentTime ?? 0), updateTime: Date.now() }
        };
        try { await session.setAVPlaybackState(playback); } catch (_) {}
      }
    } finally { this.sessionPositionInFlight = false; }
  }

  private async lyrics(args: LyricsPayload): Promise<LyricsResult> {
    if (args.action === 'system-title') {
      const store = preferences.getPreferencesSync(this.context, {name:'bilimusic-media'});
      store.putSync('lyricTitle',args.enabled === true); await store.flush();
      this.systemTitleLyrics = args.enabled === true; void this.setMetadata(this.mediaRevision);
    }
    if (args.action === 'subtitle-preference') {
      const enabled = args.enabled === true, language = args.language ?? '';
      if (enabled !== this.subtitlesEnabled || language !== this.subtitleLanguage) {
        this.subtitlesEnabled = enabled; this.subtitleLanguage = language; this.subtitleRevision += 1;
        if (this.lyricSubtitles) this.applyLyricTimeline({action:'update'}, false);
      }
    }
    if (args.action === 'update' && !(this.lyricFromBackground && this.lyricId === args.id && !args.lines?.length)) {
      this.applyLyricTimeline(args, false);
    }
    // Notification lyrics are automatic; retain compatibility with older clients.
    return { supported:false,enabled:false,reason:'当前歌词自动显示在通知栏',fontSizeSupported:false,lockSupported:false };
  }

  private applyLyricTimeline(args: LyricsPayload, fromBackground: boolean): void {
    const lrc = args.lrc ?? '';
    if (lrc.length > 16 * 1024 * 1024) {
      if (fromBackground) return;
      throw new Error('歌词内容过大');
    }
    this.lyricId = args.id ?? ''; this.lyricText = lrc.replace(/[♪♫♬♩🎵🎶]/g,'');
    this.lyricLines = (args.lines ?? []).filter(line => Number.isFinite(line.timeMs) && typeof line.text === 'string');
    this.lyricBias = Number.isFinite(args.biasMs) ? args.biasMs ?? 0 : 0; this.lyricSubtitles = args.subtitles === true;
    this.lyricFromBackground = fromBackground;
    void this.setMetadata(this.mediaRevision);
  }

  private notificationLine(): string | undefined {
    if (this.lyricId !== this.id || !this.player) return undefined;
    const time = (this.pendingSeek >= 0 ? this.pendingSeek : this.player.currentTime) - this.lyricBias;
    let low = 0, high = this.lyricLines.length;
    while (low < high) { const mid = (low + high) >>> 1; if (this.lyricLines[mid].timeMs <= time) low = mid + 1; else high = mid; }
    const active = low > 0 ? this.lyricLines[low - 1] : undefined;
    if(!active || this.lyricSubtitles && active.endTimeMs !== undefined && time >= active.endTimeMs) return undefined;
    return active.text.replace(/[♪♫♬♩🎵🎶]/g,'').trim().replace(/\s+/g,' ').slice(0,300) || undefined;
  }

  private enqueueControl(action: string, value: number = 0): void {
    if (action === 'pause' || action === 'stop') {
      void this.control({ action, value }).catch(() => {});
      return;
    }
    this.tasks = this.tasks.catch(() => {}).then(() => this.control({ action, value })).catch((error: BusinessError) => {
      this.setPlaybackError('无法控制播放，请重试', mediaErrorCode(error.code) ?? 'native_request_failed'); this.emit();
    });
  }

  private remoteSkip(direction: number): void {
    if (this.id) void this.advance(direction, false, undefined, true).catch(() => {});
  }

  private watchOutputRoute(player: media.AVPlayer): void {
    const renderer: audio.AudioRendererInfo = player.audioRendererInfo ??
      { usage: audio.StreamUsage.STREAM_USAGE_MUSIC, rendererFlags: 0 };
    try {
      const routing = audio.getAudioManager().getRoutingManager();
      this.updateOutputRoute(player, routing.getPreferredOutputDeviceForRendererInfoSync(renderer));
    } catch (_) {
      // The player reports its actual output route once the stream starts.
    }
    player.on('audioOutputDeviceChangeWithInfo', event => this.updateOutputRoute(player, event.devices));
  }

  private updateOutputRoute(player: media.AVPlayer, devices: audio.AudioDeviceDescriptors): void {
    if (this.destroyed || this.player !== player || devices.length === 0) return;
    const bluetooth = devices.some(device => device.deviceType === audio.DeviceType.BLUETOOTH_A2DP ||
      device.deviceType === audio.DeviceType.BLUETOOTH_SCO);
    if (bluetooth === this.bluetoothOutput) return;
    this.bluetoothOutput = bluetooth;
    void this.setMetadata(this.mediaRevision);
  }

  private audioInterrupted(player: media.AVPlayer, event: audio.InterruptEvent): void {
    if (this.player !== player || this.destroyed) return;
    if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_PAUSE) {
      this.diagnostic('audio-focus', 'succeeded', 'transient_loss');
      this.resumeAfterInterruption = this.resumeAfterInterruption || this.desiredPlaying;
      if (this.desiredPlaying || this.status !== 'paused') this.interruptionPause = this.control({ action: 'interruptionPause' }).catch(() => {});
    } else if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_STOP) {
      this.diagnostic('audio-focus', 'succeeded', 'loss');
      this.enqueueControl('pause');
    } else if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_RESUME && event.eventType === audio.InterruptType.INTERRUPT_TYPE_END) {
      this.diagnostic('audio-focus', 'succeeded', 'gain');
      const resume = this.resumeAfterInterruption, revision = this.interruptionRevision;
      this.resumeAfterInterruption = false;
      if (resume) this.tasks = this.tasks.catch(() => {}).then(async () => {
        await this.interruptionPause;
        if (!this.destroyed && this.player === player && revision === this.interruptionRevision) await this.control({ action: 'resume' });
      }).catch(() => {});
    } else if (event.forceType === audio.InterruptForceType.INTERRUPT_SHARE ||
        event.forceType === audio.InterruptForceType.INTERRUPT_FORCE) {
      // FORCE uses the system's own gain. Applying another gain here leaves
      // AVPlayer's volume attenuated even after the system clears its gain.
      if (event.hintType === audio.InterruptHint.INTERRUPT_HINT_DUCK && event.eventType === audio.InterruptType.INTERRUPT_TYPE_BEGIN) {
        const duck = event.forceType === audio.InterruptForceType.INTERRUPT_SHARE;
        if (duck !== this.focusDucked) { this.focusDucked = duck; this.applyOutput(); }
      } else if (this.focusDucked && event.hintType === audio.InterruptHint.INTERRUPT_HINT_UNDUCK &&
          event.eventType === audio.InterruptType.INTERRUPT_TYPE_END) {
        this.focusDucked = false; this.applyOutput();
      }
    }
  }

  private async ensureSession(revision: number): Promise<void> {
    if (!this.session) {
      this.session = await avSession.createAVSession(this.context, 'BiliMusic', 'audio');
      this.session.on('play', () => this.enqueueControl('resume'));
      this.session.on('pause', () => this.enqueueControl('pause'));
      this.session.on('stop', () => this.enqueueControl('stop'));
      this.session.on('seek', position => this.enqueueControl('seek', position / 1000));
      this.session.on('playNext', () => this.remoteSkip(1));
      this.session.on('playPrevious', () => this.remoteSkip(-1));
    }
    await this.setSessionActive(true, revision);
  }

  private setSessionActive(active: boolean, revision: number): Promise<void> {
    const update = this.sessionActivation.then(async () => {
      const session = this.session;
      if (!session || this.destroyed || revision !== this.mediaRevision || active === this.sessionActive) return;
      if (active) await session.activate();
      else await session.deactivate();
      this.sessionActive = active;
    });
    this.sessionActivation = update.catch(() => {});
    return update;
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

  private setTrackMetadata(id: string, title?: string, artist?: string, album?: string, durationSeconds?: number): void {
    this.id = id;
    this.title = title ?? 'BiliMusic';
    this.artist = artist ?? '';
    this.album = album ?? '';
    this.listedDuration = Number.isFinite(durationSeconds) ? Math.max(0, (durationSeconds ?? 0) * 1000) : 0;
    this.artwork.clear();
    this.cover = undefined; this.currentMetadata = null;
    this.metadataSignature = ''; this.metadataRetryAt = 0; this.coverRevision += 1;
  }

  private setMetadata(revision: number): Promise<void> {
    this.metadataTasks = this.metadataTasks.catch(() => {}).then(async () => {
      if (revision !== this.mediaRevision || this.destroyed || !this.session || !this.id) return;
      // Build from live authoritative state when the queued task executes. A
      // lyric update queued before image decoding must never erase that image.
      const currentLine = this.notificationLine() ?? '';
      const title = this.systemTitleLyrics && currentLine ? currentLine : this.title;
      const artist = !this.bluetoothOutput && !this.systemTitleLyrics && currentLine ? currentLine : this.artist;
      const actualDuration = this.player?.duration ?? 0;
      const duration = actualDuration > 0 ? actualDuration : this.listedDuration;
      const lyric = this.lyricId === this.id ? this.lyricText : '';
      const neighbors = this.queue.sessionNeighbors(this.id);
      const signature = JSON.stringify([revision, this.id, title, artist, this.album, duration, this.coverRevision,
        lyric, currentLine, neighbors.previous, neighbors.next]);
      if(signature === this.metadataSignature || Date.now() < this.metadataRetryAt) return;
      const merged: avSession.AVMetadata = { assetId: this.id, title, artist, duration, lyric };
      if (this.album) merged.album = this.album;
      if (currentLine || this.currentMetadata?.singleLyricText) merged.singleLyricText = currentLine;
      if (neighbors.previous) merged.previousAssetId = neighbors.previous;
      if (neighbors.next) merged.nextAssetId = neighbors.next;
      // Native AVSession validates property presence, not just its TS type.
      // An explicitly present undefined image rejects the entire media card.
      if(this.cover !== undefined) merged.mediaImage=this.cover;
      try {
        await this.session.setAVMetadata(merged);
        if(revision === this.mediaRevision) { this.currentMetadata=merged;this.metadataSignature=signature; }
      } catch(error) {
        if (revision !== this.mediaRevision || this.destroyed) return;
        this.metadataRetryAt=Date.now()+2000;
        hilog.warn(0xB110,'BiliMusicPlayer','Media metadata update failed; code=%{public}d',(error as BusinessError).code ?? -1);
      }
    });
    return this.metadataTasks;
  }

  private async play(args: Args): Promise<void> {
    if (!args.url || !args.id || !/^http:\/\/127\.0\.0\.1:\d+\//.test(args.url)) throw new Error('Invalid playback source');
    if(args.loudnessEnabled !== undefined) this.outputGain.configure(args.loudnessEnabled,args.loudnessRevision ?? 0);
    if(args.seamless && this.player && this.id===args.id){await this.switchSource(args);return;}
    this.resumeAfterInterruption = false; this.interruptionRevision += 1; this.focusDucked = false;
    this.cancelSourceSwitch?.();
    const revision = ++this.mediaRevision;
    if (!args.preserveSession) this.beginDiagnostic(args.diagnosticId);
    this.desiredPlaying = args.playing !== false;
    this.pendingUpgradeUrl = /^http:\/\/127\.0\.0\.1:\d+\//.test(args.upgradeUrl ?? '') ? args.upgradeUrl! : '';
    this.upgradeAfterPosition = (args.position ?? 0) * 1000 + 750;
    this.accountListening(true);
    this.playbackAccount = args.accountSession ?? this.queue.accountSession;
    this.pendingSeek = -1;
    this.initialPositionPending = true;
    const previous = this.player; this.player = null;
    this.setTrackMetadata(args.id, args.title, args.artist, args.album, args.durationSeconds);
    this.diagnostic("start", "started");
    this.collectionRef = args.collectionRef ?? ''; this.error = ''; this.status = this.desiredPlaying ? 'buffering' : 'paused';
    await previous?.release();
    if (revision !== this.mediaRevision) return;
    await this.ensureSession(revision);
    if (revision !== this.mediaRevision) return;
    this.queue.observe(args.id);
    this.mediaAdvancedAt = Date.now(); this.watchdogPosition = -1;
    this.rate = args.rate ?? 1; this.volume = Math.max(0,Math.min(1,args.volume ?? 1));
    this.outputGain.plan(args.loudnessGainDb ?? 0);
    this.previousPosition = -1; this.previousId = ''; if(!args.preserveSession) this.sessionId = util.generateRandomUUID(true);
    const player = await media.createAVPlayer();
    if (revision !== this.mediaRevision) { await player.release(); return; }
    this.player = player;
    this.watchOutputRoute(player);
    void this.setMetadata(revision);
    let initialSeekDone: (() => void) | null = null;
    player.on('seekDone', () => { if (this.player !== player) return; this.pendingSeek = -1; this.mediaAdvancedAt = Date.now(); this.watchdogPosition = player.currentTime; initialSeekDone?.(); this.emit(); });
    player.on('audioInterrupt', event => this.audioInterrupted(player, event));
    try { await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('音频准备超时，请重试')), 12000);
      this.cancelPreparation = () => { clearTimeout(timeout); reject(new Error('播放已取消')); };
      player.on('error', error => {
        if (this.player !== player) return;
        hilog.error(0xB110, 'BiliMusicPlayer', 'AVPlayer error code=%{public}d', error.code);
        clearTimeout(timeout); this.accountListening(true);
        this.setPlaybackError('音频加载失败，请重新播放', mediaErrorCode(error.code) ?? 'audio_prepare_failed'); this.emit();
        reject(error);
      });
      // AVPlayer retains one callback per event. Register preparation and live
      // playback transitions together so the ready callback cannot replace them.
      player.on('stateChange', async state => {
        if (this.player !== player) return;
        hilog.info(0xB110, 'BiliMusicPlayer', 'AVPlayer state=%{public}s', state);
        try {
          if (state === 'initialized') { await player.prepare(); return; }
          if (state === 'prepared') { this.diagnostic('media-ready', 'succeeded'); clearTimeout(timeout); resolve(); return; }
          if (state === 'playing') this.status = 'playing';
          else if (state === 'paused') { this.accountListening(true); this.status = 'paused'; }
          else if (state === 'completed') {
            this.accountListening(true); this.status = 'paused'; this.previousPosition = -1;
            this.emit(); void this.advance(1,true); return;
          }
          else if (state === 'error') {
            clearTimeout(timeout); reject(new Error('音频无法播放')); return;
          }
          this.emit();
        } catch (error) { clearTimeout(timeout); reject(new Error(String(error))); }
      });
      player.url = args.url ?? '';
    }); } catch(error) { if(revision !== this.mediaRevision) return; throw error as Error; } finally { this.cancelPreparation=null; }
    this.applyOutput(); this.applyRate(this.rate);
    const position = playbackStartPosition(args.position ?? 0, player.duration / 1000, args.automaticResume);
    this.upgradeAfterPosition = position * 1000 + 750;
    if (position > 0) {
      this.pendingSeek = position * 1000;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { initialSeekDone = null; reject(new Error('音频定位超时，请重试')); }, 5000);
        initialSeekDone = () => { clearTimeout(timeout); initialSeekDone = null; resolve(); };
        player.seek(position * 1000);
      });
    }
    if (revision !== this.mediaRevision || this.player !== player) return;
    this.initialPositionPending = false;
    // The system media card, including a stalled AVSession service, must not
    // delay audio that AVPlayer has already prepared. Revision checks in
    // setMetadata prevent the queued card from publishing earlier track data.
    void this.setMetadata(revision);
    this.artworkReady = this.artwork.load(args.coverUrl, async pixels => {
      if(revision !== this.mediaRevision || this.player !== player) return;
      this.cover=pixels;this.coverRevision+=1;
      await this.setMetadata(revision);
    });
    if (revision !== this.mediaRevision || this.player !== player) return;
    if (this.desiredPlaying) { await this.startBackground(); if (this.desiredPlaying && revision === this.mediaRevision) await player.play(); else await this.stopBackground(); }
    else { this.status = 'paused'; this.emit(); }
  }

  private maybeUpgrade(): void {
    if (!this.pendingUpgradeUrl || !this.player || !this.desiredPlaying || this.focusDucked || this.status !== 'playing' || this.player.currentTime < this.upgradeAfterPosition || this.pendingSeek >= 0 || this.cancelSourceSwitch !== null) return;
    const url = this.pendingUpgradeUrl, player = this.player, revision = this.mediaRevision, intent = this.upgradeIntent;
    this.pendingUpgradeUrl = '';
    this.tasks = this.tasks.catch(() => {}).then(async () => {
      if (this.destroyed || !this.desiredPlaying || this.focusDucked || this.player !== player || revision !== this.mediaRevision || intent !== this.upgradeIntent) return;
      await this.switchSource({url,id:this.id,seamless:true});
    }).catch(() => { /* Keep playing the initial stream. */ });
  }

  private async switchSource(args: Args): Promise<void> {
    this.pendingUpgradeUrl = '';
    const original=this.player,revision=this.mediaRevision,seek=this.seekRevision;
    if(!original || args.id!==this.id) throw new Error('当前歌曲已变更');
    const candidate=await media.createAVPlayer();let cancelled=false;let handoffRevision=-1;let originalDucked=false;
    let ready: (()=>void) | null=null;let failed: ((error:Error)=>void) | null=null;let seekDone: ((position:number)=>void) | null=null;
    const cancel=()=>{cancelled=true;failed?.(new Error('音质切换已取消'));};this.cancelSourceSwitch=cancel;
    const valid=():boolean=>!cancelled && this.player===original && this.mediaRevision===revision && this.seekRevision===seek;
    candidate.on('error',error=>{if(this.player===candidate){this.setPlaybackError('音频加载失败，请重新播放',mediaErrorCode(error.code) ?? 'audio_prepare_failed');this.emit();}else failed?.(new Error('新音源无法播放，已保留原音质'));});
    candidate.on('audioInterrupt',event=>this.audioInterrupted(candidate,event));
    candidate.on('seekDone',position=>{seekDone?.(position);seekDone=null;if(this.player===candidate){this.pendingSeek=-1;this.emit();}});
    candidate.on('stateChange',async state=>{
      if(this.player===candidate){if(state==='playing')this.status='playing';else if(state==='paused')this.status='paused';else if(state==='completed'){this.accountListening(true);this.status='paused';this.emit();void this.advance(1,true);return;}this.emit();return;}
      if(cancelled)return;
      try{if(state==='initialized')await candidate.prepare();else if(state==='prepared')ready?.();else if(state==='error')failed?.(new Error('新音源无法播放，已保留原音质'));}catch(error){failed?.(new Error(String(error)));}
    });
    try{
      await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('新音源准备超时，已保留原音质')),12000);ready=()=>{clearTimeout(timeout);resolve();};failed=(error:Error)=>{clearTimeout(timeout);reject(error);};candidate.url=args.url ?? '';});
      if(!valid())throw new Error('音质切换已取消');
      candidate.setVolume(0);
      const deadline = Date.now() + 5000;
      let aligned = candidate.currentTime;
      while (Math.abs(original.currentTime - aligned) > 250) {
        if (!valid()) throw new Error('音质切换已取消');
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('新音源定位超时，已保留原音质');
        const position = Math.max(0, original.currentTime);
        aligned = await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('新音源定位超时，已保留原音质')), remaining);
          seekDone = offset => { clearTimeout(timeout); resolve(offset); };
          failed = (error:Error) => { clearTimeout(timeout); reject(error); };
          try { candidate.seek(position, media.SeekMode.SEEK_CLOSEST); }
          catch (error) { failed?.(new Error(String(error))); }
        });
      }
      if (!valid()) throw new Error('音质切换已取消');
      if(this.resumeAfterInterruption)throw new Error('音频被系统中断，已保留原音质');
      const rates=[0.75,1,1.25,1.75,2,0.5,1.5,3,0.25,0.125];candidate.setSpeed(rates.indexOf(this.rate) as media.PlaybackSpeed);
      this.accountListening(true);if(original.state==='playing')await original.pause();
      if(!valid() || this.resumeAfterInterruption)throw new Error('音质切换已取消');
      originalDucked=this.focusDucked;this.focusDucked=false;
      this.resumeAfterInterruption=false;this.interruptionRevision+=1;
      this.player=candidate;this.mediaRevision+=1;handoffRevision=this.mediaRevision;this.previousPosition=-1;this.mediaAdvancedAt=Date.now();this.watchdogPosition=-1;this.pendingSeek=-1;
      this.watchOutputRoute(candidate);
      if(args.loudnessGainDb !== undefined) this.outputGain.plan(args.loudnessGainDb); this.applyOutput();if(this.desiredPlaying){await this.startBackground();if(this.desiredPlaying)await candidate.play();}else this.status='paused';
      try{await original.release();}catch{}this.emit();
    }catch(error){
      if(this.player===candidate && this.mediaRevision===handoffRevision){this.player=original;this.mediaRevision+=1;this.previousPosition=-1;this.error='';this.focusDucked=originalDucked;this.applyOutput();}
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
    if (args.action === 'pause' || args.action === 'stop') this.cancelResolution();
    if (args.action === 'pause' || args.action === 'stop' || args.action === 'resume') {
      this.resumeAfterInterruption = false; this.interruptionRevision += 1;
    }
    if (args.action === 'pause' || args.action === 'stop' || args.action === 'seek') this.upgradeIntent += 1;
    switch (args.action) {
      case 'prepare': {
        this.cancelResolution(); this.cancelPreparation?.(); this.accountListening(true);
        this.playbackAccount = ''; this.initialPositionPending = true;
        this.desiredPlaying = false;
        const previous = this.player; this.player = null;
        const revision = ++this.mediaRevision;
        this.setTrackMetadata(args.id ?? '', args.title, args.artist, args.album, args.durationSeconds);
        this.status = 'buffering'; void this.setMetadata(revision);
        await previous?.release();
        if (revision !== this.mediaRevision) return;
        break;
      }
      case 'next': await this.advance(1); break;
      case 'previous': await this.advance(-1); break;
      case 'resume': this.desiredPlaying = true; this.mediaAdvancedAt = Date.now(); this.watchdogPosition = -1; this.error = ''; if (this.player) { const player=this.player; await this.startBackground(); if(this.desiredPlaying && this.player===player) await player.play(); else await this.stopBackground(); } break;
      case 'pause':
      case 'interruptionPause':
        this.desiredPlaying = false;
        this.accountListening(true); this.status = 'paused';
        if (this.player?.state === 'playing') await this.player.pause();
        await this.stopBackground(); break;
      case 'stop': {
        this.pendingUpgradeUrl = '';
        this.desiredPlaying = false;
        const revision = ++this.mediaRevision;
        this.cancelSourceSwitch?.(); this.cancelPreparation?.(); this.accountListening(true);
        const previous = this.player; this.player = null;
        this.setTrackMetadata('');
        this.pendingSeek = -1; this.status = 'paused';
        void this.setSessionActive(false, revision).catch(() => {});
        await previous?.release();
        if (revision !== this.mediaRevision) return;
        await this.stopBackground();
        break;
      }
      case 'seek': this.seekRevision += 1; this.pendingSeek = Math.max(0, value * 1000); this.mediaAdvancedAt = Date.now(); this.watchdogPosition = -1; this.accountListening(true); this.previousPosition = -1; this.player?.seek(Math.max(0, value * 1000)); break;
      case 'loudness': if(this.outputGain.configure(value > 0,args.settingsRevision ?? 0)) this.applyOutput(true); break;
      case 'volume': this.volume = Math.max(0, Math.min(1, value)); this.applyOutput(); break;
      case 'rate': this.accountListening(true); this.applyRate(value); break;
      case 'collection':
        if (args.id === this.id) { this.accountListening(true); this.collectionRef = args.collectionRef ?? ''; } break;
      case 'sleepStart':
        if (value < 1 || value > 10800) throw new Error('无效的定时长度');
        this.sleepDuration = value; this.sleepingAt = Date.now() + value * 1000; this.sleepExpired = false; break;
      case 'sleepRepeat':
        if (!this.sleepExpired || this.sleepDuration <= 0 || !this.id) break;
        this.sleepingAt = Date.now() + this.sleepDuration * 1000; this.sleepExpired = false;
        await this.control({ action: 'resume' }); break;
      case 'sleepDismiss': this.sleepExpired = false; break;
      case 'sleepCancel': this.sleepingAt = 0; this.sleepExpired = false; break;
      default: throw new Error(`Unsupported playback action: ${args.action}`);
    }
    this.emit();
  }

  private accountListening(flush: boolean = false): void {
    const accountSession = this.playbackAccount;
    if (!this.listeningObserved || !accountSession) return;
    const now = Date.now();
    const position = this.status === 'playing' ? Math.max(0, (this.player?.currentTime ?? 0) / 1000) : -1;
    if (accountSession === this.previousAccount && this.id === this.previousId && position >= 0 && this.previousPosition >= 0) {
      const elapsed = Math.max(0, (now - this.previousAt) / 1000);
      const advanced = Math.max(0, (position - this.previousPosition) / this.rate);
      // Ignore seeks and large scheduling gaps; listening time never counts a jump.
      if (elapsed <= 5 && advanced <= elapsed + 0.5) this.listeningSeconds += Math.min(advanced, elapsed);
    } else {
      this.flushListening(this.previousAccount, this.previousId, now);
      this.sessionId = util.generateRandomUUID(true);
    }
    this.previousAccount = accountSession; this.previousId = this.id; this.previousPosition = position; this.previousAt = now;
    if (flush || this.listeningSeconds >= 15) this.flushListening(accountSession, this.id, now);
    if (!this.initialPositionPending && (flush || now - this.positionSavedAt >= 15000) && this.id) {
      this.positionSavedAt = now;
      const state = this.snapshot();
      const saved = state.position < 1 || (state.duration > 0 && state.position >= state.duration - 1) ? 0 : state.position;
      const sample: ListeningSample = { accountSession, trackId: this.id, position: saved,
        observedAt: now, collectionRef: this.collectionRef || undefined };
      native.bilimusicOhosListening(JSON.stringify(sample));
    }
  }

  private flushListening(accountSession: string, id: string, now: number): void {
    const seconds = this.listeningSeconds; this.listeningSeconds = 0;
    if (!accountSession || !id || seconds <= 0) return;
    const sample: ListeningSample = { accountSession, trackId: id, seconds, observedAt: now, sessionId: this.sessionId };
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
    this.cancelResolution();
    this.mediaRevision += 1; this.cancelSourceSwitch?.(); this.cancelPreparation?.(); this.artwork.clear();
    clearTimeout(this.outputTimer);
    this.accountListening(true); this.destroyed = true; clearInterval(this.timer); clearInterval(this.lyricTimer);
    await this.metadataTasks.catch(() => {});
    await this.sessionActivation;
    await this.player?.release(); await this.stopBackground(); await this.session?.destroy();
  }
}
