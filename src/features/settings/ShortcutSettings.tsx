import { Keyboard, RotateCcw, X } from 'lucide-react'
import { SettingsDisclosure } from './SettingsDisclosure'
import { useEffect, useState } from 'react'
import { suspendGlobalShortcuts, useGlobalShortcutStatus } from '../../services/globalShortcuts'
import { shortcutActions, shortcutFromEvent, shortcutFromMouseEvent, shortcutLabel, type ShortcutAction } from '../player/shortcuts'
import { shortcutMac, shortcutDesktop, useShortcutStore } from '../../services/shortcuts'
export function ShortcutSettings() {
  const {bindings,globalEnabled,setGlobalEnabled,setBinding,reset}=useShortcutStore()
  const globalStatus=useGlobalShortcutStatus()
  const [recording,setRecording]=useState<ShortcutAction|null>(null),[message,setMessage]=useState('')
  useEffect(()=>{suspendGlobalShortcuts(recording!==null);return()=>suspendGlobalShortcuts(false)},[recording])
  return <SettingsDisclosure icon={<Keyboard/>} title="自定义快捷键" description={shortcutDesktop&&globalEnabled?'已开启全局播放快捷键':'键盘或鼠标侧键，窗口内生效'} onToggle={open=>{if(!open)setRecording(null)}}>
    <div className="shortcut-editor" data-shortcut-editor>
      <p>点击按键后，按下键盘或鼠标侧键，可配合 Ctrl / ⌘、Alt 和 Shift。按 Esc 取消。</p>
      {shortcutDesktop&&<div className="shortcut-global-setting"><div><strong id="global-shortcuts-label">全局播放快捷键</strong><small>开启后，这些组合将优先控制播放。空格、字母数字单键、鼠标侧键和查找仍在本窗口生效。</small></div>
        <button type="button" className="auto-resume-switch" role="switch" aria-checked={globalEnabled} aria-labelledby="global-shortcuts-label" onClick={()=>{setRecording(null);setMessage(setGlobalEnabled(!globalEnabled)||'')}}><span aria-hidden="true"/></button>
      </div>}
      <div className="shortcuts-list">{shortcutActions.map(({id,label})=><div key={id}>
        <span className="shortcut-action-label">{label}{shortcutDesktop&&globalEnabled&&globalStatus.errors[id]&&<small role="status" className="shortcut-binding-error">{globalStatus.errors[id]}</small>}</span><span><button type="button" className="shortcut-record" data-recording={recording===id} aria-label={`设置${label}快捷键`} aria-pressed={recording===id}
          onBlur={()=>setRecording(current=>current===id?null:current)}
          onClick={event=>{event.currentTarget.focus();setRecording(current=>current===id?null:id);setMessage('')}}
          onMouseDown={event=>{
            const key=shortcutFromMouseEvent(event.nativeEvent)
            if(!key)return
            event.preventDefault();event.stopPropagation()
            if(recording!==id)return
            const error=setBinding(id,key);setMessage(error||`已设置${label}：${shortcutLabel(key,shortcutMac)}`)
            if(!error)setRecording(null)
          }}
          onMouseUp={event=>{if(event.button>=3){event.preventDefault();event.stopPropagation()}}}
          onAuxClick={event=>{if(event.button>=3){event.preventDefault();event.stopPropagation()}}}
          onKeyDown={event=>{
            if(recording!==id)return
            event.stopPropagation()
            if(event.key==='Escape'){event.preventDefault();setRecording(null);return}
            if(event.key==='Tab'){setRecording(null);return}
            event.preventDefault()
            if(event.repeat || event.nativeEvent.isComposing)return
            const key=shortcutFromEvent(event.nativeEvent)
            if(!key){if(!['Control','Meta','Alt','Shift'].includes(event.key))setMessage('请使用字母、数字、方向键或功能键');return}
            const error=setBinding(id,key)
            setMessage(error||`已设置${label}：${shortcutLabel(key,shortcutMac)}`)
            if(!error)setRecording(null)
          }}><kbd>{recording===id?'请按键或侧键…':shortcutLabel(bindings[id],shortcutMac)}</kbd></button>
          <button type="button" className="shortcut-clear" disabled={!bindings[id]} aria-label={`清除${label}快捷键`} title="清除快捷键" onClick={()=>{setRecording(null);setMessage(setBinding(id,null)||`已清除${label}快捷键`)}}><X size={14}/></button></span>
      </div>)}</div>
      <footer><span role="status" aria-live="polite">{globalStatus.error||globalStatus.errors.show||message||(globalStatus.pending?'正在更新全局快捷键…':'')}</span><button type="button" onClick={()=>{setRecording(null);setMessage(reset()||'已恢复默认快捷键')}}><RotateCcw size={14}/>恢复默认</button></footer>
      {shortcutDesktop&&<p className="shortcut-launch-hint">{shortcutMac?'Ctrl + Option + Q 可唤出正在运行的应用。':'Ctrl + Alt + Q 可唤出应用；安装版退出后也可启动。'}</p>}
    </div>
  </SettingsDisclosure>
}
