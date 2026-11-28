import { playerShortcut, resolveShortcut, type ShortcutAction } from '../domain/shortcuts'
import { usePlayerStore } from '../features/player/playerStore'
import { listenGlobalShortcuts, syncGlobalShortcuts, showMainWindow } from '../services/globalShortcuts'
import { isMobile } from '../services/platform'
import { useShortcutStore } from '../services/shortcuts'
import { installMouseShortcuts } from '../shared/installMouseShortcuts'
import { suppressBrowserContextMenu } from '../shared/nativeTextEditing'
import { dispatchBack } from '../shared/overlayStack'

const playbackRange = 'input[type="range"][data-playback-space-range]'
const pointerPlaybackControl = '[data-playback-space-pointer]'
const interactiveControl = 'button, a, summary, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]'
const menu = '[role="menu"], [role="menubar"]'
const shortcutEditor = '[data-shortcut-editor]'
const modal = '[aria-modal="true"]'

export function installWindowShortcuts() {
  let pointerControl: Element | null = null
  const clearPointer = () => { pointerControl = null }
  const rememberPointer = (event: PointerEvent) => {
    pointerControl = event.pointerType === 'mouse' && event.button === 0
      ? (event.target as Element)?.closest?.(pointerPlaybackControl) ?? null
      : null
  }
  const clearOnFocusChange = (event: FocusEvent) => {
    if (event.target !== pointerControl) clearPointer()
  }
  const shortcutFor = (event: KeyboardEvent) => isMobile
    ? playerShortcut(event)
    : resolveShortcut(event, useShortcutStore.getState().bindings)

  // A lyric or track row handles keyboard activation before the window's
  // bubbling listener. Only take Space early for explicit playback controls.
  const playbackSpace = (event: KeyboardEvent) => {
    const modified = event.metaKey || event.ctrlKey || event.altKey
    if (event.key === 'Tab' || (!modified && /^(Arrow.*|Home|End|PageUp|PageDown)$/.test(event.key))) clearPointer()
    if (event.key !== ' ' || modified || event.shiftKey || event.defaultPrevented || event.isComposing) return
    const target = event.target as HTMLElement | null
    if (!target?.matches || target !== document.activeElement || target.isContentEditable) return
    const pointerFocused = target === pointerControl && target.matches(pointerPlaybackControl)
    if (!target.matches(playbackRange) && !pointerFocused) return
    if (target.closest(shortcutEditor) || target.closest(menu) || document.querySelector(modal)) return
    if (shortcutFor(event) !== 'toggle') return
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) run('toggle')
  }
  const handler = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (event.defaultPrevented || event.isComposing || target?.closest?.(shortcutEditor)) return
    if (event.key === 'Escape' || event.key === 'BrowserBack') {
      if (dispatchBack()) event.preventDefault()
      return
    }
    if (target?.isContentEditable || target?.closest?.('input, textarea, select')) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); return }
    if (document.querySelector(modal) || (event.key === ' ' && target?.closest?.(menu))) return
    if (!event.metaKey && !event.ctrlKey && !event.altKey && target?.closest?.(interactiveControl)) {
      if (event.key === ' ') return
      if (event.key === 'Enter' && !target.closest('.dock-controls,.mini-player-controls')) return
    }
    const shortcut = shortcutFor(event)
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
  window.addEventListener('pointerdown', rememberPointer, true)
  window.addEventListener('focusin', clearOnFocusChange)
  window.addEventListener('blur', clearPointer)
  window.addEventListener('keydown', playbackSpace, true)
  window.addEventListener('keydown', handler)
  const disableBrowserMenu = (event: MouseEvent) => suppressBrowserContextMenu(event, isMobile)
  document.addEventListener('contextmenu', disableBrowserMenu)
  return () => {
    stopMouse()
    stopGlobal()
    stopSync()
    if (!isMobile) syncGlobalShortcuts(useShortcutStore.getState().bindings, false)
    window.removeEventListener('pointerdown', rememberPointer, true)
    window.removeEventListener('focusin', clearOnFocusChange)
    window.removeEventListener('blur', clearPointer)
    window.removeEventListener('keydown', playbackSpace, true)
    window.removeEventListener('keydown', handler)
    document.removeEventListener('contextmenu', disableBrowserMenu)
  }
}
