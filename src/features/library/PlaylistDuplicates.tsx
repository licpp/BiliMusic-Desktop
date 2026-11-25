import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import type { Track } from '../../domain/track'
import type { StoredLyrics } from '../../domain/lyrics'
import { duplicateAudioRank, findPlaylistDuplicates, playlistDuplicateMetadata, preferredDuplicate } from '../../domain/playlistDuplicates'
import { playlistTrackTitle } from '../../services/listOrdering'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage, FAVORITES_PLAYLIST_ID, listPlaylistTracks, removeTracksFromPlaylist } from '../../services/desktopApi'
import { biliPauseMessage, biliRequestPause } from '../../services/biliRequestStatus'
import { useListPreferences } from '../../services/listPreferences'
import { getMediaOptions } from '../../services/mediaSources'
import { cachedVideoDetail, getVideoParts } from '../../services/videoPages'
import { Artwork } from '../../shared/Artwork'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { formatPlayCount } from '../../shared/count'
import { formatTrackDuration } from '../../shared/time'
import { useOfflinePlayback } from '../player/offlinePlayback'
import { updatePlaybackFavorites, usePlayerStore } from '../player/playerStore'
import '../../styles/components/playlist-editing.css'

async function scan(playlistId: string) {
  return findPlaylistDuplicates(await listPlaylistTracks(playlistId))
}

const retentionRules = [
  { id: 'plays', label: '播放量最高' },
  { id: 'audio', label: '音质最高' },
  { id: 'first', label: '排在最前' },
] as const
type Rule = typeof retentionRules[number]['id']
type Comparison = { score: number; label: string }

export function usePlaylistDuplicateNotice(playlistId: string | undefined, tracks: Track[]) {
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  const ids = useRef(tracks)
  ids.current = tracks
  const generation = useRef(0)
  useEffect(() => {
    setCount(0); setOpen(false)
    if (!playlistId) return
    const notify = (event: Event) => {
      const { detail } = event as CustomEvent<StoredLyrics>
      if (!detail?.selectedManually || !ids.current.some(track => track.id === detail.trackId)) return
      void review(new Set([detail.trackId])).catch(() => undefined)
    }
    const close = () => { ++generation.current; setOpen(false); setCount(0) }
    window.addEventListener('bilimusic-lyrics-updated', notify)
    window.addEventListener('bilimusic-account-changing', close)
    return () => {
      ++generation.current
      window.removeEventListener('bilimusic-lyrics-updated', notify)
      window.removeEventListener('bilimusic-account-changing', close)
    }
  }, [playlistId])
  const review = async (matched: ReadonlySet<string>) => {
    if (!playlistId || !matched.size) return
    const ticket = ++generation.current, epoch = accountEpoch()
    const groups = await scan(playlistId)
    if (epoch === accountEpoch() && ticket === generation.current) {
      setCount(groups.filter(group => group.some(track => matched.has(track.id))).length)
    }
  }
  return { count, open, setOpen, clear: () => setCount(0), review }
}

