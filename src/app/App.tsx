import { useEffect, useState, type FormEvent } from 'react'
import { version as appVersion } from '../../package.json'
import { listen } from '@tauri-apps/api/event'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Album,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  Clock3,
  Compass,
  Download,
  Heart,
  Home,
  Library,
  ListMusic,
  Plus,
  Trash2,
  Pause,
  Play,
  Search,
  Settings,
  Repeat2,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  Volume2,
  Waves,
} from 'lucide-react'
import { usePlayerStore } from '../features/player/playerStore'
import { connectMediaSession } from '../features/player/mediaSession'
import { SearchView } from '../features/search/SearchView'
import { LibraryView } from '../features/library/LibraryView'
import { LyricsView } from '../features/lyrics/LyricsView'
import { formatDuration } from '../shared/time'
import { clearSearchHistory, commandErrorMessage, createPlaylist, inDesktopShell, listPlaylists, listRecentTracks, listSearchHistory, toggleStoredFavorite } from '../services/desktopApi'
import { SettingsView } from '../features/settings/SettingsView'
import { DownloadsView } from '../features/downloads/DownloadsView'
import { AccountControl } from '../features/account/AccountControl'
import { ImportFavorites } from '../features/library/ImportFavorites'

const navigation = [
  { label: '此刻', icon: Home },
  { label: '探索', icon: Compass },
  { label: '音乐库', icon: Library },
  { label: '最近播放', icon: Clock3 },
  { label: '下载', icon: Download },
  { label: '我喜欢', icon: Heart },
  { label: '设置', icon: Settings },
]

