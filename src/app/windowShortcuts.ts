import { playerShortcut, resolveShortcut, type ShortcutAction } from '../domain/shortcuts'
import { usePlayerStore } from '../features/player/playerStore'
import { listenGlobalShortcuts, syncGlobalShortcuts, showMainWindow } from '../services/globalShortcuts'
import { isMobile } from '../services/platform'
import { useShortcutStore } from '../services/shortcuts'
import { installMouseShortcuts } from '../shared/installMouseShortcuts'
import { suppressBrowserContextMenu } from '../shared/nativeTextEditing'
import { dispatchBack } from '../shared/overlayStack'

export function installWindowShortcuts() {
  const handler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || (event.target as HTMLElement)?.closest('[data-shortcut-editor]')) return
    if (event.key === 'Escape' || event.key === 'BrowserBack') {
      if (dispatchBack()) event.preventDefault()
      return
    }
    const target = event.target as HTMLElement
    // Text fields keep every key for typing. Sliders have no native action for
    // Space, so seeking with the mouse must not swallow the playback shortcut.
    const field = target.closest('input, textarea, select, [contenteditable="true"]')
    if (field && !(event.key === ' ' && field.matches('input[type="range"]'))) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); return }
    // Space stays an app-wide shortcut wherever focus happens to be, so a
    // clicked button or lyric line cannot swallow it. Enter keeps native
    // activation for buttons, links and summaries; transport controls prefer the
    // user's own binding even for Enter.
    if (target.isContentEditable) return
    if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'Enter' && target.closest('button, a, summary') && !target.closest('.dock-controls,.mini-player-controls')) return
    if (event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
    const shortcut = isMobile ? playerShortcut(event) : resolveShortcut(event, useShortcutStore.getState().bindings)
    if (!shortcut) return
    if (event.repeat && ['show','toggle','next','previous','refreshSync'].includes(shortcut)) { event.preventDefault();return }
    if(run(shortcut))event.preventDefault()
  }
  const run=(shortcut:ShortcutAction)=>{
    if(shortcut==='show'){void showMainWindow();return true}
    if(shortcut==='refreshSync'){window.dispatchEvent(new Event('bilimusic-refresh-requested'));return true}
    if(shortcut==='listSearch'){
      const search=new Event('bilimusic-list-search',{cancelable:true});window.dispatchEvent(search);return search.defaultPrevented
    }
    const state=usePlayerStore.getState()
    if(shortcut==='toggle')void state.toggle()
    else if(shortcut==='next')void state.next()
    else if(shortcut==='previous')void state.previous()
    else if(shortcut==='seekBack'||shortcut==='seekForward')state.seek(state.progressSeconds+(shortcut==='seekBack'?-10:10))
    else state.setVolume(Math.max(0,Math.min(1,state.volume+(shortcut==='volumeUp'?.05:-.05))))
    return true
  }
  const stopMouse=isMobile?()=>undefined:installMouseShortcuts(window,()=>useShortcutStore.getState().bindings,run,event=>Boolean((event.target as Element)?.closest?.('[data-shortcut-editor],input,textarea,select,[contenteditable="true"]')||document.querySelector('[aria-modal="true"]')))
  const stopGlobal = isMobile ? () => undefined : listenGlobalShortcuts(run)
  const stopSync = isMobile ? () => undefined : useShortcutStore.subscribe(state => syncGlobalShortcuts(state.bindings,state.globalEnabled))
  if (!isMobile) { const state=useShortcutStore.getState();syncGlobalShortcuts(state.bindings,state.globalEnabled) }
  window.addEventListener('keydown', handler)
  const disableBrowserMenu = (event: MouseEvent) => suppressBrowserContextMenu(event, isMobile)
  document.addEventListener('contextmenu', disableBrowserMenu)
  return () => { stopMouse();stopGlobal();stopSync();if(!isMobile)syncGlobalShortcuts(useShortcutStore.getState().bindings,false);window.removeEventListener('keydown', handler); document.removeEventListener('contextmenu', disableBrowserMenu) }
}
