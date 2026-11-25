import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { lyricDisplayText } from '../../domain/lyricDisplay'
import { storedLyricLines, systemLrc, floatingTimeline } from '../../domain/lyricTimeline'
import { parseLrc } from '../../domain/lrc'
import type { LyricLine, StoredLyrics } from '../../domain/lyrics'
import { accountEpoch } from '../../services/accountScope'
import { getStoredLyrics, enrichStoredLyricLines, inDesktopShell } from '../../services/desktopApi'
import { nativeLyrics, setFloatingLyrics, setSystemTitleLyrics, useFloatingLyrics, type FloatingFrame } from '../../services/floatingLyrics'
import { readFloatingPreferences, useFloatingPreferences, type FloatingPreferences } from '../../services/floatingLyricsPreferences'
import { isAndroid, isMobile, isIOS, isOHOS } from '../../services/platform'
import { readSubtitlePreference } from '../../services/subtitlePreference'
import { useThemeStore } from '../../services/theme'
import { usePlayerStore, playbackClock, nativeLyricPlaybackSession } from '../player/playerStore'
import { subtitleScope, useSubtitleState } from './useBiliSubtitles'

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
    const frame: FloatingFrame = {id:current?.id || '',title:current?.title || 'BiliMusic',artist:current?.artist || '',position:playbackClock(),rate:state.rate,playing:state.status === 'playing',theme:useThemeStore.getState().theme,...timeline,fontSize:style.fontSize,locked:style.locked,activeColor:style.activeColor,inactiveColor:style.inactiveColor,alignment:style.alignment,language:style.language,capturedAt:Date.now()}
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
  type NativeStyle = Partial<Pick<FloatingPreferences, 'fontSize' | 'locked' | 'language'>>
  let preferenceRequest = 0
  let applyingNativeStyle = false
  const applyNativeStyle = ({ fontSize, locked, language }: NativeStyle) => {
    const current = useFloatingPreferences.getState()
    const patch: NativeStyle = {}
    if (fontSize !== undefined && current.fontSize !== fontSize) patch.fontSize = fontSize
    if (locked !== undefined && current.locked !== locked) patch.locked = locked
    if (language !== undefined && current.language !== language) patch.language = language
    if (!Object.keys(patch).length) return
    applyingNativeStyle = true
    try { current.update(patch) } finally { applyingNativeStyle = false }
  }
  const readNativeLanguage = (command: object) => {
    const request = ++preferenceRequest
    void nativeLyrics<NativeStyle>(command).then(({ language }) => {
      if (!disposed && request === preferenceRequest) applyNativeStyle({ language })
    }).catch(() => undefined)
  }
  const configure = (languageChanged = false) => {
    if (isIOS || isOHOS) return
    const { fontSize, locked, showUnlockButton, activeColor, inactiveColor, alignment, language } = useFloatingPreferences.getState()
    if (isAndroid) {
      readNativeLanguage({ action: 'configure', fontSize, locked, showUnlockButton, activeColor, inactiveColor, alignment,
        ...(languageChanged ? { language } : { initialLanguage: language }) })
    } else void invoke('floating_lyrics_configure', { locked }).catch(() => undefined)
  }
  stop.push(useFloatingPreferences.subscribe((value, previous) => {
    if (!applyingNativeStyle) configure(value.language !== previous.language)
    lastNative = ''
    void publish()
  }))
  onWindow('bilimusic-floating-lyrics-change', () => configure())
  configure()
  if (isAndroid) {
    const restoreNativeLanguage = () => {
      if (document.visibilityState === 'visible') readNativeLanguage({ action: 'status' })
    }
    document.addEventListener('visibilitychange', restoreNativeLanguage)
    stop.push(() => document.removeEventListener('visibilitychange', restoreNativeLanguage))
  }
  stop.push(useThemeStore.subscribe(() => { void publish() }))
  stop.push(useSubtitleState.subscribe(() => { void publish() }))
  onWindow('bilimusic-lyrics-updated',updated)
  onWindow('bilimusic-lyric-bias',updated)
  onWindow('bilimusic-floating-style', event => {
    preferenceRequest++
    applyNativeStyle((event as CustomEvent<NativeStyle>).detail)
  })
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