export function App() {
  const [activeNav, setActiveNav] = useState('此刻')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [playlistName, setPlaylistName] = useState('')
  const [actionError, setActionError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const queryClient = useQueryClient()
  const searchHistory = useQuery({ queryKey: ['search-history'], queryFn: listSearchHistory })
  const clearHistory = useMutation({ mutationFn: clearSearchHistory, onSuccess: () => queryClient.setQueryData(['search-history'], []) })
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: listPlaylists })
  const homeTracks = useQuery({ queryKey: ['home-recent'], queryFn: listRecentTracks })
  const createList = useMutation({ mutationFn: createPlaylist, onSuccess: (playlist) => { queryClient.invalidateQueries({ queryKey: ['playlists'] }); setActiveNav(`playlist:${playlist.id}`); setCreatingPlaylist(false); setPlaylistName('') } })
  const activePlaylist = playlists.data?.find((playlist) => activeNav === `playlist:${playlist.id}`)
  const current = usePlayerStore((state) => state.current)
  const status = usePlayerStore((state) => state.status)
  const queueOpen = usePlayerStore((state) => state.queueOpen)
  const queue = usePlayerStore((state) => state.queue)
  const progressSeconds = usePlayerStore((state) => state.progressSeconds)
  const durationSeconds = usePlayerStore((state) => state.durationSeconds)
  const play = usePlayerStore((state) => state.play)
  const toggle = usePlayerStore((state) => state.toggle)
  const toggleQueue = usePlayerStore((state) => state.toggleQueue)
  const next = usePlayerStore((state) => state.next)
  const previous = usePlayerStore((state) => state.previous)
  const seek = usePlayerStore((state) => state.seek)
  const volume = usePlayerStore((state) => state.volume)
  const setVolume = usePlayerStore((state) => state.setVolume)
  const shuffled = usePlayerStore((state) => state.shuffled)
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle)
  const repeatMode = usePlayerStore((state) => state.repeatMode)
  const cycleRepeat = usePlayerStore((state) => state.cycleRepeat)
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const removeFromQueue = usePlayerStore((state) => state.removeFromQueue)
  const clearQueue = usePlayerStore((state) => state.clearQueue)
  const moveInQueue = usePlayerStore((state) => state.moveInQueue)
  const enqueue = usePlayerStore((state) => state.enqueue)
  const playbackError = usePlayerStore((state) => state.error)

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    const normalized = query.trim()
    if (normalized) {
      setSubmittedQuery(normalized)
      setSearchFocused(false)
      queryClient.setQueryData<string[]>(['search-history'], (existing = []) => [normalized, ...existing.filter((item) => item !== normalized)].slice(0, 30))
    }
  }
  const toggleCurrentFavorite = async () => {
    if (!current) return
    try {
    const liked = await toggleStoredFavorite(current.id)
    updatePlayerTrack({ ...current, liked })
    await queryClient.invalidateQueries({ queryKey: ['library'] })
    } catch (error) { setActionError(commandErrorMessage(error)) }
  }
  useEffect(() => {
    if (!inDesktopShell) return
    let unlisten: undefined | (() => void)
    let disposed = false
    void listen('tray-play-pause', () => void usePlayerStore.getState().toggle()).then((dispose) => { if (disposed) dispose(); else unlisten = dispose })
    return () => { disposed = true; unlisten?.() }
  }, [])
  useEffect(connectMediaSession, [])
  useEffect(() => { if (current) { void queryClient.invalidateQueries({ queryKey: ['home-recent'] }); void queryClient.invalidateQueries({ queryKey: ['library'] }) } }, [current?.id, queryClient])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setLyricsOpen(false); setImportOpen(false); setSearchFocused(false); return }
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      if (event.code === 'Space') { event.preventDefault(); void usePlayerStore.getState().toggle() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className={`app-shell ${queueOpen ? 'queue-visible' : ''}`}>
      <aside className="rail" aria-label="主导航">
        <div className="brand-mark" aria-label="Resonance">
          <Waves size={23} strokeWidth={2.5} />
        </div>
        <nav className="rail-nav">
          {navigation.map(({ label, icon: Icon }) => (
            <button
              className={activeNav === label ? 'rail-button active' : 'rail-button'}
              key={label}
              onClick={() => { setActiveNav(label); setSubmittedQuery('') }}
              title={label}
              aria-label={label}
            >
              <Icon size={20} />
            </button>
          ))}
        </nav>
        <button className="profile-button" aria-label="打开设置" onClick={() => { setActiveNav('设置'); setSubmittedQuery('') }}><Settings size={18} /></button>
      </aside>

      <aside className="library-panel">
        <header>
          <span className="eyebrow">RESONANCE</span>
          <h1>把声音留在身边</h1>
        </header>
        <section>
          <div className="section-heading"><span>我的歌单</span><button aria-label="新建歌单" onClick={() => setCreatingPlaylist((value) => !value)}>＋</button></div>
          <button className="import-trigger" onClick={() => setImportOpen(true)}><Download size={14} />导入 B 站收藏夹</button>
          {creatingPlaylist && <form className="playlist-create" onSubmit={(event) => { event.preventDefault(); if (playlistName.trim()) createList.mutate(playlistName) }}><input autoFocus maxLength={80} value={playlistName} onChange={(event) => setPlaylistName(event.target.value)} placeholder="歌单名称" /><button disabled={createList.isPending}>创建</button></form>}
          {createList.isError && <p className="inline-error">{commandErrorMessage(createList.error)}</p>}
          <div className="collection-list">
            {playlists.data?.map((playlist, index) => (
              <button key={playlist.id} className={activeNav === `playlist:${playlist.id}` ? 'collection-item active' : 'collection-item'} onClick={() => { setActiveNav(`playlist:${playlist.id}`); setSubmittedQuery('') }}>
                <span className={`collection-cover tone-${index % 4}`}><Album size={17} /></span>
                <span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首</small></span>
              </button>
            ))}
          </div>
        </section>
        <div className="library-footer"><Sparkles size={16} /> 独立音乐空间 · {appVersion}</div>
      </aside>

      <main className="content-stage">
        <form className="topbar" onSubmit={submitSearch}>
          <div className="history-buttons"><button type="button" aria-label="返回主页" onClick={() => { setSubmittedQuery(''); setActiveNav('此刻') }}><ArrowLeft size={18} /></button></div>
          <label className="search-field">
            <Search size={18} />
            <input value={query} onFocus={() => setSearchFocused(true)} onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌曲、歌手或专辑" />
            {searchFocused && !query && Boolean(searchHistory.data?.length) && <div className="search-history-popover"><header><span>最近搜索</span><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => clearHistory.mutate()}>清除</button></header>{searchHistory.data!.map((item) => <button type="button" key={item} onMouseDown={(event) => event.preventDefault()} onClick={() => { setQuery(item); setSubmittedQuery(item); setSearchFocused(false) }}><Clock3 size={14} />{item}</button>)}</div>}
          </label>
          <AccountControl />
        </form>

        <div className="stage-scroll">
          {submittedQuery ? <SearchView key={submittedQuery} query={submittedQuery} /> : activePlaylist ? <LibraryView key={activePlaylist.id} playlist={activePlaylist} onPlaylistDeleted={() => setActiveNav('音乐库')} /> : activeNav === '音乐库' ? <LibraryView /> : activeNav === '我喜欢' ? <LibraryView favoritesOnly /> : activeNav === '最近播放' ? <LibraryView recent /> : activeNav === '下载' ? <DownloadsView /> : activeNav === '设置' ? <SettingsView /> : activeNav === '探索' ? <section className="discover-view"><span className="eyebrow">DISCOVER</span><h2>寻找下一首歌</h2><p>选择一个关键词，探索 B 站上的音乐现场与合集。</p><div className="quick-actions">{['音乐现场', '纯音乐 合集', '独立音乐', '爵士', '钢琴', '游戏原声'].map((keyword) => <button key={keyword} onClick={() => { setQuery(keyword); setSubmittedQuery(keyword) }}><Waves /><strong>{keyword}</strong><ChevronRight /></button>)}</div></section> : <>
          <section className="hero">
            <div className="hero-orbit orbit-one" />
            <div className="hero-orbit orbit-two" />
            <div className="hero-copy">
              <span className="eyebrow coral">今日声场</span>
              <h2>让暮色慢一点</h2>
              <p>从熟悉的旋律出发，找到今晚的下一首歌。</p>
              <button className="primary-action" disabled={!homeTracks.data?.length} onClick={() => homeTracks.data?.[0] && play(homeTracks.data[0])}><Play size={17} fill="currentColor" />{homeTracks.data?.length ? '继续聆听' : '搜索后开始聆听'}</button>
            </div>
            <div className="hero-art" aria-hidden="true"><span /><span /><span /><i /></div>
          </section>

          <section className="quick-actions">
            <button onClick={() => setActiveNav('探索')}><span className="quick-icon coral-bg"><Sparkles /></span><span><strong>探索音乐</strong><small>寻找下一首歌</small></span><ChevronRight /></button>
            <button onClick={() => { setQuery('放松 纯音乐'); setSubmittedQuery('放松 纯音乐') }}><span className="quick-icon cyan-bg"><Waves /></span><span><strong>此刻放松</strong><small>搜索舒缓旋律</small></span><ChevronRight /></button>
            <button onClick={() => setActiveNav('音乐库')}><span className="quick-icon blue-bg"><ListMusic /></span><span><strong>我的音乐</strong><small>回到你的收藏</small></span><ChevronRight /></button>
          </section>

          <section className="tracks-section">
            <header><div><span className="eyebrow">RECENTLY PLAYED</span><h3>最近听过的声音</h3></div><button onClick={() => setActiveNav('最近播放')}>查看全部 <ChevronRight size={16} /></button></header>
            <div className="track-table" role="table">
              <div className="track-row table-head" role="row"><span>#</span><span>歌曲</span><span>歌手</span><span>专辑</span><span>时长</span><span /></div>
              {(homeTracks.data || []).map((track, index) => {
                const isCurrent = current?.id === track.id
                return (
                  <div className={isCurrent ? 'track-row current' : 'track-row'} role="row" key={track.id}>
                    <button className="row-play" onClick={() => play(track)} aria-label={`播放 ${track.title}`}>
                      {isCurrent && status === 'playing' ? <Waves size={17} /> : <><span>{index + 1}</span><Play className="hover-play" size={15} fill="currentColor" /></>}
                    </button>
                    <span className="track-title"><span className={`mini-cover tone-${index % 4}`} /> <strong>{track.title}</strong></span>
                    <span>{track.artist || '歌手未知'}</span><span>{track.album || '专辑未知'}</span><span>{formatDuration(track.durationSeconds)}</span>
                    <button className="more-button" aria-label="加入播放队列" onClick={() => enqueue([track])}><Plus size={18} /></button>
                  </div>
                )
              })}
              {homeTracks.data?.length === 0 && <div className="home-tracks-empty">播放过的歌曲会出现在这里</div>}
            </div>
          </section>
          </>}
        </div>
      </main>

      <aside className="queue-drawer" aria-hidden={!queueOpen}>
        <header><div><span className="eyebrow coral">播放队列 · {queue.length}</span><h3>接下来</h3></div><button disabled={!queue.length} onClick={clearQueue} aria-label="清空队列"><Trash2 size={16} /></button><button onClick={toggleQueue} aria-label="收起队列">×</button></header>
        <div className="now-card">
          <div className="now-art">{current?.coverUrl ? <img src={current.coverUrl} alt="" /> : <><div className="sun" /><div className="horizon" /></>}</div>
          <div className="now-meta"><div><strong>{current?.title || '尚未播放'}</strong><small>{current ? current.artist || '歌手未知' : '选择一首歌开始'}</small></div><button className={current?.liked ? 'icon-action liked' : 'icon-action'} onClick={() => void toggleCurrentFavorite()} disabled={!current}><Heart size={19} fill={current?.liked ? 'currentColor' : 'none'} /></button></div>
        </div>
        <div className="queue-list">
          {queue.map((track, index) => (
            <div className="queue-entry" key={track.id}><button className={track.id === current?.id ? 'active' : ''} onClick={() => void play(track)}><span>{index + 1}</span><span><strong>{track.title}</strong><small>{track.artist || '歌手未知'}</small></span></button><button aria-label="上移" disabled={index === 0} onClick={() => moveInQueue(track.id, -1)}><ArrowUp size={13} /></button><button aria-label="下移" disabled={index === queue.length - 1} onClick={() => moveInQueue(track.id, 1)}><ArrowDown size={13} /></button><button aria-label="移出队列" onClick={() => removeFromQueue(track.id)}><Trash2 size={13} /></button></div>
          ))}
          {!queue.length && <p className="queue-empty">队列为空，可以从音乐库或搜索结果添加歌曲。</p>}
        </div>
      </aside>

      <footer className="player-dock">
        <button className="dock-track" onClick={() => setLyricsOpen(true)} disabled={!current} aria-label="打开歌词"><span className="dock-cover">{current?.coverUrl && <img src={current.coverUrl} alt="" />}</span><span><strong>{current?.title || '尚未播放'}</strong><small>{current ? current.artist || '歌手未知' : '从音乐库选择歌曲'}</small></span></button>
        <div className="dock-center">
          <div className="dock-controls"><button aria-label="随机播放" aria-pressed={shuffled} className={shuffled ? 'active' : ''} onClick={toggleShuffle}><Shuffle /></button><button aria-label="上一首" onClick={previous}><SkipBack size={19} fill="currentColor" /></button><button aria-label={status === 'playing' || status === 'buffering' || status === 'resolving' ? '暂停' : '播放'} className="play-toggle" onClick={toggle}>{status === 'playing' || status === 'buffering' || status === 'resolving' ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button><button aria-label="下一首" onClick={() => void next()}><SkipForward size={19} fill="currentColor" /></button><button aria-label={`循环模式：${repeatMode === 'off' ? '顺序播放' : repeatMode === 'all' ? '列表循环' : '单曲循环'}`} className={repeatMode !== 'off' ? 'active repeat-control' : 'repeat-control'} onClick={cycleRepeat}><Repeat2 />{repeatMode === 'one' && <i>1</i>}</button></div>
          <div className="progress"><small>{formatDuration(progressSeconds)}</small><input aria-label="播放进度" type="range" min="0" max={Math.max(1, durationSeconds)} value={Math.min(progressSeconds, durationSeconds || 0)} onChange={(event) => seek(Number(event.target.value))} /><small>{formatDuration(durationSeconds)}</small></div>
        </div>
        <div className="dock-tools"><Volume2 size={18} /><input aria-label="音量" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /><button aria-label="播放队列" aria-expanded={queueOpen} className={queueOpen ? 'active' : ''} onClick={toggleQueue}><ListMusic size={19} /></button></div>
      </footer>
      {(playbackError || actionError) && <div className="playback-error" role="alert">{playbackError || actionError}<button onClick={() => { setActionError(''); usePlayerStore.setState({ error: null }) }}>关闭</button></div>}
      {lyricsOpen && <LyricsView onClose={() => setLyricsOpen(false)} />}
      {importOpen && <ImportFavorites onClose={() => setImportOpen(false)} />}
    </div>
  )
}
