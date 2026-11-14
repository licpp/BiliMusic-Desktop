let active: (() => void) | undefined

// WebKit may synthesize a click after pointerup has removed the touched option.
// Consume that gesture at window capture even if it is retargeted behind the picker.
// A new pointerdown immediately restores normal input for the user's next tap.
export function consumeTouchClick(point: {clientX:number;clientY:number}, target: EventTarget = window) {
  active?.()
  const capture={capture:true}
  const clear=()=>{
    target.removeEventListener('click',click,capture)
    target.removeEventListener('pointerdown',clear,capture)
    clearTimeout(timer)
    if(active===clear)active=undefined
  }
  const click=(event:Event)=>{
    const mouse=event as MouseEvent
    if(mouse.detail===0)return // Keyboard and assistive activation are independent.
    clear()
    if(Math.abs(mouse.clientX-point.clientX)<=24&&Math.abs(mouse.clientY-point.clientY)<=24){
      event.preventDefault();event.stopImmediatePropagation()
    }
  }
  const timer=setTimeout(clear,650)
  active=clear
  target.addEventListener('click',click,capture)
  target.addEventListener('pointerdown',clear,capture)
  return clear
}
