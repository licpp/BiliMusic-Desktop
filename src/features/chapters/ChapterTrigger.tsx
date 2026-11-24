import { ListTree } from 'lucide-react'
import { chapterIndexAt } from '../../domain/playbackChapters'
import { formatDuration } from '../../shared/time'
import { usePlayerStore } from '../player/playerStore'
import type { PlaybackChapters } from './usePlaybackChapters'

export function ChapterTrigger({ model, variant = 'icon' }: { model: PlaybackChapters; variant?: 'icon' | 'time' | 'text' }) {
  const index = usePlayerStore(state => chapterIndexAt(model.items, state.progressSeconds * 1000))
  if (!model.items.length) return null
  const title = model.items[index]?.title
  const label = title ? `章节 · ${title}` : '章节'
  return <button type="button" className={`chapter-trigger chapter-trigger-${variant}`} aria-label={label} title={label}
    aria-expanded={model.directoryOpen} onClick={event => model.toggle(event.currentTarget)}>
    {variant === 'time' && <small>{formatDuration(model.duration)}</small>}
    <ListTree size={18} aria-hidden="true"/>
    {variant === 'text' && <span>章节</span>}
  </button>
}