export function PlaylistDuplicateReview({ playlistId, hidden, onPreviewLyrics, onRemoved, onClose, renderDialog }: {
  playlistId: string; onRemoved: () => void; onClose: () => void;
  hidden?: boolean; onPreviewLyrics?: () => void; renderDialog?: (body: ReactNode) => ReactNode
}) {
  const [groups, setGroups] = useState<Track[][]>()
  const [retained, setRetained] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState<Rule>()
  const [notice, setNotice] = useState('')
  const [comparisons, setComparisons] = useState(new Map<string, Comparison>())
  const operation = useRef<object | undefined>(undefined)
  const known = useRef({ plays: new Map<string, Comparison>(), audio: new Map<string, Comparison>() })
  const preferences = useListPreferences()
  const offline = useOfflinePlayback(state => state.offline)
  const alive = useRef(false)
  const groupList = useRef<HTMLDivElement>(null)
  const preview = useRef<{ trackId: string; scroll: number } | undefined>(undefined)
  useLayoutEffect(() => {
    if (hidden || !preview.current || !groupList.current) return
    groupList.current.scrollTop = preview.current.scroll
  }, [hidden])
  useEffect(() => {
    alive.current = true
    const epoch = accountEpoch(), current = () => alive.current && epoch === accountEpoch()
    const close = () => { alive.current = false; operation.current = undefined; onClose() }
    window.addEventListener('bilimusic-account-changing', close)
    void scan(playlistId).then(value => { if (current()) setGroups(value) }, cause => { if (current()) setError(commandErrorMessage(cause)) })
    return () => {
      alive.current = false
      operation.current = undefined
      window.removeEventListener('bilimusic-account-changing', close)
    }
  }, [playlistId])
  const removals = groups?.flatMap(group => retained[group[0].id] ? group.filter(track => track.id !== retained[group[0].id]).map(track => track.id) : []) ?? []
  const selectByRule = async (rule: Rule) => {
    if (!groups || busy || operation.current) return
    const token = {}, epoch = accountEpoch()
    operation.current = token
    const current = () => alive.current && operation.current === token && epoch === accountEpoch()
    const winners: Record<string, string> = {}
    const details = new Map<string, Comparison>()
    let paused = ''
    setChecking(rule); setNotice(''); setError('')
    for (const group of groups) {
      const candidates = group.filter(track => !track.sourceExpired)
      if (rule === 'first' || candidates.length <= 1) {
        if (candidates[0]) winners[group[0].id] = candidates[0].id
        continue
      }
      for (const track of candidates) {
        if (!current()) return
        const { bvid, cid } = track.source
        const key = rule === 'plays' ? bvid : track.id
        let value = known.current[rule].get(key)
        try {
          if (!value && rule === 'plays') {
            const count = cachedVideoDetail(bvid)?.playCount ?? preferences.data?.playCounts?.[bvid] ?? track.playCount
              ?? (offline ? undefined : (await getVideoParts(bvid, false, { background: true })).playCount)
            if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
              value = { score: count, label: `${formatPlayCount(count)} 次播放` }
            }
          } else if (!value && !offline && cid > 0) {
            const option = (await getMediaOptions(bvid, cid, true)).audio[0]
            const score = duplicateAudioRank(option?.audioQuality)
            if (score !== undefined) value = { score, label: option.label }
          }
        } catch (cause) {
          const pause = biliRequestPause(cause)
          if (pause) { paused = biliPauseMessage(pause); break }
        }
        if (!current()) return
        if (value) {
          known.current[rule].set(key, value)
          details.set(track.id, value)
        }
      }
      if (paused) break
      const winner = preferredDuplicate(candidates, track => details.get(track.id)?.score)
      if (winner) winners[group[0].id] = winner.id
    }
    if (!current()) return
    const chosen = Object.keys(winners).length
    setRetained(winners)
    setComparisons(details)
    setNotice(`自动选择 ${chosen} 组${chosen < groups.length ? ` · ${groups.length - chosen} 组待确认` : ''}`)
    if (paused) setError(paused)
    operation.current = undefined
    setChecking(undefined)
  }
  const stopRule = () => {
    operation.current = undefined
    setChecking(undefined)
    setNotice('已停止自动选择')
  }
  const remove = async () => {
    const epoch = accountEpoch(), current = () => alive.current && epoch === accountEpoch()
    setBusy(true); setError('')
    try {
      const latest = await scan(playlistId)
      if (!current()) return
      const signature = (items: Track[][]) => JSON.stringify(items.map(group => group.map(track => track.id)))
      if (signature(latest) !== signature(groups ?? [])) {
        setGroups(latest); setRetained({}); setNotice(''); setComparisons(new Map())
        setError('歌单已更新，请重新选择要保留的歌曲')
        return
      }
      await removeTracksFromPlaylist(playlistId, removals)
      if (current()) {
        if (playlistId === FAVORITES_PLAYLIST_ID) {
          updatePlaybackFavorites(new Map(removals.map(id => [id, false])))
        }
        onRemoved()
        onClose()
      }
    } catch (cause) {
      if (current()) setError(commandErrorMessage(cause))
    } finally {
      if (current()) setBusy(false)
    }
  }
  if (hidden) return null
  const locked = busy || Boolean(checking)
  const body = <div className="playlist-duplicate-review">
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!groups && !error && <p role="status">正在检查歌单…</p>}
    {groups?.length === 0 && <p role="status">没有发现可能重复的歌曲</p>}
    {groups && groups.length > 0 && <>
      <div className="playlist-duplicate-rules" role="group" aria-label="自动选择保留版本">
        <span aria-hidden="true">优先保留</span>
        {retentionRules.map(({ id, label }) => <button type="button" className="collection-flat-button" key={id}
          disabled={locked || id === 'audio' && offline} onClick={() => void selectByRule(id)}>{label}</button>)}
      </div>
      {checking ? <div className="playlist-duplicate-rule-status">
        <span role="status">{checking === 'audio' ? '正在读取音质…' : '正在读取播放量…'}</span>
        <button type="button" className="collection-flat-button" onClick={stopRule}>停止</button>
      </div> : notice && <p className="playlist-duplicate-rule-status" role="status">{notice}</p>}
      <div className="playlist-duplicate-groups" ref={groupList}>
        {groups.map(group => <fieldset key={group[0].id}>
          <legend>{playlistTrackTitle(group[0])}</legend>
          {group.map(track => {
            const comparison = comparisons.get(track.id)
            const { artist, album } = playlistDuplicateMetadata(track)
            return <div className="playlist-duplicate-row" key={track.id}>
              <label>
                <input type="radio" name={group[0].id} checked={retained[group[0].id] === track.id} disabled={locked}
                  onChange={() => setRetained(previous => ({ ...previous, [group[0].id]: track.id }))}/>
                <Artwork src={track.coverUrl} adaptAspect/>
                <span>
                  <strong>{playlistTrackTitle(track)}</strong>
                  <small title={comparison?.label}>{comparison && `${comparison.label} · `}
                    {artist} · {album} · {formatTrackDuration(track.durationSeconds)}</small>
                  <small className="playlist-duplicate-source" title={track.videoTitle}>{track.videoTitle || track.source.bvid}</small>
                </span>
              </label>
              <button type="button" className="icon-action large-icon" title={onPreviewLyrics ? '试听并查看歌词' : '试听'}
                data-dialog-autofocus={preview.current?.trackId === track.id ? '' : undefined} disabled={locked}
                aria-label={`试听 ${playlistTrackTitle(track)}`} onClick={() => {
                  preview.current = { trackId: track.id, scroll: groupList.current?.scrollTop ?? 0 }
                  onPreviewLyrics?.()
                  void usePlayerStore.getState().play(track)
                }}><Play size={16}/></button>
            </div>
          })}
          {retained[group[0].id] && <button type="button" className="collection-flat-button" disabled={locked}
            onClick={() => setRetained(previous => ({ ...previous, [group[0].id]: '' }))}>跳过这组</button>}
        </fieldset>)}
      </div>
    </>}
    <footer>
      <button type="button" className="collection-flat-button" disabled={busy} onClick={onClose}>关闭</button>
      {!!removals.length && <button type="button" className="collection-primary" disabled={locked} onClick={() => void remove()}>移除 {removals.length} 首</button>}
    </footer>
  </div>
  return renderDialog ? renderDialog(body) : <CollectionDialog title="查找重复" mobileSheet className="playlist-duplicates-dialog" onClose={onClose}>{body}</CollectionDialog>
}
