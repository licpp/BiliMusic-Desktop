import { PlaybackModeButton } from '../features/player/PlaybackModeButton'
import { PlaylistsView } from '../features/library/PlaylistsView'
import { MyView } from '../features/settings/MyView'
import { hydrateVisibleTracks } from '../services/sync'
import { LyricsBackdrop } from '../features/lyrics/LyricsBackdrop'
import { ImmersiveTitlebar } from '../shared/ImmersiveTitlebar'
import { desktopFrame, setImmersiveWindow } from '../services/immersiveWindow'
import { useEffect, useState, type FormEvent } from 'react'
import { version as appVersion } from '../../package.json'
import { listen } from '@tauri-apps/api/event'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  UserRound,
  X,
  Album,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  Clock3,
  Download,
  Heart,
  Home,
  Library,
  ListMusic,
  Trash2,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  Sparkles,
  Volume2,
  Waves,
  Sun,
  Moon,
} from 'lucide-react'
import { usePlayerStore } from '../features/player/playerStore'
import { connectMediaSession } from '../features/player/mediaSession'
import { SearchView } from '../features/search/SearchView'
import { LibraryView, MusicLibraryView } from '../features/library/LibraryView'
import { LyricsView } from '../features/lyrics/LyricsView'
import { formatDuration } from '../shared/time'
import { clearSearchHistory, commandErrorMessage, createPlaylist, FAVORITES_PLAYLIST, inDesktopShell, listPlaylists, listRecentTracks, listSearchHistory, toggleStoredFavorite } from '../services/desktopApi'
import { AccountControl } from '../features/account/AccountControl'
import { ImportFavorites } from '../features/library/ImportFavorites'
import { Artwork } from '../shared/Artwork'
import { RangeControl } from '../shared/RangeControl'
import { useThemeStore } from '../services/theme'
import { PlaylistButton, TrackMenuButton, TrackActionsHost } from '../features/library/TrackActions'
import { showTrackMenu } from '../features/library/trackActionStore'

const navigation = [
  { label: '此刻', icon: Home },
  { label: '搜索', icon: Search },
  { label: '音乐库', icon: Library },
  { label: '歌单', icon: ListMusic },
  { label: '我的', icon: UserRound },
]

