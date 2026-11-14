import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { globalShortcutBinding, shortcutActions, type ShortcutAction, type ShortcutBindings } from '../features/player/shortcuts'
import { inDesktopShell } from './desktopApi'

let suspended = false
let current: ShortcutBindings | undefined
let sent = ''

export function syncGlobalShortcuts(bindings: ShortcutBindings) {
  current = bindings
  void push()
}

export function suspendGlobalShortcuts(on: boolean) {
  suspended = on
  void push()
}

async function push() {
  if (!inDesktopShell || !current) return
  const bindings = suspended ? [] : shortcutActions.flatMap(({ id }) => {
    const binding = globalShortcutBinding(id, current![id])
    return binding ? [binding] : []
  })
  const next = JSON.stringify(bindings)
  if (next === sent) return
  sent = next
  try { await invoke('global_shortcuts_apply', { bindings }) }
  catch { sent = '' }
}

export function listenGlobalShortcuts(run: (action: ShortcutAction) => void) {
  if (!inDesktopShell) return () => undefined
  let stop: UnlistenFn = () => undefined
  let dead = false
  void listen<string>('global-shortcut', event => { if (!suspended) run(event.payload) }).then(unlisten => { if (dead) unlisten(); else stop = unlisten })
  return () => { dead = true; stop() }
}
