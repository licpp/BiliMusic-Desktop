import { useEffect, useState, type CSSProperties } from 'react'
import { LoaderCircle } from 'lucide-react'
import { FloatingLyricsColors } from '../lyrics/FloatingLyricsColors'
import { SettingsDisclosure } from './SettingsDisclosure'
import { useFloatingPreferences } from '../../services/floatingLyricsPreferences'
import { floatingCapability, setFloatingLyrics, useFloatingLyrics, type FloatingCapability } from '../../services/floatingLyrics'
import { isMobile, isOHOS } from '../../services/platform'
import { commandErrorMessage } from '../../services/desktopApi'

export function FloatingLyricsSettings() {
  const {enabled,busy,error}=useFloatingLyrics()
  const {fontSize,locked,activeColor,inactiveColor,update}=useFloatingPreferences()
  const [capability,setCapability]=useState<FloatingCapability | null>(null)
  useEffect(()=>{
    let alive=true
    void floatingCapability().then(value=>{if(alive)setCapability(value)}).catch(cause=>{if(alive)setCapability({supported:false,enabled:false,reason:commandErrorMessage(cause)})})
    return()=>{alive=false}
  },[])
  const description=capability && !capability.supported ? capability.reason || '此系统暂不支持' : isOHOS ? '通过系统桌面歌词显示' : '在其他窗口上方显示歌词'
  const fontSupported=capability?.supported&&capability.fontSizeSupported!==false
  const colorSupported=capability?.supported&&capability.colorSupported!==false&&!isOHOS
  return <SettingsDisclosure icon={<span className="floating-lyrics-icon" aria-hidden="true">词</span>} title="悬浮歌词" description={`${enabled?'已开启 · ':''}${description}`}>
    <div className="floating-settings-content">
      <div className="floating-enable-setting">
        <button type="button" className="auto-resume-switch" role="switch" aria-checked={enabled} aria-labelledby="floating-lyrics-label" disabled={busy||!capability?.supported} onClick={()=>void setFloatingLyrics(!enabled)}>{busy?<LoaderCircle size={16} className="spin"/>:<span aria-hidden="true"/>}</button>
        <strong id="floating-lyrics-label">开启悬浮歌词</strong><small>{!capability?'正在检查…':enabled?'已开启':'已关闭'}</small>
      </div>
      {capability?.supported&&(fontSupported||colorSupported)&&<div className="floating-settings-layout">
        <div className="floating-settings-preview" aria-label="悬浮歌词样式预览" style={{'--preview-active':activeColor,'--preview-inactive':inactiveColor,'--preview-font-size':`${fontSize}px`} as CSSProperties}>
          <small>样式预览</small><div><p><span>旋律</span>缓缓响起</p><p>此刻，慢慢听</p></div>
        </div>
        <div className="floating-settings-controls">
          {fontSupported&&<label className="floating-font-setting"><span>歌词字号<output>{fontSize}<small>px</small></output></span><input aria-label="悬浮歌词字号" type="range" min="18" max="48" step="2" value={fontSize} style={{'--range-fill':`${(fontSize-18)/30*100}%`} as CSSProperties} onChange={event=>update({fontSize:Number(event.target.value)})}/></label>}
          {colorSupported&&<div className="floating-palette-setting"><span>歌词配色</span><FloatingLyricsColors showPresetNames activeColor={activeColor} inactiveColor={inactiveColor} update={update}/></div>}
        </div>
      </div>}
      {capability?.supported&&!fontSupported&&!colorSupported&&<p className="floating-settings-note">字号与配色由系统桌面歌词管理。</p>}
      {capability?.supported&&capability.lockSupported!==false&&<label className="floating-lock-setting"><input type="checkbox" aria-label="锁定悬浮歌词位置" checked={locked} onChange={event=>update({locked:event.target.checked})}/><span>锁定位置<small>{locked ? isMobile ? '点击歌词旁的解锁图标，也可在这里解锁' : '已锁定，悬停歌词可解锁' : isMobile ? '固定歌词位置，防止误拖动' : '歌词区域可点击穿透，悬停时显示解锁按钮'}</small></span></label>}
      {capability&&!capability.supported&&<p className="floating-settings-note">{description}</p>}
      {error&&<p className="settings-error" role="alert">{error}</p>}
    </div>
  </SettingsDisclosure>
}