export function App() {
  const [activeNav, setActiveNav] = useState('此刻')
  const [libraryTab, setLibraryTab] = useState<'saved' | 'recent' | 'downloads'>('saved')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [playlistName, setPlaylistName] = useState('')
  const [actionError, setActionError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [favoritePending, setFavoritePending] = useState(false)
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const queryClient = useQueryClient()
  const searchHistory = useQuery({ queryKey: ['search-history'], queryFn: listSearchHistory })
  const clearHistory = useMutation({ mutationFn: clearSearchHistory, onSuccess: () => queryClient.setQueryData(['search-history'], []) })
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: listPlaylists })
  const homeTracks = useQuery({ queryKey: ['home-recent'], queryFn: listRecentTracks })
  useEffect(() => { void hydrateVisibleTracks(homeTracks.data, queryClient).catch(() => undefined) }, [homeTracks.data, queryClient])
  const createList = useMutation({ mutationFn: createPlaylist, onSuccess: (playlist) => { queryClient.invalidateQueries({ queryKey: ['playlists'] }); setActiveNav(`playlist:${playlist.id}`); setCreatingPlaylist(false); setPlaylistName('') } })
  const sidebarPlaylists = playlists.data || [FAVORITES_PLAYLIST]
  const activePlaylist = sidebarPlaylists.find((playlist) => activeNav === `playlist:${playlist.id}`)
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
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const removeFromQueue = usePlayerStore((state) => state.removeFromQueue)
  const clearQueue = usePlayerStore((state) => state.clearQueue)
  const moveInQueue = usePlayerStore((state) => state.moveInQueue)
  const playbackError = usePlayerStore((state) => state.error)

  const openSearch = (value?: string) => {
    setActiveNav('搜索'); setLyricsOpen(false)
    if (value !== undefined) { setQuery(value); setSubmittedQuery(value.trim()); setSearchFocused(false) }
  }
  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    const normalized = query.trim()
    if (normalized) {
      openSearch(normalized)
      setSearchFocused(false)
      queryClient.setQueryData<string[]>(['search-history'], (existing = []) => [normalized, ...existing.filter((item) => item !== normalized)].slice(0, 30))
    }
  }
  const toggleCurrentFavorite = async () => {
    if (!current || favoritePending) return
    setFavoritePending(true)
    try {
    const liked = inDesktopShell ? await toggleStoredFavorite(current.id) : !current.liked
    const latest = usePlayerStore.getState().queue.find((track) => track.id === current.id) || current
    updatePlayerTrack({ ...latest, liked })
    await queryClient.invalidateQueries({ queryKey: ['library'] })
    await queryClient.invalidateQueries({ queryKey: ['home-recent'] })
    await queryClient.invalidateQueries({ queryKey: ['playlists'] })
    } catch (error) { setActionError(commandErrorMessage(error)) }
    finally { setFavoritePending(false) }
  }
  useEffect(() => {
    if (!inDesktopShell) return
    let unlisten: undefined | (() => void)
    let disposed = false
    void listen('tray-play-pause', () => void usePlayerStore.getState().toggle()).then((dispose) => { if (disposed) dispose(); else unlisten = dispose })
    return () => { disposed = true; unlisten?.() }
  }, [])
  useEffect(connectMediaSession, [])
  useEffect(() => {
    void setImmersiveWindow(lyricsOpen).catch((error) => setActionError(commandErrorMessage(error)))
  }, [lyricsOpen])
  useEffect(() => { if (current) { void queryClient.invalidateQueries({ queryKey: ['home-recent'] }); void queryClient.invalidateQueries({ queryKey: ['library'] }) } }, [current?.id, queryClient])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setLyricsOpen(false); setImportOpen(false); setSearchFocused(false); return }
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); return }
      if (target.closest('button, a')) return
      if (event.code === 'Space') { event.preventDefault(); void usePlayerStore.getState().toggle() }
    }
    window.addEventListener('keydown', handler)
    const disableBrowserMenu = (event: MouseEvent) => event.preventDefault()
    document.addEventListener('contextmenu', disableBrowserMenu)
    return () => { window.removeEventListener('keydown', handler); document.removeEventListener('contextmenu', disableBrowserMenu) }
  }, [])

  useEffect(() => {
    const back = (event: Event) => {
      if (event.defaultPrevented) return
      // Close the foremost dialog first, preserving the screen beneath it.
      const overlays = [...document.querySelectorAll<HTMLElement>('.dialog-backdrop, .lyric-chooser-backdrop')]
      const overlay = overlays.at(-1)
      if (overlay) {
        const close = overlay.querySelector<HTMLButtonElement>('header button[aria-label], header button:last-child')
        if (close) { event.preventDefault(); close.click(); return }
      }
      if (document.querySelector('.track-context-menu')) { event.preventDefault(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return }
      if (lyricsOpen) { event.preventDefault(); const closeComments = document.querySelector<HTMLButtonElement>('.comments-panel > header > button'); if (closeComments) closeComments.click(); else setLyricsOpen(false); return }
      if (queueOpen) { event.preventDefault(); toggleQueue(); return }
      if (activePlaylist) { event.preventDefault(); setActiveNav('歌单'); return }
      if (activeNav !== '此刻') { event.preventDefault(); setSubmittedQuery(''); setActiveNav('此刻') }
    }
    window.addEventListener('bilimusic-back', back)
    return () => window.removeEventListener('bilimusic-back', back)
  }, [lyricsOpen, queueOpen, activePlaylist, submittedQuery, activeNav, toggleQueue])

  return (
    <div className={`app-shell ${queueOpen ? 'queue-visible' : ''} ${lyricsOpen ? `lyrics-immersive frame-${desktopFrame}` : ''}`}>
      {lyricsOpen && <><LyricsBackdrop cover={current?.coverUrl} className="immersive-backdrop" /><ImmersiveTitlebar onError={(error) => setActionError(commandErrorMessage(error))} /></>}
      <aside className="rail" aria-label="主导航">
        <button className="brand-mark" aria-label="BiliMusic 首页" onClick={() => { setActiveNav('此刻'); setSubmittedQuery('') }}>
          <Waves size={23} strokeWidth={2.5} />
        </button>
        <nav className="rail-nav">
          {navigation.map(({ label, icon: Icon }) => (
            <button
              className={(activeNav === label || (label === '歌单' && activeNav.startsWith('playlist:'))) ? 'rail-button active' : 'rail-button'}
              key={label}
              onClick={() => { setActiveNav(label); setLyricsOpen(false) }}
              title={label}
              aria-label={label}
              aria-current={activeNav === label || (label === '歌单' && activeNav.startsWith('playlist:')) ? 'page' : undefined}
            >
              <Icon size={20} /><span className="mobile-nav-label">{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <aside className="library-panel" aria-label="歌单导航">
        <header>
          <span className="eyebrow">BILIMUSIC</span>
          <h1>把声音留在身边</h1>
        </header>
        <section>
          <div className="section-heading"><span>我的歌单</span><button aria-label="新建歌单" onClick={() => setCreatingPlaylist((value) => !value)}>＋</button></div>
          <button className="import-trigger" onClick={() => setImportOpen(true)}><Download size={14} />导入 B 站收藏夹</button>

          <div className="collection-list">
            {sidebarPlaylists.map((playlist, index) => (
              <button key={playlist.id} className={activeNav === `playlist:${playlist.id}` ? 'collection-item active' : 'collection-item'} onClick={() => { setActiveNav(`playlist:${playlist.id}`); setSubmittedQuery(''); setLyricsOpen(false) }}>
                <span className={playlist.isSystem ? 'collection-cover favorites-cover' : `collection-cover tone-${index % 4}`}>{playlist.isSystem ? <Heart size={17} fill="currentColor" /> : <Album size={17} />}</span>
                <span><strong>{playlist.name}</strong><small>{playlist.trackCount} 首{playlist.isSystem ? ' · 默认歌单' : ''}</small></span>
              </button>
            ))}
          </div>
        </section>
        <div className="library-footer"><Sparkles size={16} /> 独立音乐空间 · {appVersion}</div>
      </aside>

      <main className="content-stage">
        <form className={`topbar ${activeNav === '搜索' ? 'searching' : ''}`} onSubmit={submitSearch}>
<div className="mobile-page-heading">{activePlaylist && <button type="button" aria-label="返回歌单列表" onClick={() => setActiveNav('歌单')}><ArrowLeft size={18} /></button>}<strong>{activePlaylist?.name || activeNav}</strong></div>
          <div className="history-buttons"><button type="button" aria-label="返回主页" onClick={() => { setSubmittedQuery(''); setActiveNav('此刻') }}><ArrowLeft size={18} /></button></div>
          <label className="search-field">
            <Search size={18} />
            <input value={query} onFocus={() => { setSearchFocused(true); setActiveNav('搜索') }} onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌曲、歌手或专辑" />
            {searchFocused && !query && Boolean(searchHistory.data?.length) && <div className="search-history-popover"><header><span>最近搜索</span><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => clearHistory.mutate()}>清除</button></header>{searchHistory.data!.map((item) => <button type="button" key={item} onMouseDown={(event) => event.preventDefault()} onClick={() => { openSearch(item) }}><Clock3 size={14} />{item}</button>)}</div>}
          </label>
          <button className="mobile-search-entry" type="button" aria-label="搜索歌曲" onClick={() => openSearch()}><Search size={20} /></button>
          <div className="topbar-actions"><button type="button" className="theme-toggle" aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} title={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button><AccountControl /></div>
        </form>

        <div className="stage-scroll">
          {activePlaylist ? <LibraryView key={activePlaylist.id} playlist={activePlaylist} onPlaylistDeleted={() => setActiveNav('歌单')} /> : activeNav === '歌单' || activeNav.startsWith('playlist:') ? <PlaylistsView playlists={sidebarPlaylists} onOpen={(id) => setActiveNav(`playlist:${id}`)} onCreate={() => setCreatingPlaylist(true)} onImport={() => setImportOpen(true)} /> : activeNav === '音乐库' ? <MusicLibraryView tab={libraryTab} onTabChange={setLibraryTab} /> : activeNav === '我的' ? <MyView /> : activeNav === '搜索' ? submittedQuery ? <SearchView key={submittedQuery} query={submittedQuery} /> : <section className="discover-view search-landing"><span className="eyebrow">SEARCH</span><h2>寻找下一首歌</h2><p>搜索歌曲、歌手、B站音乐与有声内容。</p><div className="quick-actions">{['音乐现场', '纯音乐 合集', '游戏原声', '有声书', '爵士', '钢琴'].map((keyword) => <button key={keyword} onClick={() => openSearch(keyword)}><Search /><strong>{keyword}</strong><ChevronRight /></button>)}</div></section> : <>
          <section className="hero">
            <div className="hero-copy">
              <span className="eyebrow coral">{current ? 'NOW PLAYING' : 'YOUR MUSIC SPACE'}</span>
              <h2>{current?.title || '你的音乐，从这里开始'}</h2>
              <p>{current ? `${current.artist || '歌手未知'}${current.album ? ` · ${current.album}` : ''}` : '搜索 B 站音乐，收藏喜欢的分 P，整理自己的歌单。'}</p>
              <button className="primary-action" onClick={() => { if (current) void toggle(); else if (homeTracks.data?.[0]) void play(homeTracks.data[0]); else openSearch() }}>{status === 'playing' ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}{current ? status === 'playing' ? '暂停播放' : '继续聆听' : homeTracks.data?.length ? '继续聆听' : '开始探索'}</button>
            </div>
            {current && <button className="hero-cover-button" onClick={() => setLyricsOpen(true)} aria-label="查看当前歌曲歌词"><Artwork src={current.coverUrl} /></button>}
          </section>

          <section className="quick-actions">
            <button onClick={() => openSearch()}><span className="quick-icon coral-bg"><Sparkles /></span><span><strong>探索音乐</strong><small>寻找下一首歌</small></span><ChevronRight /></button>
            <button onClick={() => { openSearch('放松 纯音乐') }}><span className="quick-icon cyan-bg"><Waves /></span><span><strong>此刻放松</strong><small>搜索舒缓旋律</small></span><ChevronRight /></button>
            <button onClick={() => setActiveNav('音乐库')}><span className="quick-icon blue-bg"><ListMusic /></span><span><strong>我的音乐</strong><small>回到你的收藏</small></span><ChevronRight /></button>
          </section>

          <section className="tracks-section">
            <header><div><span className="eyebrow">RECENTLY PLAYED</span><h3>最近听过的声音</h3></div><button onClick={() => { setLibraryTab('recent'); setActiveNav('音乐库') }}>查看全部 <ChevronRight size={16} /></button></header>
            <div className="track-table" role="table">
              <div className="track-row table-head" role="row"><span>#</span><span>歌曲</span><span>歌手</span><span>专辑</span><span>时长</span><span /></div>
              {(homeTracks.data || []).map((track, index) => {
                const isCurrent = current?.id === track.id
                return (
                  <div className={isCurrent ? 'track-row current' : 'track-row'} role="row" key={track.id} onContextMenu={(event) => showTrackMenu(event, track)}>
                    <button className="row-play" onClick={() => play(track)} aria-label={`播放 ${track.title}`}>
                      {isCurrent && status === 'playing' ? <Waves size={17} /> : <><span>{index + 1}</span><Play className="hover-play" size={15} fill="currentColor" /></>}
                    </button>
                    <span className="track-title"><button className="home-cover-button" onClick={() => void play(track)} aria-label={`播放 ${track.title} 封面`}><Artwork src={track.coverUrl} className="mini-cover" /></button><strong>{track.title}</strong></span>
                    <span>{track.artist || '歌手未知'}</span><span>{track.album || '专辑未知'}</span><span>{formatDuration(track.durationSeconds)}</span>
                    <div className="row-actions"><PlaylistButton track={track} /><TrackMenuButton track={track} /></div>
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
          <Artwork src={current?.coverUrl} className="now-art" />
          <div className="now-meta"><div><strong>{current?.title || '尚未播放'}</strong><small>{current ? current.artist || '歌手未知' : '选择一首歌开始'}</small></div><button className={current?.liked ? 'icon-action liked' : 'icon-action'} onClick={() => void toggleCurrentFavorite()} disabled={!current}><Heart size={19} fill={current?.liked ? 'currentColor' : 'none'} /></button></div>
        </div>
        <div className="queue-list">
          {queue.map((track, index) => (
            <div className="queue-entry" key={track.id} onContextMenu={(event) => showTrackMenu(event, track)}><button className={track.id === current?.id ? 'active' : ''} onClick={() => void play(track)}><span>{index + 1}</span><span><strong>{track.title}</strong><small>{track.artist || '歌手未知'}</small></span></button><PlaylistButton track={track} /><button aria-label="上移" disabled={index === 0} onClick={() => moveInQueue(track.id, -1)}><ArrowUp size={13} /></button><button aria-label="下移" disabled={index === queue.length - 1} onClick={() => moveInQueue(track.id, 1)}><ArrowDown size={13} /></button><button aria-label="移出队列" onClick={() => removeFromQueue(track.id)}><Trash2 size={13} /></button></div>
          ))}
          {!queue.length && <p className="queue-empty">队列为空，可以从音乐库或搜索结果添加歌曲。</p>}
        </div>
      </aside>

      <footer className="player-dock">
        <div className="dock-track-group" onContextMenu={(event) => { if (current) showTrackMenu(event, current) }}><button className="dock-track" onClick={() => setLyricsOpen(true)} disabled={!current} aria-label="打开歌词"><Artwork src={current?.coverUrl} className="dock-cover" /><span><strong>{current?.title || '尚未播放'}</strong><small>{current ? current.artist || '歌手未知' : '从音乐库选择歌曲'}</small></span></button><button className={current?.liked ? 'dock-heart liked' : 'dock-heart'} disabled={!current || favoritePending} aria-label={current?.liked ? '取消喜欢当前歌曲' : '喜欢当前歌曲'} aria-pressed={Boolean(current?.liked)} onClick={() => void toggleCurrentFavorite()}><Heart size={19} fill={current?.liked ? 'currentColor' : 'none'} /></button></div>
        <div className="dock-center">
          <div className="dock-controls"><PlaybackModeButton /><button aria-label="上一首" onClick={previous}><SkipBack size={19} fill="currentColor" /></button><button aria-label={status === 'playing' || status === 'buffering' || status === 'resolving' ? '暂停' : '播放'} className="play-toggle" onClick={toggle}>{status === 'playing' || status === 'buffering' || status === 'resolving' ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button><button aria-label="下一首" onClick={() => void next()}><SkipForward size={19} fill="currentColor" /></button><button className={queueOpen ? 'queue-control active' : 'queue-control'} aria-label="播放队列" aria-expanded={queueOpen} onClick={toggleQueue}><ListMusic size={18} /></button></div>
          <div className="progress"><small>{formatDuration(progressSeconds)}</small><RangeControl aria-label="播放进度" min="0" max={Math.max(1, durationSeconds)} value={Math.min(progressSeconds, durationSeconds || 0)} onChange={(event) => seek(Number(event.target.value))} /><small>{formatDuration(durationSeconds)}</small></div>
        </div>
        <div className="dock-tools"><Volume2 size={18} /><RangeControl aria-label="音量" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></div>
      </footer>
      {(playbackError || actionError) && <div className="playback-error" role="alert">{playbackError || actionError}<button onClick={() => { setActionError(''); usePlayerStore.setState({ error: null }) }}>关闭</button></div>}
      {lyricsOpen && <LyricsView onClose={() => setLyricsOpen(false)} />}
      {importOpen && <ImportFavorites onClose={() => setImportOpen(false)} />}
      {creatingPlaylist && <div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setCreatingPlaylist(false)}}><form className="playlist-create-dialog" role="dialog" aria-modal="true" aria-label="新建歌单" onSubmit={e=>{e.preventDefault();if(playlistName.trim())createList.mutate(playlistName)}}><header><h3>新建歌单</h3><button type="button" aria-label="关闭" onClick={()=>setCreatingPlaylist(false)}><X size={18} /></button></header><input autoFocus maxLength={80} value={playlistName} onChange={e=>setPlaylistName(e.target.value)} placeholder="歌单名称" />{createList.isError && <p className="inline-error">{commandErrorMessage(createList.error)}</p>}<button disabled={createList.isPending || !playlistName.trim()}>创建歌单</button></form></div>}
      <TrackActionsHost />
    </div>
  )
}
