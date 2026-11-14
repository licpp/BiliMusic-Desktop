import { Keyboard, RotateCcw, X } from 'lucide-react'
import { SettingsDisclosure } from './SettingsDisclosure'
import { useEffect, useState } from 'react'
import { suspendGlobalShortcuts } from '../../services/globalShortcuts'
import { shortcutActions, shortcutFromEvent, shortcutFromMouseEvent, shortcutLabel, type ShortcutAction } from '../player/shortcuts'
import { shortcutMac, useShortcutStore } from '../../services/shortcuts'
export function ShortcutSettings() {
  const {bindings,setBinding,reset}=useShortcutStore()
  const [recording,setRecording]=useState<ShortcutAction|null>(null),[message,setMessage]=useState('')
  useEffect(()=>{suspendGlobalShortcuts(recording!==null)},[recording])
  return <SettingsDisclosure icon={<Keyboard/>} title="自定义快捷键" description="Windows 上，播放、切歌、快进和音量在其他窗口也生效" onToggle={open=>{if(!open)setRecording(null)}}>
    <div className="shortcut-editor" data-shortcut-editor>
      <p>点击右侧按键后，按下键盘或鼠标侧键，可配合 Ctrl / ⌘、Alt 和 Shift。按 Esc 取消。Windows 用 Ctrl + Alt + Q 打开软件：已退出会启动，正在后台会唤出窗口。空格和查找只在本窗口生效。</p>
      <div className="shortcuts-list">{shortcutActions.map(({id,label})=><div key={id}>
        <span>{label}</span><span><button type="button" className="shortcut-record" data-recording={recording===id} aria-label={`设置${label}快捷键`} aria-pressed={recording===id}
          onBlur={()=>setRecording(current=>current===id?null:current)}
          onClick={()=>{setRecording(current=>current===id?null:id);setMessage('')}}
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
      <footer><span role="status" aria-live="polite">{message}</span><button type="button" onClick={()=>{setRecording(null);setMessage(reset()||'已恢复默认快捷键')}}><RotateCcw size={14}/>恢复默认</button></footer>
    </div>
  </SettingsDisclosure>
}
