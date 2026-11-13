import { readFloatingPreferences, useFloatingPreferences, type FloatingPreferences } from './floatingLyricsPreferences'
import { parseLrc } from '../features/lyrics/lrc'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { isMobile, isIOS, isOHOS } from './platform'
import { accountEpoch } from './accountScope'
import { getStoredLyrics, enrichStoredLyricLines, inDesktopShell, type LyricLine, type StoredLyrics } from './desktopApi'
import { usePlayerStore, playbackClock } from '../features/player/playerStore'
import { useThemeStore } from './theme'
import { storedLyricLines, systemLrc, floatingTimeline } from '../features/lyrics/lyricTimeline'
import { subtitleScope, useSubtitleState } from '../features/lyrics/useBiliSubtitles'

export type FloatingFrame = { id: string; title: string; artist: string; position: number; rate: number; playing: boolean; theme: string; lines: LyricLine[]; biasMs: number; subtitles?:boolean; fontSize?:number; locked?:boolean; activeColor?:string; inactiveColor?:string; capturedAt?:number; revision?:number }
export type FloatingCapability = { supported: boolean; enabled: boolean; permissionRequired?: boolean; fontSizeSupported?: boolean; lockSupported?: boolean; colorSupported?:boolean; reason?: string }
const plugin = isOHOS ? 'ohos-player' : isIOS ? 'ios-player' : 'android-player'
const nativeLyrics = <T>(data: object) => invoke<T>(`plugin:${plugin}|lyrics`, {data:JSON.stringify(data)})
export const useFloatingLyrics = create<{ enabled:boolean; busy:boolean; error:string }>(() => ({enabled:false,busy:false,error:''}))
export async function floatingCapability(): Promise<FloatingCapability> {
  if (!inDesktopShell) return {supported:false,enabled:false,reason:'请在客户端中开启'}
  return isMobile ? nativeLyrics({action:'status'}) : {supported:true,enabled:useFloatingLyrics.getState().enabled}
}
export async function setFloatingLyrics(enabled: boolean) {
  if (isIOS || useFloatingLyrics.getState().busy) return
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
  let revision = 0, trackKey = '', stored: StoredLyrics | null = null, lines: LyricLine[] = [], lastNative = ''
  let pending = false, dirty = false
  const currentKey = () => `${accountEpoch()}:${usePlayerStore.getState().current?.id || ''}`
  const publish = async () => {
    if (pending) { dirty = true; return }
    const state = usePlayerStore.getState(), current = state.current, style = useFloatingPreferences.getState()
    const captions=useSubtitleState.getState()
    const timeline=floatingTimeline(lines,stored?.biasMs||0,subtitleScope(current?.source),captions)
    const frame: FloatingFrame = {id:current?.id || '',title:current?.title || 'BiliMusic',artist:current?.artist || '',position:playbackClock(),rate:state.rate,playing:state.status === 'playing',theme:useThemeStore.getState().theme,...timeline,fontSize:style.fontSize,locked:style.locked,activeColor:style.activeColor,inactiveColor:style.inactiveColor,capturedAt:Date.now()}
    if (isMobile) {
      // Native renderers read their own player's clock, even with JS suspended.
      const signature = JSON.stringify([frame.id,frame.title,frame.lines,frame.biasMs,frame.subtitles,useFloatingPreferences.getState().fontSize])
      if (signature === lastNative) return
      lastNative = signature; pending = true
      try { await nativeLyrics({action:'update',...frame,lrc:systemLrc(frame.lines,frame.biasMs)}) }
      catch { if (signature === lastNative) lastNative = '' }
      finally { pending=false; if (dirty) { dirty=false; void publish() } }
    } else if (useFloatingLyrics.getState().enabled) {
      pending=true
      try { await invoke('floating_lyrics_update',{frame}) } catch { /* Window may have just closed. */ }
      finally { pending=false; if(dirty){dirty=false;void publish()} }
    }
  }
  const load = async () => {
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
  usePlayerStore.subscribe((state,previous) => {
    if (currentKey() !== trackKey) void load()
    else if (state.current?.title !== previous.current?.title || state.current?.artist !== previous.current?.artist || !isMobile && (state.status !== previous.status || state.rate !== previous.rate)) void publish()
  })
  const configure = () => { if(isIOS)return;const {fontSize,locked,activeColor,inactiveColor}=useFloatingPreferences.getState();void (isMobile ? nativeLyrics({action:'configure',fontSize,locked,activeColor,inactiveColor}) : invoke('floating_lyrics_configure',{locked})).catch(()=>undefined) }
  useFloatingPreferences.subscribe(()=>{configure();lastNative='';void publish()})
  window.addEventListener('bilimusic-floating-lyrics-change',configure)
  configure()
  useThemeStore.subscribe(() => { void publish() })
  useSubtitleState.subscribe(() => { void publish() })
  window.addEventListener('bilimusic-lyrics-updated',updated)
  window.addEventListener('bilimusic-lyric-bias',updated)
  window.addEventListener('bilimusic-floating-style',event=>{const value=(event as CustomEvent<{fontSize?:number;locked?:boolean}>).detail,current=useFloatingPreferences.getState();const patch:Partial<{fontSize:number;locked:boolean}>={};if(value.fontSize!==undefined&&value.fontSize!==current.fontSize)patch.fontSize=value.fontSize;if(value.locked!==undefined&&value.locked!==current.locked)patch.locked=value.locked;if(Object.keys(patch).length)current.update(patch)})
  window.addEventListener('bilimusic-native-floating',event=>useFloatingLyrics.setState({enabled:(event as CustomEvent<boolean>).detail}))
  window.addEventListener('bilimusic-floating-lyrics-change',()=>{lastNative='';void publish()})
  window.addEventListener('bilimusic-account-changing',()=>{++revision;stored=null;lines=[];lastNative='';void setFloatingLyrics(false);void publish()})
  if (!isMobile) {
    void listen<FloatingPreferences>('floating-lyrics-preferences',event=>{const current=useFloatingPreferences.getState(),value=readFloatingPreferences(JSON.stringify(event.payload));if(Object.entries(value).some(([key,next])=>current[key as keyof FloatingPreferences]!==next))current.update(value)})
    void listen<string>('floating-lyrics-control', event => {
      const player=usePlayerStore.getState()
      if(event.payload==='toggle')void player.toggle()
      else if(event.payload==='next')void player.next()
      else if(event.payload==='previous')void player.previous()
    })
    void listen('floating-lyrics-unlock',()=>useFloatingPreferences.getState().update({locked:false}))
    void listen('floating-lyrics-closed',()=>useFloatingLyrics.setState({enabled:false}))
    window.setInterval(()=>{if(useFloatingLyrics.getState().enabled)void publish()},250)
  }
  void load()
}
