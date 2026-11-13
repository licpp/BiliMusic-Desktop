import { Check, ChevronDown } from 'lucide-react'
import { useId, useRef, useState, type PointerEvent, type ReactNode } from 'react'

export function TouchOptions({ label, selected, options, onChange, disabled = false, icon }: {
  icon?: ReactNode
  label: string
  selected: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const pointer = useRef<number | null>(null)
  const skipClick = useRef(false)
  const [preview, setPreview] = useState<string | null>()
  const choose = (value: string) => { setOpen(false); onChange(value) }
  const choiceAt = (event: PointerEvent<HTMLDivElement>) => {
    const button = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('[data-touch-option]')
    return button && event.currentTarget.contains(button) ? button.dataset.touchOption ?? null : null
  }
  const cancel = () => { pointer.current = null; setPreview(undefined) }
  return <div className="touch-options"
    onPointerDownCapture={() => { skipClick.current = false }}
    onClickCapture={event => {
      if (skipClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation() }
    }}>
    <button type="button" className="touch-option-trigger" disabled={disabled} aria-expanded={open && !disabled} aria-controls={id}
      onClick={() => setOpen(value => !value)}>
      {icon}<span>{label}</span><small>{options.find(option => option.value === selected)?.label}</small><ChevronDown className="touch-option-chevron" size={16} aria-hidden="true"/>
    </button>
    {open && !disabled && <div id={id} className="touch-option-list" role="group" aria-label={label} data-touch-picker data-tracking={preview !== undefined || undefined}
      onPointerDown={event => {
        if (event.pointerType !== 'touch' || !event.isPrimary) return
        const value = choiceAt(event)
        if (value === null) return
        event.preventDefault()
        pointer.current = event.pointerId
        skipClick.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        setPreview(value)
      }}
      onPointerMove={event => { if (pointer.current === event.pointerId) setPreview(choiceAt(event)) }}
      onPointerUp={event => {
        if (pointer.current !== event.pointerId) return
        const value = choiceAt(event)
        cancel()
        if (value !== null) choose(value)
      }}
      onPointerCancel={cancel} onLostPointerCapture={cancel}>
      {options.map(option => <button type="button" key={option.value} aria-pressed={option.value === selected}
        data-touch-option={option.value} data-preview={option.value === preview || undefined}
        onClick={() => choose(option.value)}>
        {option.label}{option.value === selected && <Check size={17} aria-hidden="true"/>}
      </button>)}
    </div>}
  </div>
}
