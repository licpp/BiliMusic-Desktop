import { usePlayerStore } from './playerStore'
import { RangeControl } from '../../shared/RangeControl'
import { formatDuration } from '../../shared/time'

// Keep the playback ticker out of the application shell: progress updates must
// not reconcile search results, library rows and open menus every 250 ms.
export function PlayerProgress() {
  const position = usePlayerStore(state => state.progressSeconds)
  const duration = usePlayerStore(state => state.durationSeconds)
  const seek = usePlayerStore(state => state.seek)
  return <div className="progress"><small>{formatDuration(position)}</small><RangeControl aria-label="播放进度" min="0" max={Math.max(1, duration)} value={Math.min(position, duration || 0)} onChange={event => seek(Number(event.target.value))} /><small>{formatDuration(duration)}</small></div>
}
