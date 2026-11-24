import { useLayoutEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { chapterIndexAt, type PlaybackChapter } from '../../domain/playbackChapters'
import { usePlayerStore } from '../player/playerStore'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { usePanelReveal } from '../../shared/usePanelReveal'
import { formatDuration } from '../../shared/time'
import { commandErrorMessage } from '../../services/desktopApi'
import { ChapterEditor } from '../comments/ChapterEditor'
import type { PlaybackChapters } from './usePlaybackChapters'

export function ChapterRows({ items, duration, onSeek, autoFocus = false }: {
  items: readonly PlaybackChapter[]; duration: number; onSeek: (seconds: number) => void; autoFocus?: boolean
}) {
  const index = usePlayerStore(state => chapterIndexAt(items, state.progressSeconds * 1000))
  const list = useRef<HTMLOListElement>(null)
  const initialIndex = useRef(index)
  useLayoutEffect(() => {
    const box = list.current
    const button = box?.querySelectorAll<HTMLButtonElement>('button')[Math.max(0, initialIndex.current)]
    if (!button || !box) return
    box.scrollTop = Math.max(0, button.offsetTop - (box.clientHeight - button.offsetHeight) / 2)
    if (autoFocus) button.focus({ preventScroll: true })
  }, [autoFocus])
  return <ol className="chapter-rows" ref={list}>
    {items.map((chapter, position) => <li key={chapter.startMs}>
      <button type="button" data-focus={`chapter:${chapter.startMs}`} data-dialog-autofocus={position === Math.max(0, index) || undefined}
        aria-current={position === index ? 'true' : undefined} onClick={() => onSeek(chapter.startMs / 1000)}>
        <time>{formatDuration(chapter.startMs / 1000, duration >= 3600)}</time>
        <span title={chapter.title}>{chapter.title}</span>
      </button>
    </li>)}
  </ol>
}

export function ChapterDirectory({ model, mobile, open, fullscreen = false }: { model: PlaybackChapters; mobile: boolean; open: boolean; fullscreen?: boolean }) {
  const directory = useRef<HTMLElement>(null)
  const [editor, setEditor] = useState<{ rows: NonNullable<PlaybackChapters['existingChapters']>; save: PlaybackChapters['save'] }>()
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const closeEditor = () => {
    setEditor(undefined)
    setRemoving(false)
    setError('')
  }
  useOverlayDismiss(directory, open && !mobile, model.close)
  usePanelReveal(directory, open && !mobile)
  useLayoutEffect(() => {
    if (open && !mobile) {
      directory.current?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus({ preventScroll: true })
    } else if (!open) closeEditor()
  }, [open, mobile])
  const rows = <ChapterRows items={model.items} duration={model.duration} onSeek={seconds => {
    model.seek(seconds)
    if (mobile || fullscreen || window.matchMedia('(max-width: 960px)').matches) model.close()
  }}/>
  const tools = model.canEdit && <button type="button" className="chapter-list-edit" onClick={() => {
    if (model.existingChapters) setEditor({ rows: model.existingChapters, save: model.save })
  }}><Pencil size={15}/>编辑</button>
  const source = <small>{model.origin === 'official' ? 'B 站章节' : '来自评论'}</small>
  return <>
    {mobile ? <CollectionDialog title="章节" className="chapter-sheet" mobileSheet onClose={model.close}>
      <div className="chapter-sheet-tools">{source}{tools}</div>{rows}
    </CollectionDialog> : <aside ref={directory} className="chapter-directory" inert={!open} aria-label="章节">
      <header><h2>章节</h2>{source}{tools}<button type="button" className="chapter-dismiss" aria-label="收起章节" onClick={model.close}><X size={18}/></button></header>
      {rows}
    </aside>}
    {open && editor && <CollectionDialog title="编辑章节" className="chapter-editor-dialog" mobileSheet={mobile} onClose={closeEditor}>
      <ChapterEditor initialChapters={editor.rows} durationSeconds={model.duration} isCurrent={model.isCurrent} onSave={async chapters => {
        await editor.save(chapters)
        closeEditor()
      }} onCancel={closeEditor}/>
      {removing ? <div className="chapter-remove-confirm">
        <span>移除当前分 P 保存的章节？</span>
        <button type="button" disabled={busy} onClick={() => setRemoving(false)}>取消</button>
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true)
          setError('')
          try { await editor.save(null); closeEditor(); model.close() }
          catch (cause) { setError(commandErrorMessage(cause)) }
          finally { setBusy(false) }
        }}>移除</button>
      </div> : <button type="button" className="chapter-remove" onClick={() => setRemoving(true)}>移除已保存章节</button>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </CollectionDialog>}
  </>
}
