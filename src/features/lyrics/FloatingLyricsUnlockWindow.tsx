import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { LockKeyholeOpen } from 'lucide-react'
import type { FloatingFrame } from '../../services/floatingLyrics'

// This webview's native window is exactly one button, separate from the
// click-through lyric window. It cannot intercept the area beneath the lyrics.
export function FloatingLyricsUnlockWindow() {
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>{
  document.documentElement.dataset.window='lyrics-unlock';document.getElementById('app-bootstrap')?.remove()
  let alive=true,seen=false
  const theme=(value:unknown)=>{if(alive&&(value==='light'||value==='dark'))document.documentElement.dataset.theme=value}
  const listener=listen<string>('floating-lyrics-theme',event=>{seen=true;theme(event.payload)})
  // Hidden WKWebViews can suspend animation frames indefinitely. DOM commit and
  // event subscription are enough to accept the first native show operation.
  void listener.then(()=>invoke<FloatingFrame>('floating_lyrics_snapshot')).then(frame=>{if(!seen)theme(frame?.theme)}).catch(()=>undefined).then(()=>{if(alive)void invoke('floating_lyrics_unlock_ready').catch(()=>undefined)})
  return()=>{alive=false;void listener.then(stop=>stop())}
 },[])
 return <div className="floating-unlock-window"><button type="button" aria-label="解锁悬浮歌词" disabled={busy} title={error||'解锁悬浮歌词'} onClick={()=>{setBusy(true);setError('');void invoke('floating_lyrics_unlock').catch(()=>setError('解锁失败，请重试或在设置中解锁')).finally(()=>setBusy(false))}}><LockKeyholeOpen size={15}/><span>解锁</span></button></div>
}
