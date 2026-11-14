import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { globalShortcutBinding, shortcutActions, type ShortcutAction, type ShortcutBindings } from '../features/player/shortcuts'
import { inDesktopShell } from './desktopApi'
import { shortcutDesktop } from './shortcuts'

type Registration = { registered: string[]; errors: { action: string; message: string }[] }
export const useGlobalShortcutStatus = create<{ pending: boolean; registered: string[]; errors: Record<string,string>; error: string }>(() => ({ pending:false,registered:[],errors:{},error:'' }))
let suspended = false
let current: { bindings: ShortcutBindings; enabled: boolean } | undefined
let desired = ''
let sent: string | undefined
let pushing = false
let listenerFailure = ''

export function syncGlobalShortcuts(bindings: ShortcutBindings, enabled = false) {
  current = { bindings, enabled }
  queue()
}

export function suspendGlobalShortcuts(on: boolean) {
  suspended = on
  queue()
}

function queue() {
  if (!inDesktopShell || !shortcutDesktop || !current) return
  const enabled = current.enabled && !suspended && !listenerFailure
  const bindings = enabled ? shortcutActions.flatMap(({id}) => {
    const binding = globalShortcutBinding(id,current!.bindings[id])
    return binding ? [binding] : []
  }) : []
  desired = JSON.stringify({bindings,enabled})
  void push()
}

// Serialize native registration changes: an older, slower request must never
// restore bindings after recording started, the setting was disabled, or a key changed.
async function push() {
  if (pushing) return
  pushing = true
  try {
    while (desired && desired !== sent) {
      const snapshot = desired
      useGlobalShortcutStatus.setState({pending:true})
      try {
        const result = await invoke<Registration>('global_shortcuts_apply',JSON.parse(snapshot))
        sent = snapshot
        if (snapshot === desired) useGlobalShortcutStatus.setState({pending:false,registered:result.registered,
          errors:Object.fromEntries(result.errors.map(item=>[item.action,item.message])),error:listenerFailure})
      } catch (cause) {
        if (snapshot !== desired) continue
        sent = undefined
        useGlobalShortcutStatus.setState({pending:false,registered:[],errors:{},error:typeof cause==='string'?cause:'无法设置全局快捷键，请关闭后重新开启'})
        break
      }
    }
  } finally { pushing = false }
}

export function listenGlobalShortcuts(run: (action: ShortcutAction) => void) {
  if (!inDesktopShell || !shortcutDesktop) return () => undefined
  let stop: UnlistenFn = () => undefined
  let dead = false
  void listen<string>('global-shortcut',event=>{
    if (dead || suspended || !current?.enabled) return
    const action = shortcutActions.find(item=>item.id===event.payload)?.id
    if (action && useGlobalShortcutStatus.getState().registered.includes(action)) run(action)
  }).then(unlisten=>{
    if(dead)unlisten();else {stop=unlisten;if(listenerFailure){listenerFailure='';queue()}}
  }).catch(()=>{
    if(!dead){listenerFailure='无法接收全局快捷键，请重启应用';useGlobalShortcutStatus.setState({error:listenerFailure});queue()}
  })
  return () => { dead=true;stop() }
}
