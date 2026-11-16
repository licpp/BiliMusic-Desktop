import { AutomaticResumePolicy } from './ResumePolicy';
// System queue mirror only. URLs, metadata, resume policy and recording are
// resolved by the shared Rust executor, never by the WebView.
export interface QueueSource { provider: string; bvid: string; cid: number; page: number; aid?: number; uploaderId?: number; uploaderName?: string }
export interface QueueTrack { id: string; title: string; artist?: string; album?: string; coverUrl?: string; durationSeconds: number; source: QueueSource; resolveParts?: boolean; partCount?: number; videoTitle?: string; displayTitle?: string; chapterContext?: boolean; publishedAt?: number; playCount?: number }
export interface QueueUpdate { tracks: QueueTrack[]; repeatMode: string; shuffled: boolean; autoResume?: boolean; resumeThresholdSeconds?: number; collectionPlayback?: boolean; collectionRef?: string; accountSession: string; version: number; owner: string }
export interface ResolvePayload { track: QueueTrack; accountSession: string; restart: boolean; autoResume: boolean; resumeThresholdSeconds: number; collectionPlayback: boolean }
export interface NotificationLyricLine { timeMs: number; text: string; endTimeMs?: number }
export interface NativeLyrics { rawText: string; lines: NotificationLyricLine[]; biasMs: number }
export interface ResolveResult { lyrics?: NativeLyrics; url?: string; upgradeUrl?: string; error?: string; track?: QueueTrack; position?: number; entryId?: string; parts?: QueueTrack[]; automaticResume?: AutomaticResumePolicy }
export class NativeQueue {
  tracks: QueueTrack[] = [];
  expanded: Record<string, QueueTrack[]> = {};
  version: number = 0;
  owner: string = '';
  private retiredOwners: Set<string> = new Set();
  accountSession: string = '';
  collectionRef: string = '';
  private repeatMode: string = 'off';
  private shuffled: boolean = false;
  private autoResume: boolean = true;
  private threshold: number = 0;
  private collection: boolean = false;
  update(args: QueueUpdate): boolean {
    if (!Array.isArray(args.tracks) || args.tracks.length > 10000 || !['off','one','all'].includes(args.repeatMode) || !args.accountSession || !args.owner || !Number.isSafeInteger(args.version) || args.version <= 0) throw new Error('无效的播放队列');
    if (this.retiredOwners.has(args.owner)) return false;
    if (args.owner === this.owner && args.version <= this.version) return false;
    const previous = this.accountSession === args.accountSession ? this.expanded : {} as Record<string, QueueTrack[]>;
    const next: QueueTrack[] = [], expanded: Record<string, QueueTrack[]> = {}, seen: Set<string> = new Set();
    for (const track of args.tracks) {
      if (!track.id || !track.source || track.source.provider !== 'bilibili') throw new Error('无效的队列歌曲');
      const parts = track.resolveParts ? previous[track.id] : undefined;
      if (parts) expanded[track.id] = parts;
      for (const item of parts ?? [track]) if (!seen.has(item.id)) { seen.add(item.id); next.push(item); }
    }
    // Commit only after every entry validates; malformed mirrors cannot retire a live owner.
    if (args.owner !== this.owner && this.owner) this.retiredOwners.add(this.owner);
    this.owner = args.owner;
    this.expanded = expanded; this.tracks = next; this.version = args.version; this.accountSession = args.accountSession;
    this.repeatMode = args.repeatMode; this.shuffled = args.shuffled; this.autoResume = args.autoResume !== false;
    this.threshold = args.resumeThresholdSeconds ?? 0; this.collection = args.collectionPlayback === true; this.collectionRef = args.collectionRef ?? '';
    return true;
  }
  find(id: string): QueueTrack | undefined { return this.tracks.find(track => track.id === id); }
  target(id: string, direction: number, ended: boolean, random: number = Math.random()): QueueTrack | undefined {
    if (!this.tracks.length) return undefined;
    const index = this.tracks.findIndex(track => track.id === id);
    if (ended && this.repeatMode === 'one') return this.find(id);
    if (ended && !this.shuffled && this.repeatMode === 'off' && index === this.tracks.length - 1) return undefined;
    const target = this.shuffled && this.tracks.length > 1 ? (Math.max(0,index) + 1 + Math.floor(random * (this.tracks.length - 1))) % this.tracks.length : (index + direction + this.tracks.length) % this.tracks.length;
    return this.tracks[target];
  }
  payload(track: QueueTrack, ended: boolean): ResolvePayload {
    return {track, accountSession:this.accountSession, restart:ended && this.repeatMode === 'one', autoResume:this.autoResume, resumeThresholdSeconds:this.threshold,
      collectionPlayback:this.collection || (track.partCount ?? 0) > 1 || track.source.page > 1 || this.tracks.some(item=>item.id!==track.id && item.source.bvid===track.source.bvid)};
  }
  resolved(result: ResolveResult): void {
    if (!result.entryId || !result.parts?.length || !this.find(result.entryId)?.resolveParts) return;
    this.expanded[result.entryId] = result.parts;
    const seen: Set<string> = new Set();
    this.tracks = this.tracks.flatMap(track=>track.id===result.entryId ? result.parts! : [track]).filter(track=>{if(seen.has(track.id))return false;seen.add(track.id);return true;});
  }
}
