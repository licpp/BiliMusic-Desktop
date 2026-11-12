import { CreatorsView } from '../features/collections/CreatorsView'
import { PlaylistEntry } from '../features/library/PlaylistEntry'
import { LinkedFolderView } from '../features/library/LinkedFolderView'
import type { Collection } from '../services/collections'
import { useCompactLayout } from '../shared/useCompactLayout'
import { CollectionsView, CollectionDetail } from '../features/collections/CollectionsView'
import { QueueList } from '../features/player/QueueList'
import { SleepTimer } from '../features/player/SleepTimer'
import { PlaybackModeButton } from '../features/player/PlaybackModeButton'
import { PlaylistsView } from '../features/library/PlaylistsView'
import { MyView } from '../features/settings/MyView'
import { hydrateVisibleTracks } from '../services/sync'
import { LyricsBackdrop } from '../features/lyrics/LyricsBackdrop'
import { ImmersiveTitlebar } from '../shared/ImmersiveTitlebar'
import { desktopFrame, setImmersiveWindow } from '../services/immersiveWindow'
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { version as appVersion } from '../../package.json'
import { listen } from '@tauri-apps/api/event'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  UserRound,
  X,
  ArrowLeft,
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Download,
  Heart,
  Home,
  Library,
  ListMusic,
  Trash2,
  Pause,
  Play,
  Plus,
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
import { playerShortcut } from '../features/player/shortcuts'
import { connectMediaSession } from '../features/player/mediaSession'
import { SearchView } from '../features/search/SearchView'
import { SearchField } from '../features/search/SearchField'
import { LibraryView, MusicLibraryView } from '../features/library/LibraryView'
import { LyricsView } from '../features/lyrics/LyricsView'
import { formatDuration } from '../shared/time'
import { clearSearchHistory, commandErrorMessage, createPlaylist, getVideoParts, saveLibraryTrack, FAVORITES_PLAYLIST, inDesktopShell, listPlaylists, listRecentTracks, listSearchHistory, toggleStoredFavorite } from '../services/desktopApi'
import { toTrack } from '../services/collectionTrack'
import { accountEpoch } from '../services/accountScope'
import { AccountControl } from '../features/account/AccountControl'
import { ImportFavorites, ImportPlaylistButton } from '../features/library/ImportFavorites'
import { usePlaylistImport } from '../services/playlistImport'
import type { Playlist } from '../services/desktopApi'
import { PlayingMark } from '../shared/PlayingMark'
import { Artwork } from '../shared/Artwork'
import { RangeControl } from '../shared/RangeControl'
import { useThemeStore } from '../services/theme'
import { PlaylistButton, TrackMenuButton, TrackActionsHost } from '../features/library/TrackActions'
import { showTrackMenu } from '../features/library/trackActionStore'
import { isMobile } from '../services/platform'
import { PlayerProgress } from '../features/player/PlayerProgress'
import { SidebarResizeHandle } from '../shared/SidebarResizeHandle'
import { MiniPlayer } from '../features/player/MiniPlayer'
import { getMiniPlayerMode, miniPlayerSupported, setMiniPlayerMode } from '../services/immersiveWindow'
import { PictureInPicture2 } from 'lucide-react'

const navigation = [
  { label: '此刻', icon: Home },
  { label: '搜索', icon: Search },
  { label: '音乐库', icon: Library },
  { label: '歌单', icon: ListMusic },
  { label: '我的', icon: UserRound },
]

