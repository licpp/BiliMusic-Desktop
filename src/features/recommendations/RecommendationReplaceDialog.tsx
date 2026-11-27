import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, Music2, Play, Search, X } from 'lucide-react'
import type { BiliSearchItem } from '../../domain/bilibili'
import type { RecommendationSong, RecommendationSource } from '../../domain/recommendation'
import type { ImportChoice, ImportSong } from '../../services/playlistImportModel'
import { importKeyword } from '../../services/playlistImportModel'
import { resolveReplacementVideo, searchReplacementVideos } from '../../services/playlistImport'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage } from '../../services/userErrors'
import { bindRecommendationSong } from '../../services/recommendations'
import { Artwork } from '../../shared/Artwork'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { formatDuration } from '../../shared/time'
import { formatMatchPlayCount } from '../library/ReplacementDialog'
import { usePlayerStore } from '../player/playerStore'
import '../../styles/components/import-matching.css'

const asImportSong = (song: RecommendationSong): ImportSong => ({
  sourceId: `netease:${song.neteaseSongId}`,
  title: song.title,
  artists: song.artists,
  durationSeconds: song.durationSeconds,
  album: song.album,
  coverUrl: song.coverUrl,
})

/** Manual replacement for one recommendation row; automatic matching can never overwrite it. */
export function RecommendationReplaceDialog({ song, source, day, onBound, onClose }: {
  song: RecommendationSong
  source: RecommendationSource
  day: string
  onBound: (song: RecommendationSong) => void
  onClose: () => void
}) {
  const [keyword, setKeyword] = useState(() => importKeyword(asImportSong(song)))
  const [results, setResults] = useState<BiliSearchItem[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [resolving, setResolving] = useState<string>()
  const [expanded, setExpanded] = useState<string>()
  const [parts, setParts] = useState<ImportChoice[]>([])
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const request = useRef(0)
  const mounted = useRef(true)
  const submitted = useRef(keyword)

  useEffect(() => {
    mounted.current = true
    void search(1, importKeyword(asImportSong(song)))
    const close = () => onClose()
    window.addEventListener('bilimusic-account-changing', close)
    return () => {
      mounted.current = false
      ++request.current
      abort.current?.abort()
      window.removeEventListener('bilimusic-account-changing', close)
    }
  }, [song.neteaseSongId])

  const valid = (ticket: number, epoch: number, signal: AbortSignal) =>
    mounted.current && ticket === request.current && epoch === accountEpoch() && !signal.aborted

  const search = async (nextPage = 1, initialTerm?: string, listen = false) => {
    const term = nextPage === 1 ? (initialTerm ?? keyword).trim() : submitted.current
    if (!term) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    const ticket = ++request.current
    const epoch = accountEpoch()
    if (nextPage === 1) { submitted.current = term; setResults([]); setExpanded(undefined); setParts([]); setPage(0); setHasMore(false) }
    setBusy(true); setResolving(undefined); setError('')
    try {
      const response = await searchReplacementVideos(term, nextPage, controller.signal)
      if (!valid(ticket, epoch, controller.signal)) return
      setResults(previous => {
        const values = nextPage === 1 ? [] : previous
        const seen = new Set(values.map(item => item.bvid))
        return [...values, ...response.items.filter(item => !seen.has(item.bvid) && Boolean(seen.add(item.bvid)))]
      })
      setPage(response.page)
      setHasMore(response.items.length > 0 && response.page * response.pageSize < response.total)
      if (listen && response.items[0]) await resolve(response.items[0], true, ticket, controller)
    } catch (cause) {
      if (valid(ticket, epoch, controller.signal)) setError(commandErrorMessage(cause))
    } finally {
      if (valid(ticket, epoch, controller.signal)) setBusy(false)
    }
  }

  const useChoice = async (choice: ImportChoice) => {
    if (saving) return
    setSaving(true)
    setError('')
    const epoch = accountEpoch()
    try {
      const bound = await bindRecommendationSong(source.id, day, song.neteaseSongId, choice.track, song.entryRevision, source.credentialToken, 'manual')
      if (!mounted.current || epoch !== accountEpoch()) return
      onBound(bound)
      onClose()
    } catch (cause) {
      if (mounted.current && epoch === accountEpoch()) setError(commandErrorMessage(cause))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  const resolve = async (item: BiliSearchItem, listen = false, ticket?: number, controller?: AbortController) => {
    if (saving || resolving) return
    abort.current?.abort()
    const own = controller ?? new AbortController()
    abort.current = own
    const current = ticket ?? ++request.current
    const epoch = accountEpoch()
    setBusy(false); setResolving(item.bvid); setExpanded(item.bvid); setParts([]); setError('')
    try {
      const choices = await resolveReplacementVideo(item.bvid, own.signal)
      if (!valid(current, epoch, own.signal)) return
      if (!choices.length) { setError('这个视频暂时没有可用的分 P'); return }
      if (choices.length === 1) {
        if (listen) await usePlayerStore.getState().play(choices[0].track)
        else await useChoice(choices[0])
      } else setParts(choices)
    } catch (cause) {
      if (valid(current, epoch, own.signal)) setError(commandErrorMessage(cause))
    } finally {
      if (valid(current, epoch, own.signal)) setResolving(undefined)
    }
  }

  return <CollectionDialog title="更换 B 站视频" mobileSheet className="import-match-dialog recommendation-replace" onClose={onClose}>
    <div className="import-match-content">
      <div className="import-match-origin">
        <Artwork src={song.coverUrl} fallback={<Music2 />} />
        <div>
          <strong>{song.title}</strong>
          <span>{song.artists.join(' / ') || '歌手未知'}{song.durationSeconds ? ` · ${formatDuration(song.durationSeconds)}` : ''}</span>
          {song.track && <span className="import-match-current" title={song.track.videoTitle || song.track.title}>当前视频：{song.track.videoTitle || song.track.title}</span>}
        </div>
      </div>
      <form className="import-match-search" onSubmit={event => { event.preventDefault(); (document.activeElement as HTMLElement | null)?.blur(); void search() }}>
        <Search size={19} aria-hidden="true" />
        <input data-dialog-autofocus aria-label="搜索替换视频" placeholder="搜索视频，或粘贴 BV / 链接" value={keyword} disabled={saving} onChange={event => setKeyword(event.target.value)} />
        {keyword && <button type="button" className="import-match-clear" aria-label="清空搜索" disabled={saving} onClick={() => setKeyword('')}><X size={15} /></button>}
        <button type="submit" className="import-match-submit" disabled={busy || saving || !keyword.trim()}>{busy && page === 0 ? <LoaderCircle size={17} className="spin" /> : '搜索'}</button>
      </form>
      {error && <p className="import-match-error" role="alert">{error}</p>}
      <div className="import-match-results" aria-busy={busy}>
        {results.map(item => <article className="import-match-result" key={item.bvid}>
          <div className="import-match-video">
            <button className="import-match-cover" disabled={saving || Boolean(resolving)} aria-label={`试听 ${item.title}`} onClick={() => void resolve(item, true)}>
              <Artwork src={item.coverUrl} adaptAspect /><span className="import-match-cover-overlay"><Play size={18} fill="currentColor" /></span>
            </button>
            <div className="import-match-copy">
              <strong title={item.title}>{item.title}</strong>
              <span className="import-match-uploader">{item.uploaderName}</span>
              <span className="import-match-facts"><span>{formatMatchPlayCount(item.playCount)} 次播放</span><span>{formatDuration(item.durationSeconds)}</span></span>
            </div>
            <button className="import-match-use" disabled={saving || Boolean(resolving)} onClick={() => void resolve(item)} aria-label={`选择视频 ${item.title}`}>
              {resolving === item.bvid ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}<span>选择</span>
            </button>
          </div>
          {expanded === item.bvid && parts.length > 1 && <div className="import-match-parts">
            <p>选择分 P</p>
            {parts.map(choice => <div className="import-match-part" key={choice.track.id}>
              <button className="import-match-part-play" aria-label={`试听 ${choice.track.title}`} disabled={saving} onClick={() => void usePlayerStore.getState().play(choice.track).catch(cause => setError(commandErrorMessage(cause)))}><Play size={16} /></button>
              <span><strong>{choice.evidence.partTitle || choice.track.title}</strong><small>{formatDuration(choice.track.durationSeconds)}</small></span>
              <button className="import-match-use" disabled={saving || choice.track.id === song.track?.id} onClick={() => void useChoice(choice)}>
                {saving ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}<span>{choice.track.id === song.track?.id ? '已选' : '使用'}</span>
              </button>
            </div>)}
          </div>}
        </article>)}
        {!busy && !error && !results.length && <p className="import-match-empty">没有找到视频，试试其他关键词。</p>}
        {busy && <p className="import-match-loading" role="status"><LoaderCircle size={18} className="spin" />正在搜索…</p>}
        {hasMore && <button className="import-match-more" disabled={busy || saving || Boolean(resolving)} onClick={() => void search(page + 1)}><ChevronDown size={17} />更多结果</button>}
      </div>
      <div className="import-match-footer">
        <button type="button" disabled={saving} onClick={onClose}>取消</button>
        {saving && <span role="status"><LoaderCircle size={16} className="spin" />正在保存…</span>}
      </div>
    </div>
  </CollectionDialog>
}
