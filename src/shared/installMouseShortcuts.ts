import { resolveMouseShortcut, type ShortcutAction, type ShortcutBindings } from '../domain/shortcuts'

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
