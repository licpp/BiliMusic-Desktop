import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarHeart,
  Check,
  ListPlus,
  LoaderCircle,
  MoreHorizontal,
  Music2,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
} from 'lucide-react'
import { commandErrorMessage } from '../../services/userErrors'
import { prepareRecommendationTracks } from '../../services/desktopApi'
import { accountEpoch } from '../../services/accountScope'
import {
  dailyRecommendation,
  listRecommendationSources,
  RECOMMENDATION_SOURCE_STORAGE,
  recommendationQueryKey,
  refreshRecommendation,
  resetRecommendationMatches,
} from '../../services/recommendations'
import { runRecommendationMatching, stopRecommendationMatching, useRecommendationMatch } from '../../services/recommendationMatching'
import {
  playableRecommendationTracks,
  recommendationDay,
  recommendationDayLabel,
  recommendationMatchSummary,
  recommendationPendingSongs,
  recommendationPlaybackNotice,
  replaceRecommendationSong,
  type RecommendationSnapshot,
  type RecommendationSong,
  type RecommendationSource,
} from '../../domain/recommendation'
import { ActionMenu } from '../../shared/ActionMenu'
import { Artwork } from '../../shared/Artwork'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { PlayingMark } from '../../shared/PlayingMark'
import { formatDuration } from '../../shared/time'
import { TrackMenuButton } from '../library/TrackActions'
import { playbackIntent, usePlayerStore } from '../player/playerStore'
import type { Track } from '../../domain/track'
import { RecommendationReplaceDialog } from './RecommendationReplaceDialog'
import { RecommendationPlaylistDialog } from './RecommendationPlaylistDialog'
import { RecommendationSourceDialog } from './RecommendationSourceDialog'

