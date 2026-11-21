import { useState } from 'react'
import { Captions } from 'lucide-react'
import { setSystemTitleLyrics } from '../../services/floatingLyrics'
import { commandErrorMessage } from '../../services/desktopApi'
import { isAndroid } from '../../services/platform'
export function SystemTitleLyricsSettings() {
  const [enabled,setEnabled]=useState(()=>localStorage.getItem('system-title-lyrics')==='true')
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  return <section className="settings-card system-title-lyrics-setting"><div className="settings-icon"><Captions/></div><div><strong id="system-title-lyrics-label">系统标题歌词</strong><small>{isAndroid ? '开启时歌词显示在第一行，关闭时显示在第二行' : '在支持的系统媒体卡片上显示当前歌词'}</small>{error&&<small role="alert">{error}</small>}</div><button className="auto-resume-switch" type="button" role="switch" aria-labelledby="system-title-lyrics-label" aria-checked={enabled} disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await setSystemTitleLyrics(!enabled);setEnabled(!enabled)}catch(e){setError(commandErrorMessage(e))}finally{setBusy(false)}}}><span aria-hidden="true"/></button></section>
}
