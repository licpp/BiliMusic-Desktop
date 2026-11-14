export const shortcutActions = [
  { id:'toggle', label:'播放 / 暂停' }, { id:'previous', label:'上一首' }, { id:'next', label:'下一首' },
  { id:'seekBack', label:'快退 10 秒' }, { id:'seekForward', label:'快进 10 秒' },
  { id:'volumeUp', label:'增大音量' }, { id:'volumeDown', label:'减小音量' }, { id:'listSearch', label:'查找列表中的音乐' },
] as const
export type ShortcutAction = typeof shortcutActions[number]['id']
export type PlayerShortcut = Exclude<ShortcutAction, 'listSearch'>
export type Shortcut = { code:string; ctrl:boolean; meta:boolean; alt:boolean; shift:boolean }
export type ShortcutBindings = Record<ShortcutAction, Shortcut | null>
type KeyEvent = Pick<KeyboardEvent, 'code'|'key'|'metaKey'|'ctrlKey'|'altKey'|'shiftKey'> & Partial<Pick<KeyboardEvent,'isComposing'|'getModifierState'>>
const allowedCode = /^(MouseBack|MouseForward|Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Insert|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote|Numpad(?:Add|Subtract|Multiply|Divide|Decimal|Enter))$/
export function defaultShortcuts(mac = false): ShortcutBindings {
  const key = (code:string, command=false, alt=false): Shortcut => ({ code,ctrl:command&&!mac,meta:command&&mac,alt,shift:false })
  return {toggle:key('Space'),previous:key('ArrowLeft',true),next:key('ArrowRight',true),seekBack:key('ArrowLeft',false,true),seekForward:key('ArrowRight',false,true),volumeUp:key('ArrowUp',true),volumeDown:key('ArrowDown',true),listSearch:key('KeyF',true)}
}
export function shortcutFromEvent(event: KeyEvent): Shortcut | undefined {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.getModifierState?.('AltGraph')) return
  const code = /^(Arrow|F\d+$)/.test(event.key) ? event.key : event.code || (/^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}` : event.key === ' ' ? 'Space' : event.key)
  if (!allowedCode.test(code)) return
  return {code,ctrl:event.ctrlKey,meta:event.metaKey,alt:event.altKey,shift:event.shiftKey}
}
type MouseShortcutEvent = Pick<MouseEvent,'button'|'ctrlKey'|'metaKey'|'altKey'|'shiftKey'>
export function shortcutFromMouseEvent(event: MouseShortcutEvent): Shortcut | undefined {
  const code=event.button===3?'MouseBack':event.button===4?'MouseForward':undefined
  return code?{code,ctrl:event.ctrlKey,meta:event.metaKey,alt:event.altKey,shift:event.shiftKey}:undefined
}
export function resolveMouseShortcut(event: MouseShortcutEvent,bindings: ShortcutBindings): ShortcutAction | undefined {
  const key=shortcutFromMouseEvent(event)
  return shortcutActions.find(item=>sameShortcut(bindings[item.id],key))?.id
}
// Suppress native back/forward on every phase, but execute only on mouse-down.
export function installMouseShortcuts(target: EventTarget,bindings:()=>ShortcutBindings,run:(action:ShortcutAction)=>void,blocked:(event:MouseEvent)=>boolean) {
  const pressed=new Set<number>(),auxiliary=new Set<number>(),capture={capture:true}
  const suppress=(event:Event)=>{event.preventDefault();event.stopPropagation()}
  const down=(raw:Event)=>{
    const event=raw as MouseEvent
    if(event.defaultPrevented)return
    const action=resolveMouseShortcut(event,bindings())
    if(!action)return
    // Editors/modals retain their own interaction, but a bound side key must
    // still not navigate away from a draft or a recording field.
    const paused=blocked(event)
    if(paused)event.preventDefault();else suppress(event)
    if(pressed.has(event.button))return
    pressed.add(event.button);auxiliary.add(event.button);if(!paused)run(action)
  }
  const up=(raw:Event)=>{const event=raw as MouseEvent;if(pressed.delete(event.button))suppress(event)}
  const auxiliaryClick=(raw:Event)=>{const event=raw as MouseEvent;if(auxiliary.delete(event.button))suppress(event)}
  const cancel=()=>{pressed.clear();auxiliary.clear()}
  target.addEventListener('mousedown',down,capture);target.addEventListener('mouseup',up,capture);target.addEventListener('auxclick',auxiliaryClick,capture);target.addEventListener('blur',cancel)
  return()=>{target.removeEventListener('mousedown',down,capture);target.removeEventListener('mouseup',up,capture);target.removeEventListener('auxclick',auxiliaryClick,capture);target.removeEventListener('blur',cancel)}
}

const globalActions = new Set<ShortcutAction>(['toggle','previous','next','seekBack','seekForward','volumeUp','volumeDown'])
export function globalShortcutBinding(action: ShortcutAction, key: Shortcut | null) {
  if (!key || !globalActions.has(action) || key.code==='Space' || key.code.startsWith('Mouse')) return
  if (!key.ctrl && !key.alt && !key.shift && !key.meta && !/^F(?:[1-9]|1[0-2])$/.test(key.code)) return
  return {action, code:key.code, ctrl:key.ctrl, alt:key.alt, shift:key.shift, meta:key.meta}
}

// RegisterHotKey cannot distinguish the main Enter key from keypad Enter.
// Other Windows OEM/numpad keys have different virtual keys and stay distinct.
export function globalShortcutConflict(key: Shortcut, bindings: ShortcutBindings, action: ShortcutAction, mac=false): string | undefined {
  if (!globalShortcutBinding(action, key)) return
  const canonical = (value: Shortcut) => !mac && value.code === 'NumpadEnter' ? { ...value, code: 'Enter' } : value
  const conflict = shortcutActions.find(item => item.id !== action && globalShortcutBinding(item.id, bindings[item.id])
    && sameShortcut(canonical(bindings[item.id]!), canonical(key)))
  return conflict ? `全局快捷键与“${conflict.label}”冲突，主键盘 Enter 和数字键盘 Enter 无法分别注册` : undefined
}

export function sameShortcut(a: Shortcut | null | undefined, b: Shortcut | null | undefined) {
  return !!a && !!b && a.code===b.code && a.ctrl===b.ctrl && a.meta===b.meta && a.alt===b.alt && a.shift===b.shift
}
export function shortcutProblem(key: Shortcut, bindings: ShortcutBindings, action: ShortcutAction, desktop = false): string | undefined {
  if (desktop && key.ctrl && key.alt && !key.shift && !key.meta && key.code==='KeyQ') return 'Ctrl + Alt / Option + Q 用于唤出软件'
  if ((key.ctrl || key.meta) && !key.alt && /^Key[ACVXYZQWTNLRHM]$/.test(key.code) || key.alt && key.code==='F4' || key.meta && key.code==='Space') return '这个组合由系统或常用编辑操作使用，请换一个'
  const conflict = shortcutActions.find(item => item.id !== action && sameShortcut(bindings[item.id], key))
  return conflict ? `已用于“${conflict.label}”，请先修改或清除该快捷键` : undefined
}
export function resolveShortcut(event: KeyEvent, bindings: ShortcutBindings): ShortcutAction | undefined {
  const key = shortcutFromEvent(event)
  return shortcutActions.find(item => sameShortcut(bindings[item.id],key))?.id
}
export function shortcutLabel(key: Shortcut | null, mac=false) {
  if (!key) return '未设置'
  const names:Record<string,string> = {MouseBack:'鼠标后退键',MouseForward:'鼠标前进键',Space:'空格',ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Enter:'Enter',Backspace:'退格',Delete:'Delete',PageUp:'Page Up',PageDown:'Page Down',Minus:'−',Equal:'=',BracketLeft:'[',BracketRight:']',Backslash:'\\',Semicolon:';',Quote:"'",Comma:',',Period:'.',Slash:'/',Backquote:'`',NumpadAdd:'数字 +',NumpadSubtract:'数字 −',NumpadMultiply:'数字 ×',NumpadDivide:'数字 ÷',NumpadDecimal:'数字 .',NumpadEnter:'数字 Enter'}
  const name=names[key.code] || key.code.replace(/^Key|^Digit/,'').replace(/^Numpad/,'数字 ')
  return [key.ctrl?'Ctrl':'',key.meta?(mac?'⌘':'Win'):'',key.alt?(mac?'Option':'Alt'):'',key.shift?'Shift':'',name].filter(Boolean).join(' + ')
}
export function readShortcuts(raw: string | null, mac=false, desktop=false): ShortcutBindings {
  const defaults=defaultShortcuts(mac)
  if (!raw) return defaults
  try {
    const value=JSON.parse(raw)
    if (value?.version !== 1 || !value.bindings || typeof value.bindings !== 'object') return defaults
    const next={...defaults}
    for(const {id} of shortcutActions) {
      const key=value.bindings[id]
      if (key===null) next[id]=null
      else if(key && allowedCode.test(key.code) && ['ctrl','meta','alt','shift'].every(field=>typeof key[field]==='boolean')) {
        // Only clear the newly reserved launch binding, preserving every other
        // user mapping when upgrading from window-only shortcuts.
        next[id]=desktop&&key.code==='KeyQ'&&key.ctrl&&key.alt&&!key.meta&&!key.shift?null:{code:key.code,ctrl:key.ctrl,meta:key.meta,alt:key.alt,shift:key.shift}
      }
    }
    // Reject corrupt or conflicting saved maps as a whole, so no action is silently shadowed.
    if(shortcutActions.some(({id})=>next[id] && shortcutProblem(next[id]!,next,id,desktop))) return defaults
    return next
  } catch { return defaults }
}
// Kept as the default mapping for callers that do not have desktop preferences.
export function playerShortcut(event: KeyEvent): PlayerShortcut | undefined {
  const bindings=defaultShortcuts(event.metaKey)
  const action=resolveShortcut(event,bindings)
  return action==='listSearch'?undefined:action
}
