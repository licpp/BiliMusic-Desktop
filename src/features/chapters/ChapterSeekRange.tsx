import { useState, type ComponentProps, type CSSProperties } from 'react'
import { chapterIndexAt, type PlaybackChapter } from '../../domain/playbackChapters'
import { progressAtPointerInRect } from '../../domain/playbackProgress'
import { SeekRange } from '../../shared/SeekRange'
import { formatDuration } from '../../shared/time'

type Props = ComponentProps<typeof SeekRange> & { chapters?: readonly PlaybackChapter[] }

export function ChapterSeekRange({ chapters, ...props }: Props) {
  return chapters
    ? <ChapterPreviewRange key={props.trackKey} chapters={chapters} {...props}/>
    : <SeekRange {...props}/>
}

function ChapterPreviewRange({ chapters, duration, onPreview, ...props }: Props & { chapters: readonly PlaybackChapter[] }) {
  const [pointer, setPointer] = useState<{ at: number; dragging: boolean }>()
  const canPreview = duration > 0 && chapters.length > 0 && !props.disabled
  const preview = canPreview ? pointer?.at : undefined
  const chapter = preview === undefined ? undefined : chapters[chapterIndexAt(chapters, preview * 1000)]
  return <div className="chapter-seek" onPointerMove={event => {
    if (!canPreview || event.pointerType !== 'mouse' || pointer?.dragging) return
    setPointer({ dragging: false, at: progressAtPointerInRect(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), duration) })
  }} onPointerLeave={() => { if (!pointer?.dragging) setPointer(undefined) }} onBlur={() => setPointer(undefined)}>
    <SeekRange {...props} duration={duration} onPreview={seconds => {
      if (canPreview) setPointer(seconds === undefined ? undefined : { at: seconds, dragging: true })
      onPreview?.(seconds)
    }}/>
    {preview !== undefined && <span className="chapter-seek-preview" aria-hidden="true" style={{ '--chapter-preview-x': `${preview / duration * 100}%` } as CSSProperties}>
      <time>{formatDuration(preview, duration >= 3600)}</time>{chapter && <span>{chapter.title}</span>}
    </span>}
  </div>
}
