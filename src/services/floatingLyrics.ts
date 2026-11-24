import { lyricDisplayText } from '../domain/lyricDisplay'
import { readFloatingPreferences, useFloatingPreferences, type FloatingPreferences } from './floatingLyricsPreferences'
import { parseLrc } from '../domain/lrc'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { isAndroid, isMobile, isIOS, isOHOS } from './platform'
import { accountEpoch } from './accountScope'
import { getStoredLyrics, enrichStoredLyricLines, inDesktopShell } from './desktopApi'
import type { LyricLine, StoredLyrics } from '../domain/lyrics'
import { usePlayerStore, playbackClock, nativeLyricPlaybackSession } from '../features/player/playerStore'
import { useThemeStore } from './theme'
import { storedLyricLines, systemLrc, floatingTimeline } from '../domain/lyricTimeline'
import { subtitleScope, useSubtitleState } from '../features/lyrics/useBiliSubtitles'
import { readSubtitlePreference } from './subtitlePreference'

export type FloatingFrame = { id: string; title: string; artist: string; position: number; rate: number; playing: boolean; theme: string; lines: LyricLine[]; biasMs: number; subtitles?:boolean; fontSize?:number; locked?:boolean; activeColor?:string; inactiveColor?:string; alignment?:FloatingPreferences['alignment']; capturedAt?:number; revision?:number }
export type FloatingCapability = { supported: boolean; enabled: boolean; permissionRequired?: boolean; fontSizeSupported?: boolean; lockSupported?: boolean; colorSupported?:boolean; reason?: string }
const plugin = isOHOS ? 'ohos-player' : isIOS ? 'ios-player' : 'android-player'
const nativeLyrics = <T>(data: object) => invoke<T>(`plugin:${plugin}|lyrics`, {data:JSON.stringify(data)})
export const useFloatingLyrics = create<{ enabled:boolean; busy:boolean; error:string }>(() => ({enabled:false,busy:false,error:''}))
export async function floatingCapability(): Promise<FloatingCapability> {
  if (!inDesktopShell) return {supported:false,enabled:false,reason:'请在客户端中开启'}
  return isMobile ? nativeLyrics({action:'status'}) : {supported:true,enabled:useFloatingLyrics.getState().enabled}
}
export async function setFloatingLyrics(enabled: boolean) {
  if (isIOS || isOHOS || useFloatingLyrics.getState().busy) return
  const epoch=accountEpoch()
  useFloatingLyrics.setState({busy:true,error:''})
  try {
    if (isMobile) {
      const result = await nativeLyrics<FloatingCapability>({action:'enable',enabled,requestPermission:true})
      if (enabled && !result.enabled) throw new Error(result.reason || (result.permissionRequired ? '请允许悬浮窗权限，然后重新开启' : '此设备暂不支持悬浮歌词'))
    } else await invoke('floating_lyrics_enable',{enabled})
    if(epoch===accountEpoch())useFloatingLyrics.setState({enabled})
    window.dispatchEvent(new Event('bilimusic-floating-lyrics-change'))
  } catch (cause) {
    useFloatingLyrics.setState({error:typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '无法开启悬浮歌词，请重试'})
  } finally {
    if(epoch!==accountEpoch()) {
      try { if(isMobile)await nativeLyrics({action:'enable',enabled:false});else await invoke('floating_lyrics_enable',{enabled:false}) } catch {}
      useFloatingLyrics.setState({enabled:false})
    }
    useFloatingLyrics.setState({busy:false})
  }
}

