import { useState } from 'react'
import { usePlayerStore } from './playerStore'
import { ChapterSeekRange } from '../chapters/ChapterSeekRange'
import type { PlaybackChapter } from '../../domain/playbackChapters'
import { formatDuration } from '../../shared/time'
import type { ReactNode } from 'react'

export function PlayerProgress({ chapters, endControl }: { chapters?: readonly PlaybackChapter[]; endControl?: ReactNode }) {
  const position = usePlayerStore(state => state.progressSeconds)
  const duration = usePlayerStore(state => state.durationSeconds)
  const id = usePlayerStore(state => state.current?.id)
  const [preview, setPreview] = useState<{ id?: string; seconds: number }>()
  const displayed = preview?.id === id ? preview?.seconds ?? position : position
  return <div className="progress" data-chapter-time={endControl ? true : undefined}><small>{formatDuration(displayed, duration >= 3600)}</small><ChapterSeekRange aria-label="播放进度" duration={duration} trackKey={id}
    value={Math.min(position, duration || 0)} chapters={chapters} onPreview={seconds => setPreview(seconds === undefined ? undefined : { id, seconds })} onSeek={seconds => usePlayerStore.getState().seek(seconds)}/>
    {endControl || <small>{formatDuration(duration)}</small>}</div>
}