export function App() {
  const compact=useCompactLayout()
  const [playlistsExpanded, setPlaylistsExpanded] = useState(() => localStorage.getItem('playlists-expanded') !== 'false')
  const [sleepTimerOpen, setSleepTimerOpen] = useState(false)
  const [selectedCollection,setSelectedCollection]=useState<Collection|null>(null)
  const [collectionSearch,setCollectionSearch]=useState('')
  useEffect(()=>setCollectionSearch(''),[selectedCollection?.bvid])
  const [hubSection,setHubSection]=useState<'playlists'|'collections'|'creators'>('playlists')
  const contentScroll=useRef<HTMLDivElement>(null)
  const collectionHistory = useRef<{ item: Collection | null; scroll: number; lyrics: boolean }[]>([])
  const libraryReturn = useRef<{ nav: string; scroll: number } | null>(null)
  const scrollCollection = (top: number) => {
    requestAnimationFrame(() => { if (contentScroll.current) contentScroll.current.scrollTop = top })
  }
  const resetCollection = () => {
    collectionHistory.current = []
    setSelectedCollection(null)
  }
  const openCollection = (item: Collection, origin?: 'lyrics' | 'collection') => {
    const scroll = contentScroll.current?.scrollTop || 0
    if (origin) {
      collectionHistory.current.push({ item: selectedCollection, scroll, lyrics: origin === 'lyrics' })
    } else {
      collectionHistory.current = [{ item: null, scroll: collectionHistory.current[0]?.scroll ?? scroll, lyrics: false }]
    }
    if (origin === 'lyrics') setLyricsOpen(false)
    setSelectedCollection(item)
    scrollCollection(0)
  }
  const closeCollection = () => {
    const origin = collectionHistory.current.pop()
    setSelectedCollection(origin?.item ?? null)
    if (origin?.lyrics && usePlayerStore.getState().current) setLyricsOpen(true)
    scrollCollection(origin?.scroll ?? 0)
  }
  useEffect(() => {
    const clear = () => { resetCollection(); setActiveNav('此刻'); setImportOpen(false); setRematchPlaylist(undefined); setSleepTimerOpen(false); libraryReturn.current = null }
    window.addEventListener('bilimusic-account-changing', clear)
    return () => window.removeEventListener('bilimusic-account-changing', clear)
  }, [])
  const [activeNav, setActiveNav] = useState('此刻')
  const [libraryTab, setLibraryTab] = useState<'saved' | 'recent' | 'downloads' | 'local'>('saved')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const searchScroll = useRef<HTMLDivElement>(null)
  useEffect(() => { if (searchScroll.current) searchScroll.current.scrollTop = 0 }, [submittedQuery])
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [miniMode,setMiniMode]=useState(false)
  const [miniBusy,setMiniBusy]=useState(false)
  const [windowReady,setWindowReady]=useState(!miniPlayerSupported)
  const miniRestoreLyrics=useRef(false)
  const miniChanging=useRef(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [playlistName, setPlaylistName] = useState('')
  const [actionError, setActionError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [rematchPlaylist,setRematchPlaylist]=useState<Playlist>()
  const [favoritePending, setFavoritePending] = useState(false)
  const favoriteDesired = useRef<boolean | undefined>(undefined)
  const favoriteRunning = useRef(false)
  const dockGesture = useRef<{ startX: number; lastX: number; startedAt: number } | null>(null)
  const dockSwipeTimers = useRef<number[]>([])
  const suppressDockClick = useRef(false)
  const [dockSwipeX, setDockSwipeX] = useState(0)
  const [dockSwipePhase, setDockSwipePhase] = useState<'idle' | 'dragging' | 'commit-left' | 'commit-right' | 'enter-left' | 'enter-right'>('idle')
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const queryClient = useQueryClient()
  useEffect(() => {
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['playlists'] }); void queryClient.invalidateQueries({ queryKey: ['library'] }) }
    window.addEventListener('bilimusic-import-updated', refresh)
    return () => window.removeEventListener('bilimusic-import-updated', refresh)
  }, [queryClient])
  const searchHistory = useQuery({ queryKey: ['search-history'], queryFn: listSearchHistory })
  const clearHistory = useMutation({ mutationFn: clearSearchHistory, onSuccess: () => queryClient.setQueryData(['search-history'], []) })
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: listPlaylists })
  const homeTracks = useQuery({ queryKey: ['home-recent'], queryFn: listRecentTracks })
  useEffect(() => { void hydrateVisibleTracks(homeTracks.data, queryClient).catch(() => undefined) }, [homeTracks.data, queryClient])
  const createList = useMutation({ mutationFn: createPlaylist, onSuccess: (playlist) => { queryClient.invalidateQueries({ queryKey: ['playlists'] }); setActiveNav(`playlist:${playlist.id}`); setCreatingPlaylist(false); setPlaylistName('') } })
  const allPlaylists = playlists.data || [FAVORITES_PLAYLIST]
  const localPlaylists = allPlaylists.filter(playlist => !playlist.biliFolderId)
  const linkedFolders = allPlaylists.filter(playlist => playlist.biliFolderId)
  const activePlaylist = allPlaylists.find(playlist => activeNav === `playlist:${playlist.id}`)
  const activeFolder = activeNav.startsWith('collections:') ? activeNav.slice('collections:'.length) : undefined
  const libraryDetail = activeNav.startsWith('playlist:') || activeFolder !== undefined
  const searchActive = activeNav === '搜索' && !selectedCollection
  const navIsActive = (label: string) => activeNav === label || (libraryDetail && label === (compact ? '此刻' : '歌单'))
  useEffect(resetCollection, [activeNav])

  const openLibraryPage = (nav: string) => {
    resetCollection()
    setLyricsOpen(false)
    if (nav === activeNav) return
    if (!libraryDetail) {
      const origin = activeNav === '搜索' ? (compact ? '此刻' : '歌单') : activeNav
      libraryReturn.current = { nav: origin, scroll: contentScroll.current?.scrollTop || 0 }
    }
    setActiveNav(nav)
    requestAnimationFrame(() => { if (contentScroll.current) contentScroll.current.scrollTop = 0 })
  }
  const closeLibraryPage = () => {
    const origin = libraryReturn.current
    libraryReturn.current = null
    setActiveNav(origin?.nav || (compact ? '此刻' : '歌单'))
    requestAnimationFrame(() => { if (contentScroll.current) contentScroll.current.scrollTop = origin?.scroll || 0 })
  }
  const openPlaylist = (id: string) => openLibraryPage(`playlist:${id}`)
  const openFolder = (id: string) => openLibraryPage(`collections:${id}`)
  const playlistRemoved = (id: string) => { if (activeNav === `playlist:${id}`) closeLibraryPage() }
  const folderRemoved = (id: string) => { if (activeFolder === id) closeLibraryPage() }
  const hub = <PlaylistsView playlists={localPlaylists} linkedFolders={linkedFolders} onOpen={openPlaylist} onRemoved={playlistRemoved}
    onCreate={() => setCreatingPlaylist(true)} onImport={() => setImportOpen(true)}
    onCollectionOpen={openCollection} onOpenFolder={openFolder} section={hubSection} onSectionChange={setHubSection}/>
  const current = usePlayerStore((state) => state.current)
  useEffect(() => {
    if (!inDesktopShell || current?.source.provider !== 'bilibili' || current.partCount || current.resolveParts) return
    const epoch = accountEpoch()
    let cancelled = false
    void getVideoParts(current.source.bvid).then(async detail => {
      const part = detail.parts.find(part => part.cid === current.source.cid)
      if (!part || cancelled || epoch !== accountEpoch()) return
      const canonical = toTrack(detail, part)
      const stored = await saveLibraryTrack({ ...canonical, artist: current.artist, album: current.album })
      if (cancelled || epoch !== accountEpoch() || usePlayerStore.getState().current?.id !== current.id) return
      usePlayerStore.getState().updateTrack({ ...stored, videoTitle: canonical.videoTitle, partCount: canonical.partCount })
      void queryClient.invalidateQueries({ queryKey: ['library'] })
      void queryClient.invalidateQueries({ queryKey: ['home-recent'] })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [current?.id, current?.partCount, current?.resolveParts, queryClient])
  const status = usePlayerStore((state) => state.status)
  const queueOpen = usePlayerStore((state) => state.queueOpen)
  const queue = usePlayerStore((state) => state.queue)
  const queueSource = usePlayerStore(state => state.queueSource)
  const queueFeedback = usePlayerStore(state => state.queueFeedback)
  useEffect(() => {
    if (!queueFeedback) return
    const timer = window.setTimeout(() => usePlayerStore.setState({ queueFeedback: undefined }), 2400)
    return () => window.clearTimeout(timer)
  }, [queueFeedback])
  const queueReversed = usePlayerStore(state => state.queueReversed)
  const reverseQueue = usePlayerStore(state => state.reverseQueue)
  const toggle = usePlayerStore((state) => state.toggle)
  const toggleQueue = usePlayerStore((state) => state.toggleQueue)
  const next = usePlayerStore((state) => state.next)
  const previous = usePlayerStore((state) => state.previous)
  const volume = usePlayerStore((state) => state.volume)
  const setVolume = usePlayerStore((state) => state.setVolume)
  const updatePlayerTrack = usePlayerStore((state) => state.updateTrack)
  const clearQueue = usePlayerStore((state) => state.clearQueue)
  const playbackError = usePlayerStore((state) => state.error)
  useEffect(()=>{
    if(!miniPlayerSupported)return
    let cancelled=false
    void getMiniPlayerMode().then(active=>{if(!cancelled){setMiniMode(active);setWindowReady(true)}})
      .catch(error=>{if(!cancelled){setActionError(commandErrorMessage(error));setWindowReady(true)}})
    return()=>{cancelled=true}
  },[])
  useEffect(()=>{
    if(miniMode)document.documentElement.dataset.miniPlayer='true'
    else delete document.documentElement.dataset.miniPlayer
    return()=>{delete document.documentElement.dataset.miniPlayer}
  },[miniMode])
  const changeMiniMode=async(enabled:boolean,lyrics=false,queue=false)=>{
    if(miniChanging.current||!windowReady)return
    miniChanging.current=true;setMiniBusy(true);setActionError('')
    try{
      if(enabled){miniRestoreLyrics.current=lyricsOpen;await setImmersiveWindow(false)}
      const active=await setMiniPlayerMode(enabled)
      setMiniMode(active)
      if(active)setLyricsOpen(false)
      else{
        setLyricsOpen(lyrics||(!queue&&miniRestoreLyrics.current))
        if(queue)usePlayerStore.setState({queueOpen:true})
      }
    }catch(cause){setActionError(commandErrorMessage(cause));if(enabled)void setImmersiveWindow(lyricsOpen)}
    finally{miniChanging.current=false;setMiniBusy(false)}
  }

  const openSearch = (value?: string) => {
    resetCollection(); setActiveNav('搜索'); setLyricsOpen(false)
    if (value !== undefined) { setQuery(value); setSubmittedQuery(value.trim()); setSearchFocused(false) }
  }
  const runSearch = (value: string) => {
    const normalized = value.trim()
    if (!normalized) { openSearch(''); return }
    openSearch(normalized)
    queryClient.setQueryData<string[]>(['search-history'], (existing = []) => [normalized, ...existing.filter((item) => item !== normalized)].slice(0, 30))
  }
  const submitSearch = (event: FormEvent) => { event.preventDefault(); if(!selectedCollection || selectedCollection.bvid.startsWith('up:')) runSearch(query) }
  const toggleCurrentFavorite = async () => {
    if (!current) return
    const latest = usePlayerStore.getState().queue.find((track) => track.id === current.id) || current
    if (!latest) return
    const next = !latest.liked
    updatePlayerTrack({ ...latest, liked: next })
    favoriteDesired.current = next
    if (favoriteRunning.current) return
    favoriteRunning.current = true; setFavoritePending(true)
    let confirmed = latest.liked
    try {
      while (favoriteDesired.current !== undefined && favoriteDesired.current !== confirmed) {
        const requested: boolean = favoriteDesired.current
        const liked = inDesktopShell ? await toggleStoredFavorite(latest.id) : requested
        confirmed = liked
        if (favoriteDesired.current === requested) favoriteDesired.current = undefined
        if (favoriteDesired.current === undefined) {
          const track = usePlayerStore.getState().queue.find(item => item.id === latest.id) || latest
          updatePlayerTrack({ ...track, liked })
        }
      }
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['library'] }),
        queryClient.invalidateQueries({ queryKey: ['home-recent'] }),
        queryClient.invalidateQueries({ queryKey: ['playlists'] }),
      ])
    } catch (error) {
      favoriteDesired.current = undefined
      const track = usePlayerStore.getState().queue.find(item => item.id === latest.id) || latest
      updatePlayerTrack({ ...track, liked: confirmed })
      setActionError(`收藏失败，已恢复原状态：${commandErrorMessage(error)}`)
    } finally { favoriteRunning.current = false; setFavoritePending(false) }
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
    if(!windowReady||miniMode)return
    void setImmersiveWindow(lyricsOpen).catch((error) => setActionError(commandErrorMessage(error)))
  }, [lyricsOpen,miniMode,windowReady])
  useEffect(() => {
    const refreshRecent = () => {
      void queryClient.invalidateQueries({ queryKey: ['home-recent'] })
      void queryClient.invalidateQueries({ queryKey: ['library', 'recent'] })
    }
    window.addEventListener('bilimusic-recent-changed', refreshRecent)
    return () => window.removeEventListener('bilimusic-recent-changed', refreshRecent)
  }, [queryClient])
  useEffect(() => () => { dockSwipeTimers.current.forEach(window.clearTimeout) }, [])

  const startDockSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isMobile || !current || (event.target as HTMLElement).closest('.dock-heart')) return
    dockSwipeTimers.current.forEach(window.clearTimeout); dockSwipeTimers.current = []
    dockGesture.current = { startX: event.clientX, lastX: event.clientX, startedAt: performance.now() }
    setDockSwipeX(0); setDockSwipePhase('dragging')
  }
  const moveDockSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dockGesture.current) return
    dockGesture.current.lastX = event.clientX
    const distance = event.clientX - dockGesture.current.startX
    if (Math.abs(distance) > 8 && !event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
    setDockSwipeX(Math.max(-96, Math.min(96, distance * .82)))
  }
  const finishDockSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = dockGesture.current
    if (!gesture) return
    dockGesture.current = null
    const distance = event.clientX - gesture.startX
    const velocity = distance / Math.max(1, performance.now() - gesture.startedAt)
    const direction = Math.abs(distance) >= 54 || (Math.abs(distance) >= 24 && Math.abs(velocity) >= .48) ? Math.sign(distance) : 0
    if (!direction) { setDockSwipeX(0); setDockSwipePhase('idle'); return }
    suppressDockClick.current = true
    setDockSwipePhase(direction < 0 ? 'commit-left' : 'commit-right')
    const switchTimer = window.setTimeout(() => {
      if (direction < 0) void next(); else void previous()
      setDockSwipeX(0)
      setDockSwipePhase(direction < 0 ? 'enter-left' : 'enter-right')
      const settleTimer = window.setTimeout(() => {
        setDockSwipePhase('idle')
        // iOS normally emits a click after pointerup, but it may suppress it after a
        // sufficiently long drag. Do not let that suppress the user's next real tap.
        suppressDockClick.current = false
      }, 230)
      dockSwipeTimers.current.push(settleTimer)
    }, 145)
    dockSwipeTimers.current.push(switchTimer)
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setLyricsOpen(false); setImportOpen(false); setSearchFocused(false); return }
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); return }
      // Space belongs to playback controls even after a mouse click leaves
      // previous/next focused. Other buttons retain native keyboard activation.
      if (target.isContentEditable) return
      if (!event.metaKey && !event.ctrlKey && !event.altKey && target.closest('button, a') && !target.closest('.dock-controls,.mini-player-controls')) return
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      const shortcut = playerShortcut(event)
      if (!shortcut) return
      event.preventDefault()
      const state = usePlayerStore.getState()
      if (event.repeat && ['toggle','next','previous'].includes(shortcut)) return
      if (shortcut === 'toggle') void state.toggle()
      else if (shortcut === 'next') void state.next()
      else if (shortcut === 'previous') void state.previous()
      else if (shortcut === 'seekBack' || shortcut === 'seekForward') state.seek(state.progressSeconds + (shortcut === 'seekBack' ? -10 : 10))
      else state.setVolume(Math.max(0, Math.min(1, state.volume + (shortcut === 'volumeUp' ? .05 : -.05))))
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
      const overlays = [...document.querySelectorAll<HTMLElement>('.dialog-backdrop, .lyric-chooser-backdrop, .playlist-import-backdrop')]
      const overlay = document.querySelector<HTMLElement>('.playlist-picker-layer') || overlays.at(-1)
      if (overlay) {
        const close = overlay.querySelector<HTMLButtonElement>('header button[aria-label]:not(:disabled), header button:last-child:not(:disabled)')
        if (close) { event.preventDefault(); close.click(); return }
      }
      if (document.querySelector('.track-context-menu')) { event.preventDefault(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return }
      if (sleepTimerOpen) { event.preventDefault(); setSleepTimerOpen(false); return }
      if (queueOpen) { event.preventDefault(); toggleQueue(); return }
      if (lyricsOpen) { event.preventDefault(); const closeComments = document.querySelector<HTMLButtonElement>('.comments-panel > header > button'); if (closeComments) closeComments.click(); else setLyricsOpen(false); return }
      if(selectedCollection){event.preventDefault();closeCollection();return}
      if (libraryDetail) { event.preventDefault(); closeLibraryPage(); return }
      if (activeNav === '搜索' && submittedQuery) { event.preventDefault(); openSearch(''); return }
      if (activeNav !== '此刻') { event.preventDefault(); setActiveNav('此刻') }
    }
    window.addEventListener('bilimusic-back', back)
    return () => window.removeEventListener('bilimusic-back', back)
  }, [lyricsOpen, queueOpen, sleepTimerOpen, libraryDetail, selectedCollection, compact, submittedQuery, activeNav, toggleQueue])

  return (
    <><div hidden={miniMode} className={`app-shell ${queueOpen ? 'queue-visible' : ''} ${lyricsOpen ? `lyrics-immersive frame-${desktopFrame}` : ''}`}>
      {lyricsOpen && <><LyricsBackdrop cover={current?.coverUrl} className="immersive-backdrop" /><ImmersiveTitlebar onError={(error) => setActionError(commandErrorMessage(error))} /></>}
      <aside className="rail" aria-label="主导航">
        <button className="brand-mark" aria-label="BiliMusic 首页" onClick={() => { setActiveNav('此刻') }}>
          <Waves size={23} strokeWidth={2.5} />
        </button>
        <nav className="rail-nav">
          {navigation.filter(item=>!compact||(item.label!=='歌单' && item.label!=='关注')).map(({ label, icon: Icon }) => (
            <button
              className={navIsActive(label) ? 'rail-button active' : 'rail-button'}
              key={label}
              onClick={() => { setActiveNav(label); resetCollection(); setLyricsOpen(false); libraryReturn.current = null }}
              title={label}
              aria-label={label}
              aria-current={navIsActive(label) ? 'page' : undefined}
            >
              <Icon size={20} /><span className="mobile-nav-label">{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <aside id="library-navigation" className="library-panel" aria-label="歌单导航">
        <header className="library-brand"><h1>BiliMusic</h1></header>
        <section>
          <div className="section-heading"><button className="sidebar-collapse" aria-expanded={playlistsExpanded} onClick={() => setPlaylistsExpanded(value => { localStorage.setItem('playlists-expanded', String(!value)); return !value })}>歌单{playlistsExpanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button><div className="sidebar-heading-actions" hidden={!playlistsExpanded}>
            <button type="button" aria-label="新建歌单" title="新建歌单" onClick={() => setCreatingPlaylist(value => !value)}><Plus size={17}/></button>
            <ImportPlaylistButton sidebar onClick={() => setImportOpen(true)}/>
          </div></div>

          <div className="collection-list" hidden={!playlistsExpanded}>
            {localPlaylists.map(playlist => <PlaylistEntry key={playlist.id} playlist={playlist} sidebar
              active={activeNav === `playlist:${playlist.id}`} onOpen={() => openPlaylist(playlist.id)} onRemoved={() => playlistRemoved(playlist.id)}/>)}
          </div>
        </section>
        <CollectionsView sidebar linkedFolders={linkedFolders} onOpenFolder={openFolder} onOpenLinked={openPlaylist}
          onLinkedRemoved={playlistRemoved} onSelect={openCollection} onFolderRemoved={folderRemoved}/>
        <CreatorsView followed sidebar onOpen={openCollection}/>
        <div className="library-footer"><Sparkles size={16} /> 独立音乐空间 · {appVersion}</div>
      </aside>
      {!isMobile && <SidebarResizeHandle/>}

      <main className="content-stage">
        <form className={`topbar ${searchActive ? 'searching' : ''}`} onSubmit={submitSearch}>
          <div className="mobile-page-heading">
            {(libraryDetail || selectedCollection) && <button type="button" aria-label="返回上一页" onClick={selectedCollection ? closeCollection : closeLibraryPage}><ArrowLeft size={18}/></button>}
            <strong>{selectedCollection ? '合集详情' : activePlaylist?.name || (activeFolder !== undefined ? '收藏夹' : activeNav)}</strong>
          </div>
          <div className="history-buttons"><button type="button" aria-label={libraryDetail || selectedCollection ? '返回上一页' : '返回主页'}
            onClick={selectedCollection ? closeCollection : libraryDetail ? closeLibraryPage : () => setActiveNav('此刻')}><ArrowLeft size={18}/></button></div>
          {selectedCollection && !selectedCollection.bvid.startsWith('up:') ? <label className="collection-topbar-search"><Search size={18}/><input type="search" aria-label="搜索当前合集" placeholder="搜索此合集中的内容" value={collectionSearch} onChange={event=>{setCollectionSearch(event.target.value);window.dispatchEvent(new CustomEvent('bilimusic-filter-collection',{detail:event.target.value}))}}/></label> : <>
          <SearchField value={query} focused={searchFocused} history={searchHistory.data || []}
            onFocus={() => { setSearchFocused(true); resetCollection(); setActiveNav('搜索') }} onBlur={() => setSearchFocused(false)}
            onChange={value => { setQuery(value); if (!value.trim()) setSubmittedQuery('') }}
            onSearch={runSearch} onClear={() => openSearch('')} onClearHistory={() => clearHistory.mutate()} /></>}

          <button className="mobile-search-entry" type="button" aria-label="搜索歌曲" onClick={() => { if (selectedCollection && !selectedCollection.bvid.startsWith('up:')) window.dispatchEvent(new Event('bilimusic-search-collection')); else openSearch() }}><Search size={20} /></button>
          <div className="topbar-actions">{miniPlayerSupported&&<button type="button" aria-label="迷你播放器" title="迷你播放器 · 置顶悬浮" disabled={miniBusy||!windowReady} onClick={()=>void changeMiniMode(true)}><PictureInPicture2 size={19}/></button>}<button type="button" className="theme-toggle" aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} title={theme === 'dark' ? '切换浅色主题' : '切换深色主题'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button><AccountControl /></div>
        </form>

        <div className="stage-scroll" ref={searchScroll} hidden={!searchActive}>{submittedQuery ? <SearchView key={submittedQuery} query={submittedQuery} active={searchActive} onCollectionOpen={openCollection} /> : <section className="discover-view search-landing"><span className="eyebrow">SEARCH</span><h2>寻找下一首歌</h2><p>搜索歌曲、歌手、B站音乐与有声内容。</p><div className="quick-actions">{['音乐现场', '纯音乐 合集', '游戏原声', '有声书', '爵士', '钢琴'].map((keyword) => <button key={keyword} onClick={() => openSearch(keyword)}><Search /><strong>{keyword}</strong><ChevronRight /></button>)}</div></section>}</div>
        <div className="stage-scroll" ref={contentScroll} hidden={searchActive}>
          {selectedCollection && <CollectionDetail key={selectedCollection.bvid} item={selectedCollection} onBack={closeCollection}
            hideBack onOpenCollection={item => openCollection(item, 'collection')}/>}
          <div hidden={Boolean(selectedCollection)}>
          {activeFolder !== undefined ? <CollectionsView key={activeFolder} folderId={activeFolder} onOpenFolder={openFolder}
            onOpenLinked={openPlaylist} onLinkedRemoved={playlistRemoved} onSelect={openCollection} onFolderRemoved={folderRemoved}/> :
          activePlaylist?.biliFolderId ? <LinkedFolderView key={activePlaylist.id} playlist={{ ...activePlaylist, biliFolderId: activePlaylist.biliFolderId }} onUnlink={closeLibraryPage}/> :
          activePlaylist ? <LibraryView key={activePlaylist.id} playlist={activePlaylist} onPlaylistDeleted={closeLibraryPage} onRematchImported={playlist=>{const job=usePlaylistImport.getState().job;setRematchPlaylist(job?.playlistId===playlist.id&&job.state!=='done'?undefined:playlist);setImportOpen(true)}}/> :
          activeNav === '歌单' || libraryDetail ? hub :
          activeNav === '关注' ? <CreatorsView followed onOpen={openCollection}/> : activeNav === '音乐库' ? <MusicLibraryView tab={libraryTab} onTabChange={setLibraryTab}/> :
          activeNav === '我的' ? <MyView onOpenDownloads={() => { setLibraryTab('downloads'); setActiveNav('音乐库') }}/> : activeNav === '搜索' ? null : <>
          <section className="hero">
            <div className="hero-copy">
              <div className="hero-summary">
                <span className="eyebrow coral">{current ? 'NOW PLAYING' : 'YOUR MUSIC SPACE'}</span>
                <h2>{current?.title || '你的音乐，从这里开始'}</h2>
                <p>{current ? `${current.artist || '歌手未知'}${current.album ? ` · ${current.album}` : ''}` : '搜索 B 站音乐，收藏喜欢的分 P，整理自己的歌单。'}</p>
              </div>
              <button className="primary-action" onClick={() => { if (current) void toggle(); else if (homeTracks.data?.[0]) void usePlayerStore.getState().playFromList(homeTracks.data,homeTracks.data[0].id); else openSearch() }}>{status === 'playing' ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}{current ? status === 'playing' ? '暂停播放' : '继续聆听' : homeTracks.data?.length ? '继续聆听' : '开始探索'}</button>
            </div>
            {current && <button className="hero-cover-button" onClick={() => setLyricsOpen(true)} aria-label="查看当前歌曲歌词"><Artwork src={current.coverUrl} adaptAspect /></button>}
          </section>

          {compact ? hub : <><section className="quick-actions">
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
                  <div className="track-row playing-row" data-current-row={isCurrent ? track.id : undefined} role="row" key={track.id} onContextMenu={(event) => showTrackMenu(event, track,undefined,homeTracks.data)}>
                    <button className="row-play" onClick={() => usePlayerStore.getState().playFromList(homeTracks.data||[],track.id)} aria-current={isCurrent ? 'true' : undefined} aria-label={`播放 ${track.title}`}>
                      {isCurrent ? <PlayingMark /> : <><span>{index + 1}</span><Play className="hover-play" size={15} fill="currentColor" /></>}
                    </button>
                    <span className="track-title"><button className="home-cover-button" onClick={() => void usePlayerStore.getState().playFromList(homeTracks.data||[],track.id)} aria-label={`播放 ${track.title} 封面`}><Artwork src={track.coverUrl} className="mini-cover" adaptAspect /></button><strong>{track.title}</strong></span>
                    <span>{track.artist || '歌手未知'}</span><span>{track.album || '专辑未知'}</span><span>{formatDuration(track.durationSeconds)}</span>
                    <div className="row-actions"><PlaylistButton track={track} /><TrackMenuButton track={track} tracks={homeTracks.data}/></div>
                  </div>
                )
              })}
              {homeTracks.data?.length === 0 && <div className="home-tracks-empty">播放过的歌曲会出现在这里</div>}
            </div>
          </section></>}
          </>}
          </div>
        </div>
      </main>

      {queueOpen && isMobile && <button className="queue-sheet-backdrop" aria-label="收起播放队列" onClick={toggleQueue} />}
      <aside className={`queue-drawer${isMobile ? ' queue-sheet' : ''}`} aria-hidden={!queueOpen}>
        {isMobile && <button className="queue-sheet-handle" aria-label="收起播放队列" onClick={toggleQueue}><span /></button>}
        <header><div><span className="eyebrow coral">播放队列 · {queue.length}</span><h3 className="queue-heading-title">{queueSource?.kind === 'video' && queue.length > 1 ? '视频选集' : queueSource?.kind === 'season' ? queueSource.title : '接下来'}</h3></div><div className="queue-header-actions"><button disabled={queue.length < 2} onClick={reverseQueue} aria-pressed={queueReversed} aria-label={queueReversed ? '恢复原序' : '倒序播放'} title={queueReversed ? '恢复原序' : '倒序播放'}><ArrowDownUp size={16}/><span>{queueReversed ? '倒序' : '原序'}</span></button><button disabled={!queue.length} onClick={clearQueue} aria-label="清空队列"><Trash2 size={16} /></button><button onClick={toggleQueue} aria-label="收起队列">{isMobile ? <ChevronDown size={20}/> : '×'}</button></div></header>
        <div className="now-card">
          <Artwork src={current?.coverUrl} className="now-art" />
          <div className="now-meta"><div><strong>{current?.title || '尚未播放'}</strong><small>{current ? current.artist || '歌手未知' : '选择一首歌开始'}</small></div><button className={current?.liked ? 'icon-action liked' : 'icon-action'} onClick={() => void toggleCurrentFavorite()} disabled={!current}><Heart size={19} fill={current?.liked ? 'currentColor' : 'none'} /></button></div>
        </div>
        <QueueList open={queueOpen}/>
      </aside>

      <footer className="player-dock">
        <div className={`dock-track-group dock-swipe-${dockSwipePhase}`} style={{ '--dock-swipe-x': `${dockSwipeX}px` } as CSSProperties} onPointerDown={startDockSwipe} onPointerMove={moveDockSwipe} onPointerUp={finishDockSwipe} onPointerCancel={() => { dockGesture.current = null; setDockSwipeX(0); setDockSwipePhase('idle') }} onContextMenu={(event) => { if (current) showTrackMenu(event, current) }}><button className="dock-track" onClick={() => { if (suppressDockClick.current) { suppressDockClick.current = false; return }; setLyricsOpen(true) }} disabled={!current} aria-label="打开歌词"><Artwork src={current?.coverUrl} className="dock-cover" adaptAspect /><span><strong>{current?.title || '尚未播放'}</strong><small>{current ? current.artist || '歌手未知' : '从音乐库选择歌曲'}</small></span></button><button className={current?.liked ? 'dock-heart liked' : 'dock-heart'} disabled={!current} aria-busy={favoritePending} aria-label={current?.liked ? '取消喜欢当前歌曲' : '喜欢当前歌曲'} aria-pressed={Boolean(current?.liked)} onClick={() => void toggleCurrentFavorite()}><Heart size={19} fill={current?.liked ? 'currentColor' : 'none'} /></button></div>
        <div className="dock-center">
          {queueFeedback && <div className="queue-switch-notice" key={queueFeedback.serial} role="status">
            <ListMusic size={15}/><span>{queueFeedback.title ? `已切换到 ${queueFeedback.title}` : '已切换播放队列'}</span>
          </div>}
          <div className="dock-controls"><PlaybackModeButton /><button aria-label="上一首" onClick={previous}><SkipBack size={19} fill="currentColor" /></button><button aria-label={status === 'playing' || status === 'buffering' || status === 'resolving' ? '暂停' : '播放'} className="play-toggle" onClick={toggle}>{status === 'playing' || status === 'buffering' || status === 'resolving' ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button><button aria-label="下一首" onClick={() => void next()}><SkipForward size={19} fill="currentColor" /></button><button className={queueOpen ? 'queue-control active' : 'queue-control'} aria-label="播放队列" aria-expanded={queueOpen} onClick={toggleQueue}><ListMusic size={18} /></button></div>
          <PlayerProgress />
        </div>
        <div className="dock-tools"><div id="lyrics-dock-actions" className="lyrics-dock-actions"/><Volume2 size={18} /><RangeControl aria-label="音量" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></div>
      </footer>
      {(playbackError || actionError) && <div className="playback-error" role="alert">{playbackError || actionError}{playbackError && status === 'error' && current && <button onClick={() => void toggle()}>重试</button>}<button onClick={() => { setActionError(''); usePlayerStore.setState({ error: null }) }}>关闭</button></div>}
      {isMobile && <SleepTimer open={sleepTimerOpen} onClose={() => setSleepTimerOpen(false)}/>}
      {lyricsOpen && <LyricsView onMiniPlayer={miniPlayerSupported?()=>void changeMiniMode(true):undefined} onOpenSleepTimer={() => setSleepTimerOpen(true)} onClose={() => setLyricsOpen(false)} onFavorite={() => void toggleCurrentFavorite()} favoritePending={favoritePending} onOpenCollection={item => openCollection(item, 'lyrics')} />}
      {importOpen && <ImportFavorites key={rematchPlaylist?.id||'import'} reviewPlaylist={rematchPlaylist} onImported={(id, mode) => {
        setImportOpen(false)
        setRematchPlaylist(undefined)
        setHubSection(mode === 'link' ? 'collections' : 'playlists')
        libraryReturn.current = { nav: compact ? '此刻' : '歌单', scroll: 0 }
        setActiveNav(`playlist:${id}`)
        requestAnimationFrame(() => { if (contentScroll.current) contentScroll.current.scrollTop = 0 })
      }} onClose={() => {setImportOpen(false);setRematchPlaylist(undefined)}} />}
      {creatingPlaylist && <div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setCreatingPlaylist(false)}}><form className="playlist-create-dialog" role="dialog" aria-modal="true" aria-label="新建歌单" onSubmit={e=>{e.preventDefault();if(playlistName.trim())createList.mutate(playlistName)}}><header><h3>新建歌单</h3><button type="button" aria-label="关闭" onClick={()=>setCreatingPlaylist(false)}><X size={18} /></button></header><input autoFocus maxLength={80} value={playlistName} onChange={e=>setPlaylistName(e.target.value)} placeholder="歌单名称" />{createList.isError && <p className="inline-error">{commandErrorMessage(createList.error)}</p>}<button disabled={createList.isPending || !playlistName.trim()}>创建歌单</button></form></div>}
      <TrackActionsHost />
    </div>{miniMode&&<MiniPlayer busy={miniBusy} onRestore={(lyrics,queue)=>void changeMiniMode(false,lyrics,queue)} onFavorite={()=>void toggleCurrentFavorite()} favoritePending={favoritePending} onError={cause=>setActionError(commandErrorMessage(cause))}/>}
    {miniMode&&(actionError||playbackError)&&<div className="mini-player-error" role="alert"><span>{actionError||playbackError}</span><button onClick={()=>{setActionError('');usePlayerStore.setState({error:null})}} aria-label="关闭提示"><X size={12}/></button></div>}</>
  )
}