export function startFloatingLyrics() {
  if (!inDesktopShell) return
  let disposed = false
  const stop: (() => void)[] = []
  const onWindow = (type: string, callback: EventListener) => {
    window.addEventListener(type, callback)
    stop.push(() => window.removeEventListener(type, callback))
  }
  const onDesktop = <T,>(type: string, callback: (payload: T) => void) => {
    const subscription = listen<T>(type, ({ payload }) => { if (!disposed) callback(payload) }).catch(() => undefined)
    stop.push(() => { void subscription.then(unlisten => unlisten?.()).catch(() => undefined) })
  }
  let revision = 0, trackKey = '', stored: StoredLyrics | null = null, lines: LyricLine[] = [], lastNative = ''
  let pending = false, dirty = false
  let displaySource: LyricLine[] | undefined, displayLines: LyricLine[] = [], timelineRevision = 0
  const currentKey = () => {
    const id = usePlayerStore.getState().current?.id || ''
    return `${accountEpoch()}:${id}:${isAndroid ? nativeLyricPlaybackSession(id) ?? '' : ''}`
  }
  const publish = async () => {
    if (disposed) return
    if (pending) { dirty = true; return }
    const state = usePlayerStore.getState(), current = state.current, style = useFloatingPreferences.getState()
    const captions=useSubtitleState.getState()
    const sourceTimeline=floatingTimeline(lines,stored?.biasMs||0,subtitleScope(current?.source),captions)
    if (sourceTimeline.lines !== displaySource) {
      displaySource=sourceTimeline.lines; timelineRevision++
      displayLines=displaySource.map(line=>({...line,text:lyricDisplayText(line.text),words:line.words?.map(word=>({...word,text:lyricDisplayText(word.text)}))}))
    }
    const timeline={...sourceTimeline,lines:displayLines}
    const frame: FloatingFrame = {id:current?.id || '',title:current?.title || 'BiliMusic',artist:current?.artist || '',position:playbackClock(),rate:state.rate,playing:state.status === 'playing',theme:useThemeStore.getState().theme,...timeline,fontSize:style.fontSize,locked:style.locked,activeColor:style.activeColor,inactiveColor:style.inactiveColor,alignment:style.alignment,capturedAt:Date.now()}
    if (isMobile) {
      // Native renderers read their own player's clock, even with JS suspended.
      const session = isAndroid ? nativeLyricPlaybackSession(frame.id) : undefined
      // Android can already hold lyrics from its native background lookup. Only
      // publish a resolved timeline for the same playing session from the WebView.
      if (isAndroid && (!session || !frame.lines.length)) return
      const signature = JSON.stringify([session,frame.id,frame.title,timelineRevision,frame.biasMs,frame.subtitles,useFloatingPreferences.getState().fontSize])
      if (signature === lastNative) return
      lastNative = signature; pending = true
      try {
        if (isIOS) {
          const lines = frame.lines.map(({ timeMs, endTimeMs, text }) => ({ timeMs, endTimeMs, text }))
          await nativeLyrics({ action: 'update', id: frame.id, lines, biasMs: frame.biasMs, subtitles: frame.subtitles })
        } else {
          await nativeLyrics({action:'update',session,...frame,lrc:systemLrc(frame.lines,frame.biasMs)})
        }
      }
      catch { if (signature === lastNative) lastNative = '' }
      finally { pending=false; if (dirty) { dirty=false; void publish() } }
    } else if (useFloatingLyrics.getState().enabled) {
      pending=true
      try { await invoke('floating_lyrics_update',{frame}) } catch { /* Window may have just closed. */ }
      finally { pending=false; if(dirty){dirty=false;void publish()} }
    }
  }
  const load = async () => {
    if (disposed) return
    const key = currentKey(), request = ++revision
    trackKey=key; stored=null; lines=[]; void publish()
    const id = usePlayerStore.getState().current?.id
    if (!id) return
    try {
      const saved = await getStoredLyrics(id)
      if (request !== revision || key !== currentKey()) return
      stored=saved; lines=saved && parseLrc(saved.rawText).length ? storedLyricLines(saved) : []; void publish()
      if (saved && lines.length && !lines.some(line=>line.words?.length)) {
        const enriched = await enrichStoredLyricLines(saved)
        if (request !== revision || key !== currentKey()) return
        if (enriched) { lines=enriched; void publish() }
      }
    } catch { /* A lyric lookup must never interrupt music. */ }
  }
  const updated = (event: Event) => {
    const saved = (event as CustomEvent<StoredLyrics>).detail
    if (saved.trackId !== usePlayerStore.getState().current?.id) return
    ++revision; stored=saved; lines=parseLrc(saved.rawText).length ? storedLyricLines(saved) : []; void publish()
  }
  stop.push(usePlayerStore.subscribe((state,previous) => {
    if (currentKey() !== trackKey) void load()
    else if (state.current?.title !== previous.current?.title || state.current?.artist !== previous.current?.artist ||
      isIOS && state.status === 'playing' && previous.status !== 'playing' ||
      !isMobile && (state.status !== previous.status || state.rate !== previous.rate)) void publish()
  }))
  const configure = () => { if(isIOS||isOHOS)return;const {fontSize,locked,showUnlockButton,activeColor,inactiveColor,alignment}=useFloatingPreferences.getState();void (isMobile ? nativeLyrics({action:'configure',fontSize,locked,showUnlockButton,activeColor,inactiveColor,alignment}) : invoke('floating_lyrics_configure',{locked})).catch(()=>undefined) }
  stop.push(useFloatingPreferences.subscribe(()=>{configure();lastNative='';void publish()}))
  onWindow('bilimusic-floating-lyrics-change',configure)
  configure()
  stop.push(useThemeStore.subscribe(() => { void publish() }))
  stop.push(useSubtitleState.subscribe(() => { void publish() }))
  onWindow('bilimusic-lyrics-updated',updated)
  onWindow('bilimusic-lyric-bias',updated)
  onWindow('bilimusic-floating-style',event=>{const value=(event as CustomEvent<{fontSize?:number;locked?:boolean}>).detail,current=useFloatingPreferences.getState();const patch:Partial<{fontSize:number;locked:boolean}>={};if(value.fontSize!==undefined&&value.fontSize!==current.fontSize)patch.fontSize=value.fontSize;if(value.locked!==undefined&&value.locked!==current.locked)patch.locked=value.locked;if(Object.keys(patch).length)current.update(patch)})
  onWindow('bilimusic-native-floating',event=>useFloatingLyrics.setState({enabled:(event as CustomEvent<boolean>).detail}))
  onWindow('bilimusic-floating-lyrics-change',()=>{lastNative='';void publish()})
  onWindow('bilimusic-account-changing',()=>{++revision;stored=null;lines=[];lastNative='';void setFloatingLyrics(false);void publish()})
  if (!isMobile) {
    onDesktop<FloatingPreferences>('floating-lyrics-preferences',payload=>{const current=useFloatingPreferences.getState(),value=readFloatingPreferences(JSON.stringify(payload));if(Object.entries(value).some(([key,next])=>current[key as keyof FloatingPreferences]!==next))current.update(value)})
    onDesktop<string>('floating-lyrics-control', action => {
      const player=usePlayerStore.getState()
      if(action==='toggle')void player.toggle()
      else if(action==='next')void player.next()
      else if(action==='previous')void player.previous()
    })
    onDesktop('floating-lyrics-unlock',()=>useFloatingPreferences.getState().update({locked:false}))
    onDesktop('floating-lyrics-closed',()=>useFloatingLyrics.setState({enabled:false}))
    const timer = window.setInterval(()=>{if(useFloatingLyrics.getState().enabled)void publish()},250)
    stop.push(() => window.clearInterval(timer))
  }
  if (isMobile && !isIOS) void setSystemTitleLyrics(localStorage.getItem('system-title-lyrics') === 'true').catch(() => undefined)
  if (isMobile) {
    let pendingSubtitles = Promise.resolve<unknown>(undefined)
    const syncSubtitles = () => {
      const enabled = localStorage.getItem('lyrics-subtitles') === 'true'
      const language = readSubtitlePreference()?.language ?? ''
      pendingSubtitles = pendingSubtitles.then(() => !disposed && nativeLyrics({ action: 'subtitle-preference', enabled, language }))
        .catch(() => undefined)
    }
    onWindow('bilimusic-subtitle-preference', syncSubtitles)
    syncSubtitles()
  }
  void load()
  return () => {
    if (disposed) return
    disposed = true
    ++revision
    for (const unsubscribe of stop) unsubscribe()
  }
}

let systemTitleWrite: Promise<void> = Promise.resolve()
export function setSystemTitleLyrics(enabled: boolean) {
  if (!isMobile || isIOS) return Promise.resolve()
  const write = systemTitleWrite.catch(() => undefined).then(async () => {
    await nativeLyrics({ action: 'system-title', enabled })
    localStorage.setItem('system-title-lyrics', String(enabled))
  })
  systemTitleWrite = write
  return write
}
