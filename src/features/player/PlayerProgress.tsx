import { useState } from 'react'
import { usePlayerStore } from './playerStore'
import { SeekRange } from '../../shared/SeekRange'
import { formatDuration } from '../../shared/time'

export function PlayerProgress() {
  const position = usePlayerStore(state => state.progressSeconds)
  const duration = usePlayerStore(state => state.durationSeconds)
  const id = usePlayerStore(state => state.current?.id)
  const [preview, setPreview] = useState<number>()
  return <div className="progress"><small>{formatDuration(preview ?? position)}</small><SeekRange aria-label="播放进度" duration={duration} trackKey={id}
    value={Math.min(position, duration || 0)} onPreview={setPreview} onSeek={seconds => usePlayerStore.getState().seek(seconds)}/><small>{formatDuration(duration)}</small></div>
}
