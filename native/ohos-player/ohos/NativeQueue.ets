import { ShuffleDeck, ShuffleItem } from '../../../src/domain/shuffle';
import { AutomaticResumePolicy } from './ResumePolicy';
// System queue mirror only. URLs, metadata, resume policy and recording are
// resolved by the shared Rust executor, never by the WebView.
export interface QueueSource { provider: string; bvid: string; cid: number; page: number; aid?: number; uploaderId?: number; uploaderName?: string }
export interface QueueTrack { id: string; title: string; artist?: string; album?: string; coverUrl?: string; durationSeconds: number; source: QueueSource; resolveParts?: boolean; partCount?: number; videoTitle?: string; displayTitle?: string; chapterContext?: boolean; publishedAt?: number; playCount?: number }
export interface QueueUpdate { offlineOnly?: boolean; entryOrder?: string[]; entryOrigins?: Record<string,string[]>; tracks: QueueTrack[]; repeatMode: string; shuffled: boolean; autoResume?: boolean; resumeThresholdSeconds?: number; collectionPlayback?: boolean; collectionRef?: string; accountSession: string; version: number; owner: string }
export interface ResolvePayload { offlineOnly?: boolean; visibilityScopes: string[]; track: QueueTrack; accountSession: string; restart: boolean; autoResume: boolean; resumeThresholdSeconds: number; collectionPlayback: boolean; subtitles?: boolean; subtitleLanguage?: string; subtitleRevision?: number }
export interface NotificationLyricLine { timeMs: number; text: string; endTimeMs?: number }
export interface NativeLyrics { rawText: string; lines: NotificationLyricLine[]; biasMs: number; subtitles?: boolean }
export interface ResolveResult { skip?: boolean; loudnessGainDb?: number; lyrics?: NativeLyrics; url?: string; upgradeUrl?: string; error?: string; errorCode?: string; track?: QueueTrack; position?: number; entryId?: string; parts?: QueueTrack[]; automaticResume?: AutomaticResumePolicy; kind?: string; id?: string; timeline?: NativeLyrics; subtitleRevision?: number }
interface SessionNeighbors { previous?: string; next?: string }
export class NativeQueue {
  private shuffle: ShuffleDeck = new ShuffleDeck();
  tracks: QueueTrack[] = [];
  expanded: Record<string, QueueTrack[]> = {};
  version: number = 0;
  owner: string = '';
  private retiredOwners: Set<string> = new Set();
  accountSession: string = '';
  collectionRef: string = '';
  private origins: Record<string,string[]> = {};
  private offlineOnly: boolean = false;
  private entryOrder: string[] = [];
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
    if (this.accountSession !== args.accountSession || this.shuffled !== args.shuffled) this.shuffle.reset();
    this.owner = args.owner;
    this.expanded = expanded; this.tracks = next; this.version = args.version; this.accountSession = args.accountSession;
    this.offlineOnly = args.offlineOnly === true;
    this.origins = args.entryOrigins ?? {};
    this.entryOrder = (args.entryOrder ?? args.tracks.map(track=>track.id)).flatMap(id=>expanded[id]?.map(track=>track.id) ?? [id]);
    for (const id of Object.keys(expanded)) {for (const part of expanded[id]) if(!this.origins[part.id]) this.origins[part.id]=this.origins[id] ?? []; }
    this.repeatMode = args.repeatMode; this.shuffled = args.shuffled; this.autoResume = args.autoResume !== false;
    this.threshold = args.resumeThresholdSeconds ?? 0; this.collection = args.collectionPlayback === true; this.collectionRef = args.collectionRef ?? '';
    return true;
  }
  find(id: string): QueueTrack | undefined { return this.tracks.find(track => track.id === id); }
  sessionNeighbors(id: string): SessionNeighbors {
    // Publishing a media card must not consume or reshuffle a random skip.
    const length = this.tracks.length;
    if (this.shuffled || length < 2) return {};
    const index = this.tracks.findIndex(track => track.id === id);
    if (index < 0) return {};
    return {
      previous: this.tracks[(index + length - 1) % length].id,
      next: this.tracks[(index + 1) % length].id
    };
  }
  target(id: string, direction: number, ended: boolean): QueueTrack | undefined {
    if (!this.tracks.length) return undefined;
    const index = this.tracks.findIndex(track => track.id === id);
    if (ended && this.repeatMode === 'one' && index>=0) return this.find(id);
    if (ended && !this.shuffled && this.repeatMode === 'off' && index === this.tracks.length - 1) return undefined;
    if (this.shuffled) {
      const target = this.shuffle.target(this.shuffleItems(),id,direction);
      return this.find(target ?? '');
    }
    const visible=this.tracks.map(track=>track.id), sequence=index>=0?visible:this.entryOrder;
    const sourceIndex=sequence.indexOf(id);
    if(sourceIndex<0)return direction>0?this.tracks[0]:this.tracks[this.tracks.length-1];
    const candidates=direction>0?sequence.slice(sourceIndex+1):sequence.slice(0,sourceIndex).reverse();
    const selected=candidates.find(candidate=>visible.includes(candidate));
    return selected?this.find(selected):!ended||this.repeatMode==='all'?(direction>0?this.tracks[0]:this.tracks[this.tracks.length-1]):undefined;
  }
  private shuffleItems(): ShuffleItem[] { return this.tracks.map((track: QueueTrack): ShuffleItem => ({id:track.id,artist:track.artist ?? '',bvid:track.source.bvid})); }
  observe(id: string): void { if (this.shuffled) this.shuffle.observe(this.shuffleItems(),id); }

  payload(track: QueueTrack, ended: boolean): ResolvePayload {
    return {offlineOnly:this.offlineOnly, visibilityScopes:this.origins[track.id] ?? [],track, accountSession:this.accountSession, restart:ended && this.repeatMode === 'one', autoResume:this.autoResume, resumeThresholdSeconds:this.threshold,
      collectionPlayback:this.collection || (track.partCount ?? 0) > 1 || track.source.page > 1 || this.tracks.some(item=>item.id!==track.id && item.source.bvid===track.source.bvid)};
  }
  skip(entry: string): QueueTrack | undefined {
    const index=this.tracks.findIndex(track=>track.id===entry);
    this.tracks=this.tracks.filter(track=>track.id!==entry);
    const retained: Record<string, QueueTrack[]> = {};
    for (const key of Object.keys(this.expanded)) if (key!==entry) retained[key]=this.expanded[key];
    this.expanded=retained;
    if (!this.tracks.length || index>=this.tracks.length && this.repeatMode!=='all') return undefined;
    return this.tracks[index>=this.tracks.length?0:Math.max(0,index)];
  }
  resolved(result: ResolveResult): void {
    if (!result.entryId || !result.parts?.length || !this.find(result.entryId)?.resolveParts) return;
    for (const part of result.parts) this.origins[part.id]=this.origins[result.entryId] ?? [];
    this.expanded[result.entryId] = result.parts;
    this.entryOrder=this.entryOrder.flatMap(id=>id===result.entryId?result.parts!.map(track=>track.id):[id]);
    const seen: Set<string> = new Set();
    this.tracks = this.tracks.flatMap(track=>track.id===result.entryId ? result.parts! : [track]).filter(track=>{if(seen.has(track.id))return false;seen.add(track.id);return true;});
  }
}
