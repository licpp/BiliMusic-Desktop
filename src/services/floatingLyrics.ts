import type { FloatingPreferences } from './floatingLyricsPreferences'
import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { isMobile, isIOS, isOHOS } from './platform'
import { accountEpoch } from './accountScope'
import { inDesktopShell } from './desktopApi'
import type { LyricLine } from '../domain/lyrics'

export type FloatingFrame = { id: string; title: string; artist: string; position: number; rate: number; playing: boolean; theme: string; lines: LyricLine[]; biasMs: number; subtitles?:boolean; fontSize?:number; locked?:boolean; activeColor?:string; inactiveColor?:string; alignment?:FloatingPreferences['alignment']; language?:FloatingPreferences['language']; capturedAt?:number; revision?:number }
export type FloatingCapability = { supported: boolean; enabled: boolean; permissionRequired?: boolean; fontSizeSupported?: boolean; lockSupported?: boolean; colorSupported?:boolean; reason?: string }
const plugin = isOHOS ? 'ohos-player' : isIOS ? 'ios-player' : 'android-player'
export const nativeLyrics = <T>(data: object) => invoke<T>(`plugin:${plugin}|lyrics`, {data:JSON.stringify(data)})
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
