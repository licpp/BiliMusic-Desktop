import { LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { MAX_COMMENT_CHAPTERS, MAX_COMMENT_CHAPTER_TITLE, parseChapterTime, type CommentChapterCandidate, type CommentChapter } from '../../domain/commentChapters'
import { commandErrorMessage } from '../../services/desktopApi'
import { formatDuration } from '../../shared/time'

type DraftRow = { id: number; time: string; title: string; author?: string }

const toChapterTime = (startMs: number) => {
  const fraction = Math.floor(startMs % 1000)
  const time = formatDuration(startMs / 1000)
  return fraction ? `${time}.${String(fraction).padStart(3, '0')}` : time
}

export function ChapterEditor({ initialChapters, durationSeconds, sourceAuthor, onSave, onCancel, isCurrent }: {
  initialChapters: readonly CommentChapterCandidate[]
  durationSeconds: number
  sourceAuthor?: string
  onSave: (chapters: CommentChapter[]) => Promise<void>
  onCancel: () => void
  isCurrent?: () => boolean
}) {
  const [rows, setRows] = useState<DraftRow[]>(() => initialChapters.map(({ startMs, ...row }, id) => ({ ...row, id, time: toChapterTime(startMs) })))
  const nextId = useRef(initialChapters.length)
  const addedId = useRef<number | undefined>(undefined)
  const focusAdded = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    if (addedId.current !== undefined) focusAdded.current?.focus()
    addedId.current = undefined
  }, [rows.length])

  const change = (id: number, field: 'time' | 'title', value: string) => {
    setRows(current => current.map(row => row.id === id ? { ...row, [field]: value } : row))
    setError('')
  }
  const add = () => {
    const id = nextId.current++
    addedId.current = id
    setRows(current => [...current, { id, time: '', title: '' }])
    setError('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving.current || isCurrent?.() === false) return
    if (!rows.length || rows.length > MAX_COMMENT_CHAPTERS) {
      setError(`请保留 1 至 ${MAX_COMMENT_CHAPTERS} 段`)
      return
    }
    const chapters: CommentChapter[] = []
    const times = new Set<number>()
    for (const [index, row] of rows.entries()) {
      const startMs = parseChapterTime(row.time)
      const title = row.title.trim()
      if (startMs === undefined || (durationSeconds > 0 && startMs >= durationSeconds * 1000)) {
        setError(`第 ${index + 1} 段的时间无效，请填写本分 P 内的时间`)
        return
      }
      if (!title || Array.from(title).length > MAX_COMMENT_CHAPTER_TITLE) {
        setError(`第 ${index + 1} 段的标题须为 1 至 ${MAX_COMMENT_CHAPTER_TITLE} 个字符`)
        return
      }
      if (times.has(startMs)) {
        setError(`起点 ${toChapterTime(startMs)} 重复，请修改或移除其中一段`)
        return
      }
      times.add(startMs)
      chapters.push({ startMs, title })
    }
    chapters.sort((a, b) => a.startMs - b.startMs)
    saving.current = true
    setBusy(true)
    setError('')
    try { await onSave(chapters) }
    catch (cause) {
      if (mounted.current && isCurrent?.() !== false) setError(commandErrorMessage(cause))
    } finally {
      saving.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <form className="chapter-edit-form" onSubmit={event => void submit(event)}>
    <div className="chapter-edit-labels" aria-hidden="true"><span>起点</span><span>章节标题</span></div>
    <div className="chapter-edit-scroll">
      {rows.map(({ id, title, time, author }, index) => <div className="chapter-edit-row" key={id}>
        <input className="chapter-edit-time" type="text" spellCheck={false} autoComplete="off" value={time} disabled={busy}
          ref={id === addedId.current ? focusAdded : undefined}
          onChange={event => change(id, 'time', event.target.value)} placeholder="0:00" aria-label={`第 ${index + 1} 段起点`} />
        <div className="chapter-edit-title"><input type="text" value={title} disabled={busy} placeholder="章节标题"
          onChange={event => change(id, 'title', event.target.value)} aria-label={`第 ${index + 1} 段标题`} />
          {author && author !== sourceAuthor && <small title={author}>{author}</small>}</div>
        <button type="button" className="chapter-edit-remove" aria-label={`移除第 ${index + 1} 段`} disabled={busy}
          onClick={() => { setRows(current => current.filter(row => row.id !== id)); setError('') }}><Trash2 size={16} aria-hidden="true" /></button>
      </div>)}
    </div>
    <div className="chapter-edit-controls">
      {error && <div role="alert" className="chapter-edit-error">{error}</div>}
      <div className="chapter-edit-actions">
        <button className="chapter-edit-add" type="button" disabled={busy || rows.length >= MAX_COMMENT_CHAPTERS} onClick={add}><Plus size={17} aria-hidden="true" />添加章节</button>
        <button className="chapter-edit-cancel" type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="submit" className="chapter-edit-confirm" disabled={busy} aria-busy={busy}>{busy && <LoaderCircle className="spin" size={16} aria-hidden="true" />}保存章节</button>
      </div>
    </div>
  </form>
}
