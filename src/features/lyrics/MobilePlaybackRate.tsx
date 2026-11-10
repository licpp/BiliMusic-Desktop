import { ChevronRight, Gauge } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { playbackRates, usePlayerStore } from '../player/playerStore'

export function PlaybackRateEntry({ onOpen }: { onOpen: () => void }) {
  const rate = usePlayerStore(state => state.rate)
  return <button type="button" className="playback-rate-entry" onClick={onOpen}>
    <Gauge size={17}/>播放倍速<small>{rate}×</small><ChevronRight size={15}/>
  </button>
}

export function MobilePlaybackRate({ onClose }: { onClose: () => void }) {
  const rate = usePlayerStore(state => state.rate)
  const setRate = usePlayerStore(state => state.setRate)
  const [preview, setPreview] = useState<number>()
  const pointer = useRef<number | null>(null)
  const last = playbackRates.length - 1
  const index = Math.max(0, playbackRates.findIndex(value => value === rate))
  const shown = preview ?? index
  const value = playbackRates[Math.round(shown)]
  const positionAt = (event: PointerEvent<HTMLInputElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width) return index
    return Math.max(0, Math.min(last, (event.clientX - bounds.left) / bounds.width * last))
  }
  const cancel = () => { pointer.current = null; setPreview(undefined) }
  return <CollectionDialog title="播放倍速" className="playback-rate-dialog" onClose={onClose}>
    <div className="playback-rate-picker">
      <output htmlFor="mobile-playback-rate">{value}×</output>
      <div className="playback-rate-ruler" data-touch-picker>
        <div className="playback-rate-rail" aria-hidden="true">
          {playbackRates.map((option, at) => <span key={option} data-selected={option === value || undefined}
            style={{ left: (at / last * 100) + '%' }}><i/>{option}×</span>)}
          <b style={{ left: (shown / last * 100) + '%' }}/>
        </div>
        <input id="mobile-playback-rate" type="range" min={0} max={last} step={1} value={Math.round(shown)}
          aria-label="播放倍速" aria-valuetext={value + '倍'}
          onChange={event => { if (pointer.current === null) void setRate(playbackRates[Number(event.currentTarget.value)]) }}
          onPointerDown={event => {
            if (!event.isPrimary || event.button !== 0) return
            event.preventDefault()
            event.currentTarget.focus({ preventScroll: true })
            pointer.current = event.pointerId
            event.currentTarget.setPointerCapture(event.pointerId)
            setPreview(positionAt(event))
          }}
          onPointerMove={event => { if (pointer.current === event.pointerId) setPreview(positionAt(event)) }}
          onPointerUp={event => {
            if (pointer.current !== event.pointerId) return
            const next = playbackRates[Math.round(positionAt(event))]
            cancel()
            void setRate(next)
          }}
          onPointerCancel={cancel} onLostPointerCapture={cancel}/>
      </div>
    </div>
  </CollectionDialog>
}