export function RecommendationView({ active }: { active: boolean }) {
  const client = useQueryClient()
  const day = useRecommendationDay(active)
  const sources = useQuery({ queryKey: recommendationQueryKey.sources, queryFn: listRecommendationSources, enabled: active })
  const sourceList = sources.data ?? []
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(RECOMMENDATION_SOURCE_STORAGE) ?? '')
  const selectSource = (sourceId: string) => {
    setSelectedId(sourceId)
    if (sourceId) localStorage.setItem(RECOMMENDATION_SOURCE_STORAGE, sourceId)
    else localStorage.removeItem(RECOMMENDATION_SOURCE_STORAGE)
  }
  useEffect(() => {
    if (!sourceList.length) return
    if (!sourceList.some(source => source.id === selectedId)) selectSource(sourceList[0].id)
  }, [sourceList, selectedId])
  const source = sourceList.find(item => item.id === selectedId) ?? sourceList[0]
  const dailyKey = source ? recommendationQueryKey.daily(source.id, day) : undefined
  const daily = useQuery({
    queryKey: dailyKey ?? recommendationQueryKey.none,
    queryFn: () => dailyRecommendation(source!.id, day),
    enabled: active && Boolean(source),
    staleTime: 0,
  })
  const snapshot = daily.data
  const [sourceDialog, setSourceDialog] = useState<'list' | 'login' | 'add' | null>(null)
  const [playlistDialog, setPlaylistDialog] = useState(false)
  const [replacing, setReplacing] = useState<RecommendationSong>()
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [actionError, setActionError] = useState('')
  const [laneRevision, setLaneRevision] = useState(0)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  useEffect(() => {
    if (active) return
    setSourceDialog(null)
    setPlaylistDialog(false)
    setReplacing(undefined)
    setConfirmEmpty(false)
  }, [active])

  const refresh = useMutation({
    mutationFn: (input: { sourceId: string; token: string; confirmEmpty: boolean }) =>
      refreshRecommendation(input.sourceId, day, input.token, input.confirmEmpty),
    onSuccess: (result, input) => {
      if (result.snapshot) client.setQueryData(recommendationQueryKey.daily(input.sourceId, day), result.snapshot)
      setConfirmEmpty(result.needsConfirmation)
      if (!result.needsConfirmation) setActionError('')
      void client.invalidateQueries({ queryKey: recommendationQueryKey.sources })
    },
    onError: cause => {
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      const needsLogin = code === 'netease_auth_required' || code === 'netease_verification_required'
      // Login and safety-gate failures get the actionable source banner instead
      // of a generic retry that would only re-hit the same gate.
      setActionError(needsLogin ? '' : commandErrorMessage(cause))
      // A failed refresh still persists the source state (for example
      // auth-required after a safety gate); refetch so the row label and the
      // automatic-refresh guard see what the backend recorded.
      void client.invalidateQueries({ queryKey: recommendationQueryKey.sources })
    },
  })
  const refreshing = refresh.isPending

  const attempted = useRef(new Set<string>())
  useEffect(() => {
    if (!active || !source || refreshing || daily.isLoading || daily.isFetching || snapshot) return
    if (source.lastRefreshState === 'auth-required') return
    const key = `${source.id}:${day}:${source.credentialToken}`
    if (attempted.current.has(key)) return
    attempted.current.add(key)
    refresh.mutate({ sourceId: source.id, token: source.credentialToken, confirmEmpty: false })
  }, [active, source?.id, source?.credentialToken, source?.lastRefreshState, day, snapshot, daily.isLoading, daily.isFetching, refreshing])

  useEffect(() => {
    if (!active || !source || !snapshot?.songs.length) return
    if (!recommendationPendingSongs(snapshot.songs, Date.now()).length) return
    let cancelled = false
    let timer = 0
    const tick = async () => {
      if (cancelled) return
      const latest = snapshotRef.current
      if (!latest) return
      const outcome = await runRecommendationMatching({
        sourceId: source.id,
        day,
        token: source.credentialToken,
        songs: latest.songs,
        onSong: song => client.setQueryData<RecommendationSnapshot>(recommendationQueryKey.daily(source.id, day), previous =>
          previous ? replaceRecommendationSong(previous, song) : previous),
        onStale: () => {
          void client.invalidateQueries({ queryKey: recommendationQueryKey.daily(source.id, day) })
          // A stale row revision means another writer won; restart from the
          // refreshed snapshot instead of finishing a doomed pass.
          setLaneRevision(value => value + 1)
        },
      })
      if (cancelled) return
      if (outcome === 'paused' || outcome === 'waiting') {
        const retryAt = useRecommendationMatch.getState()[source.id]?.retryAt
        const delay = outcome === 'waiting' ? 4000 : Math.max(5000, (retryAt ?? 0) - Date.now())
        timer = window.setTimeout(() => void tick(), Math.min(delay, 10 * 60_000))
      }
    }
    void tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      stopRecommendationMatching(source.id)
    }
  }, [active, source?.id, source?.credentialToken, day, snapshot?.fetchedAt, laneRevision, client])

  const matchStatus = useRecommendationMatch(state => (source ? state[source.id] : undefined))
  const summary = useMemo(() => recommendationMatchSummary(snapshot?.songs ?? []), [snapshot?.songs])
  const playable = useMemo(() => playableRecommendationTracks(snapshot?.songs ?? []), [snapshot?.songs])
  const label = recommendationDayLabel(day)
  const notice = snapshot ? recommendationPlaybackNotice(summary.total, summary.matched) : undefined
  const current = usePlayerStore(state => state.current)
  const queueSource = usePlayerStore(state => state.queueSource)

  const playRequest = useRef(0)
  const play = async (trackId?: string) => {
    if (!source || !playable.length || !trackId) return
    const request = ++playRequest.current
    const intent = playbackIntent()
    const epoch = accountEpoch()
    const current = () => request === playRequest.current && intent === playbackIntent() && epoch === accountEpoch()
    try {
      const tracks = await prepareRecommendationTracks(playable)
      if (!current()) return
      void usePlayerStore.getState().playFromList(tracks, trackId, {
        kind: 'recommendation',
        title: source.name,
        visibilityManaged: false,
      })
    } catch (error) {
      if (current()) setActionError(commandErrorMessage(error))
    }
  }
  const enqueue = async (track: Track) => {
    const epoch = accountEpoch()
    try {
      const tracks = await prepareRecommendationTracks([track])
      if (epoch === accountEpoch()) usePlayerStore.getState().enqueue(tracks)
    } catch (error) {
      if (epoch === accountEpoch()) setActionError(commandErrorMessage(error))
    }
  }
  const retryRefresh = () => {
    if (!source) return
    setActionError('')
    setConfirmEmpty(false)
    refresh.mutate({ sourceId: source.id, token: source.credentialToken, confirmEmpty: false })
  }
  const clearToday = () => {
    if (!source) return
    refresh.mutate({ sourceId: source.id, token: source.credentialToken, confirmEmpty: true })
  }
  const resetMatches = async () => {
    if (!source || resetting) return
    setResetting(true)
    setActionError('')
    try {
      await resetRecommendationMatches(source.id, day, source.credentialToken)
      const fresh = await dailyRecommendation(source.id, day)
      if (fresh) client.setQueryData(recommendationQueryKey.daily(source.id, day), fresh)
      setLaneRevision(value => value + 1)
    } catch (cause) {
      setActionError(commandErrorMessage(cause))
    } finally {
      setResetting(false)
    }
  }
  const boundSong = (song: RecommendationSong) => {
    if (!dailyKey) return
    client.setQueryData<RecommendationSnapshot>(dailyKey, previous => previous ? replaceRecommendationSong(previous, song) : previous)
  }

  const matchingLabel = (() => {
    if (refreshing) return '正在从推荐源获取今日推荐…'
    if (matchStatus?.running) return `正在匹配 ${matchStatus.remaining ?? 0} 首`
    if (matchStatus?.pause) return matchStatus.pause.reason === 'verificationRequired' ? 'B 站需要完成验证后才能继续匹配' : matchStatus.pause.reason === 'authRequired' ? '请重新登录 B 站账号以继续匹配' : 'B 站暂时限制了请求，稍后自动继续'
    if (matchStatus?.error) return matchStatus.error
    if (summary.pending > 0 && snapshot) return `${summary.pending} 首等待匹配`
    return ''
  })()

  return (
    <section className="recommendation-view" aria-label="每日推荐">
      {source && <header className="recommendation-banner">
        <div className="recommendation-date" aria-label={`${label.month} 月 ${label.day} 日`}>
          <strong>{label.day}</strong><span>/ {label.month}</span>
        </div>
        <div className="recommendation-banner-copy">
          <h2>今日歌单</h2>
          <div className="recommendation-banner-meta">
            <span className="recommendation-current-source">{source.name}</span>
            {snapshot && <span>{summary.matched} / {summary.total} 首已匹配</span>}
            {matchingLabel && <span className="recommendation-match-status" role="status">{matchingLabel}</span>}
          </div>
        </div>
        <div className="recommendation-banner-actions">
          <button type="button" className="primary-action" disabled={!playable.length} onClick={() => play(playable[0]?.id)}>
            <Play size={17} fill="currentColor" />播放全部
          </button>
          <ActionMenu label="更多推荐操作" icon={<MoreHorizontal size={19} />} panelClassName="recommendation-menu">
            {close => <>
              <button role="menuitem" disabled={!playable.length} onClick={() => { close(); setPlaylistDialog(true) }}>
                <ListPlus size={16} /><span><strong>添加为歌单</strong><small>把已匹配的 {playable.length} 首保存成歌单</small></span>
              </button>
              <button role="menuitem" disabled={!source || refreshing} onClick={() => { close(); retryRefresh() }}>
                <RefreshCw size={16} /><span><strong>刷新今日推荐</strong><small>重新从推荐源获取列表</small></span>
              </button>
              <button role="menuitem" disabled={!snapshot || resetting || matchStatus?.running} onClick={() => { close(); void resetMatches() }}>
                {resetting ? <LoaderCircle size={16} className="spin" /> : <Repeat2 size={16} />}<span><strong>重新匹配全部</strong><small>手动选择的视频会保留</small></span>
              </button>
              <button role="menuitem" onClick={() => { close(); setSourceDialog('list') }}>
                <Plus size={16} /><span><strong>推荐源设置</strong><small>添加、重命名或重新登录</small></span>
              </button>
            </>}
          </ActionMenu>
        </div>
      </header>}

      {sourceList.length > 0 && <div className="recommendation-sources" role="tablist" aria-label="推荐源">
        {sourceList.map(item => <button key={item.id} type="button" role="tab" aria-selected={item.id === source?.id}
          className="recommendation-source-chip" onClick={() => selectSource(item.id)}>
          <Music2 size={14} /><span>{item.name}</span>
        </button>)}
        <button type="button" className="recommendation-source-add" onClick={() => setSourceDialog('list')}><Plus size={14} /><span>添加推荐源</span></button>
      </div>}

      {actionError && <div className="recommendation-alert" role="alert">
        <AlertTriangle size={17} /><span>{actionError}</span>
        {source && <button type="button" onClick={retryRefresh}>重试</button>}
      </div>}
      {source?.lastRefreshState === 'auth-required' && !actionError && <div className="recommendation-alert" role="alert">
        <AlertTriangle size={17} /><span>{source.lastErrorCode === 'netease_verification_required'
          ? '推荐源要求安全验证，请稍后重试或重新登录。'
          : '推荐源登录已失效，需要重新登录。'}</span>
        <button type="button" onClick={() => setSourceDialog('login')}>重新登录</button>
      </div>}
      {confirmEmpty && <div className="recommendation-alert" role="alert">
        <AlertTriangle size={17} /><span>推荐源今天没有返回歌曲。保留现有列表，还是清空今天的推荐？</span>
        <button type="button" className="danger" onClick={clearToday}>清空今日列表</button>
        <button type="button" onClick={() => { setConfirmEmpty(false); void client.invalidateQueries({ queryKey: dailyKey }) }}>保留</button>
      </div>}

      {!source ? (sources.isLoading ? <ListSkeleton label="正在读取推荐源"/> : <NoSource onAdd={() => setSourceDialog('add')} />) : daily.isLoading && !snapshot ? <ListSkeleton label="正在读取今日推荐" /> : snapshot
        ? <RecommendationTracks songs={snapshot.songs} playable={playable} currentId={current?.id}
          queueActive={queueSource?.kind === 'recommendation' && queueSource.title === source.name}
          notice={notice} onPlay={play} onEnqueue={enqueue} onReplace={setReplacing} />
        : !refreshing && !actionError && <div className="recommendation-empty">
          <CalendarHeart size={26} />
          <strong>今天还没有可显示的推荐</strong>
          <p>推荐源可能还没有生成今日推荐，稍后再试。</p>
          <button type="button" className="recommendation-primary" onClick={retryRefresh}><RefreshCw size={15} />立即获取</button>
        </div>}

      {replacing && source && snapshot && <RecommendationReplaceDialog song={replacing} source={source} day={snapshot.day}
        onBound={boundSong} onClose={() => setReplacing(undefined)} />}
      {sourceDialog && <RecommendationSourceDialog initialView={sourceDialog} sources={sourceList} selectedId={source?.id} onSelect={selectSource}
        onClose={() => setSourceDialog(null)} />}
      {playlistDialog && source && <RecommendationPlaylistDialog day={day} sourceName={source.name} tracks={playable}
        onClose={() => setPlaylistDialog(false)} />}
    </section>
  )
}

