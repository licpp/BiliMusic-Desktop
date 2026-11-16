import { useRef, useState, type ComponentProps, type PointerEvent } from 'react'
import { progressAtPointer } from '../domain/playbackProgress'
import { RangeControl } from './RangeControl'

type Props = Omit<ComponentProps<typeof RangeControl>, 'value' | 'onChange' | 'onPointerDown' | 'onPointerMove' | 'onPointerUp'> & {
  value: number; duration: number; trackKey?: string
  onSeek: (seconds: number) => void; onPreview?: (seconds: number | undefined) => void
  onValueChange?: (seconds: number) => void
}

// Preview with the pointer; seek once on release. Playback updates cannot pull
// the thumb back during a drag, and a track change invalidates the old gesture.
export function SeekRange({ value, duration, trackKey, onSeek, onPreview, onValueChange, ...props }: Props) {
  const [draft, setDraft] = useState<{ key?: string; value: number }>()
  const latestKey = useRef(trackKey); latestKey.current = trackKey
  const drag = useRef<{ pointer: number; key?: string; value: number } | null>(null)
  const cancel = () => { drag.current = null; setDraft(undefined); onPreview?.(undefined) }
  const move = (event: PointerEvent<HTMLInputElement>) => {
    const current = drag.current
    if (!current || current.pointer !== event.pointerId || current.key !== latestKey.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    current.value = progressAtPointer(event.clientX, rect.left, rect.width, duration)
    setDraft({ key: current.key, value: current.value }); onPreview?.(current.value)
  }
  return <RangeControl {...props} min={0} max={Math.max(1, duration)} step={props.step ?? .1} disabled={props.disabled || duration <= 0}
    value={draft?.key === trackKey ? draft?.value ?? value : value}
    onPointerDown={event => {
      if (event.button !== 0 || duration <= 0) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true })
      drag.current = { pointer: event.pointerId, key: trackKey, value }
      event.currentTarget.setPointerCapture(event.pointerId); move(event)
    }} onPointerMove={move} onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return
      move(event); const target = drag.current; cancel()
      if (target.key === latestKey.current) onSeek(target.value)
    }} onPointerCancel={cancel} onLostPointerCapture={cancel}
    onChange={event => { if (!drag.current) (onValueChange ?? onSeek)(Number(event.target.value)) }}/>
}