function useRecommendationDay(active: boolean) {
  const [day, setDay] = useState(() => recommendationDay(new Date()))
  useEffect(() => {
    if (!active) return
    const update = () => setDay(current => {
      const next = recommendationDay(new Date())
      return next === current ? current : next
    })
    update()
    const timer = window.setInterval(update, 60_000)
    return () => window.clearInterval(timer)
  }, [active])
  return day
}

function NoSource({ onAdd }: { onAdd: () => void }) {
  return <div className="recommendation-empty recommendation-connect">
    <CalendarHeart size={28} aria-hidden="true"/>
    <strong>连接网易云音乐</strong>
    <p>在这里查看你的每日推荐。</p>
    <button type="button" className="recommendation-primary" onClick={onAdd}>添加推荐源</button>
  </div>
}

function RecommendationTracks({ songs, playable, currentId, queueActive, notice, onPlay, onEnqueue, onReplace }: {
  songs: RecommendationSong[]
  playable: ReturnType<typeof playableRecommendationTracks>
  currentId?: string
  queueActive: boolean
  notice?: string
  onPlay: (trackId: string) => void
  onEnqueue: (track: Track) => void
  onReplace: (song: RecommendationSong) => void
}) {
  const byTrack = new Map(playable.map(track => [track.id, track]))
  return <section className="recommendation-tracks" aria-label="今日推荐歌曲">
    <header>
      <div><span className="eyebrow">TODAY'S PICKS</span><h3>{queueActive ? '正在播放今日推荐' : '今日歌曲'}</h3></div>
      <span className="recommendation-count">{songs.length} 首</span>
    </header>
    {notice && <p className="recommendation-notice">{notice}</p>}
    <ol className="recommendation-list">
      {songs.map((song, index) => {
        const track = song.track && byTrack.get(song.track.id)
        const playing = Boolean(track && currentId === track.id)
        return <li key={song.neteaseSongId} data-state={song.matchState} data-current={playing || undefined}
          onDoubleClick={event => { if (track && !(event.target as Element).closest('button')) onPlay(track.id) }}>
          <button type="button" className="recommendation-play" disabled={!track} aria-label={track ? `播放 ${song.title}` : `${song.title} 还没有匹配到 B 站视频`}
            aria-current={playing ? 'true' : undefined} onClick={() => track && onPlay(track.id)}>
            {playing ? <PlayingMark /> : <><span>{index + 1}</span><Play size={14} fill="currentColor" /></>}
          </button>
          <Artwork src={song.coverUrl} className="recommendation-cover" />
          <div className="recommendation-song">
            <strong title={song.title}>{song.title}</strong>
            <small title={song.artists.join(' / ')}>{song.artists.join(' / ') || '歌手未知'}{song.album ? ` · ${song.album}` : ''}</small>
          </div>
          <div className="recommendation-match">
            {track
              ? <><span className="recommendation-badge" data-state="matched"><Check size={12} />已匹配</span><small title={track.videoTitle || track.title}>{track.videoTitle || track.title}</small></>
              : song.matchState === 'pending'
                ? <span className="recommendation-badge" data-state="pending"><LoaderCircle size={12} className="spin" />待匹配</span>
                : <span className="recommendation-badge" data-state={song.matchState}>{song.matchState === 'failed' ? '匹配失败' : '未找到'}</span>}
          </div>
          <span className="recommendation-duration">{song.durationSeconds ? formatDuration(song.durationSeconds) : '--:--'}</span>
          <div className="recommendation-row-actions">
            {track && <TrackMenuButton track={track} actions={{ play: () => onPlay(track.id), enqueue: () => onEnqueue(track) }} />}
            <button type="button" aria-label={`为 ${song.title} 更换 B 站视频`} title="更换 B 站视频" onClick={() => onReplace(song)}><Repeat2 size={16} /></button>
          </div>
        </li>
      })}
    </ol>
    {!songs.length && <p className="recommendation-empty-line">今天还没有推荐歌曲。</p>}
  </section>
}
