import { isTopOverlay } from '../shared/overlayStack'
import { useOverlayDismiss } from '../shared/useOverlayDismiss'
import { swipeAxis, trackSwipeDirection } from '../shared/gestureRelease'
import { useVerticalDismiss } from '../shared/useVerticalDismiss'
import { usePanelPresence } from '../shared/usePanelPresence'
import { usePanelReveal } from '../shared/usePanelReveal'
import { useMobilePlayerSurface } from '../features/player/useMobilePlayerSurface'
import { usePageMotion } from '../shared/pageMotion'
import { ListSkeleton } from '../shared/ListSkeleton'
import { afterListMotion } from '../shared/navigationListMotion'
import { useListDataDuringNavigation, useListReveal } from '../shared/useListMotion'
import { useListRows } from '../shared/useListRows'
import { captureStagePreview, mountStagePreview } from './stageBackPreview'
import { focusSearch } from '../shared/focusSearch'
import { offlineUnavailable, useOfflinePlayback } from '../features/player/offlinePlayback'
import { useUpdateStore } from '../services/updates'
import { trackSubtitle } from '../domain/sourceTitle'
import { accountQueryKey } from '../services/queryKeys'
import { restoreScroll } from '../shared/restoreScroll'
import {useOrganizer} from '../shared/useOrganizer'
import {useListPreferences,playlistEntity} from '../services/listPreferences'
import {rankList} from '../services/listOrdering'
import { useSyncAttention, revealSync } from '../services/syncAttention'
import { CreatorsView } from '../features/collections/CreatorsView'
import { createLinkedPlaylist } from '../services/desktopApi'
import { PlaylistEntry } from '../features/library/PlaylistEntry'
import { LinkedFolderView } from '../features/library/LinkedFolderView'
import type { Collection } from '../services/collections'
import { useCompactLayout, useTabletWidth } from '../shared/useCompactLayout'
import { CollectionsView, CollectionDetail } from '../features/collections/CollectionsView'
import type { CollectionResumeRequest } from '../features/collections/creatorContinuation'
import { QueueList } from '../features/player/QueueList'
import { SleepTimer } from '../features/player/SleepTimer'
import { PlaybackModeButton } from '../features/player/PlaybackModeButton'
import { PlaylistsView } from '../features/library/PlaylistsView'
import { MyView } from '../features/settings/MyView'
import { hydrateVisibleTracks } from '../features/sync/librarySync'
import { LyricsBackdrop } from '../features/lyrics/LyricsBackdrop'
import { setImmersiveWindow } from '../services/immersiveWindow'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useVisibilityRules } from '../services/contentVisibility'
import { currentDisplayVersion } from '../shared/version'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  UserRound,
  X,
  ArrowLeft,
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Heart,
  Home,
  Library,
  ListFilter,
  ListMusic,
  ListPlus,
  LoaderCircle,
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
import { startPlaybackOnLaunch, usePlayerStore } from '../features/player/playerStore'
import { installWindowShortcuts } from './windowShortcuts'
import { connectMediaSession } from '../features/player/mediaSession'
import { BilibiliFeedView, SearchView } from '../features/search/SearchView'
import { useSearchExtensions } from '../services/extensions'
import { ExtensionsSettings } from '../features/settings/ExtensionsSettings'
import { SimpleSearchLanding } from '../features/search/SimpleSearchLanding'
import { ExploreLanding } from '../features/search/ExploreLanding'
import { ScopedSearchField } from '../features/search/ScopedSearchField'
import { SearchField } from '../features/search/SearchField'
import { useSearchHistory } from '../features/search/useSearchHistory'
import { LibraryView, MusicLibraryView } from '../features/library/LibraryView'
import { LyricsView } from '../features/lyrics/LyricsView'
import { formatDuration } from '../shared/time'
import { commandErrorMessage, createPlaylist, getVideoParts, saveLibraryTrack, FAVORITES_PLAYLIST, inDesktopShell, listPlaylists, listRecentTracks, toggleStoredFavorite } from '../services/desktopApi'
import { CopyPlaybackDiagnostics, PlaybackErrorText } from '../features/player/PlaybackError'
import { toTrack } from '../services/collectionTrack'
import { accountEpoch } from '../services/accountScope'
import { AccountControl } from '../features/account/AccountControl'
import { ImportFavorites } from '../features/library/ImportFavorites'
import { usePlaylistImport } from '../services/playlistImport'
import { ActionMenu } from '../shared/ActionMenu'
import type { Playlist } from '../domain/library'
import { PlayingMark } from '../shared/PlayingMark'
import { Artwork } from '../shared/Artwork'
import { RangeControl } from '../shared/RangeControl'
import { useThemeStore, systemThemeSupported } from '../services/theme'
import { themeActionLabel, themePreferenceLabel } from '../domain/theme'
import { ThemeSystemIcon } from '../shared/ThemeSystemIcon'
import { PlaylistButton, TrackMenuButton, TrackActionsHost } from '../features/library/TrackActions'
import { showTrackMenu } from '../features/library/trackActionStore'
import { isMobile } from '../services/platform'
import { PlayerProgress } from '../features/player/PlayerProgress'
import { usePlaybackChapters } from '../features/chapters/usePlaybackChapters'
import { ChapterTrigger } from '../features/chapters/ChapterTrigger'
import { SidebarResizeHandle } from '../shared/SidebarResizeHandle'
import { QueueResizeHandle } from '../shared/QueueResizeHandle'
import { MiniPlayer } from '../features/player/MiniPlayer'
import { DesktopTitleBar } from '../shared/DesktopTitleBar'
import { desktopChrome } from '../services/desktopWindow'
import { getMiniPlayerMode, miniPlayerSupported, setMiniPlayerMode } from '../services/immersiveWindow'
import { RecommendationView } from '../features/recommendations/RecommendationView'
import { PictureInPicture2 } from 'lucide-react'

const navigation = [
  { label: '此刻', icon: Home },
  { label: '探索', icon: Search },
  { label: '音乐库', icon: Library },
  { label: '收藏库', icon: ListMusic },
  { label: '我的', icon: UserRound },
]

function RetainedStagePage({ active, className = '', swipe, children }: {
  active: boolean
  className?: string
  swipe?: boolean
  children: ReactNode
}) {
  const visited = useRef(false)
  useLayoutEffect(() => {
    if (active) visited.current = true
  }, [active])
  return <div className={`stage-scroll ${className}`} hidden={!active} data-main-swipe={active && swipe || undefined}>
    {(active || visited.current) && children}
  </div>
}

export function App() {
  useVisibilityRules()
  useEffect(() => { void startPlaybackOnLaunch().catch(() => undefined) }, [])
  useEffect(() => { document.getElementById('app-bootstrap')?.remove() }, [])
  const compact=useCompactLayout()
  const updateAvailable = useUpdateStore(state => state.result?.status === 'available')
  const syncAttention = useSyncAttention(state => state.library || state.statistics)
  const [playlistsExpanded, setPlaylistsExpanded] = useState(() => localStorage.getItem('playlists-expanded') !== 'false')
  const [sleepTimerOpen, setSleepTimerOpen] = useState(false)
  const searchInput = useRef<HTMLInputElement>(null)
  const [selectedCollection,setSelectedCollection]=useState<Collection|null>(null)
  const [collectionResume,setCollectionResume]=useState<CollectionResumeRequest>()
  const [collectionSearch,setCollectionSearch]=useState('')

  const [hubSection,setHubSection]=useState<'playlists'|'collections'|'creators'>('playlists')
  const contentScroll=useRef<HTMLDivElement>(null)
  const stageFrame = useRef<HTMLDivElement>(null)
  const activeStageScroll = () => stageFrame.current?.querySelector<HTMLElement>(':scope > .stage-scroll:not([hidden])')
  const previewHost = useRef<HTMLDivElement>(null)
  const searchReturn = useRef<ReturnType<typeof captureStagePreview>>(undefined)
  const recommendationReturn = useRef<ReturnType<typeof captureStagePreview>>(undefined)
  const extensionsReturn = useRef<{ preview: ReturnType<typeof captureStagePreview>; scroll: number }>(undefined)
  const settingsScroll = useRef<HTMLDivElement>(null)
  const recommendationEntry = useRef<HTMLButtonElement>(null)
  const biliFeedEntry = useRef<HTMLButtonElement>(null)
  const exploreFocus = useRef<'每日推荐' | 'B 站推荐'>(undefined)
  const stagePreview = () => isMobile ? captureStagePreview(stageFrame.current) : undefined
  const collectionHistory = useRef<{ item: Collection | null; scroll: number; lyrics: boolean; search:string; preview?: ReturnType<typeof captureStagePreview> }[]>([])
  const libraryReturn = useRef<{ nav: string; preview?: ReturnType<typeof captureStagePreview> } | null>(null)
  const pendingCollectionScroll = useRef<number | undefined>(undefined)
  const cancelCollectionScroll = useRef<(() => void) | undefined>(undefined)
  const scrollCollection = (top: number) => { pendingCollectionScroll.current = top }
  useLayoutEffect(() => {
    const top = pendingCollectionScroll.current
    const scroller = top === undefined ? undefined : activeStageScroll()
    if (top === undefined || !scroller) return
    pendingCollectionScroll.current = undefined
    cancelCollectionScroll.current?.()
    if (top === 0) scroller.scrollTop = 0
    cancelCollectionScroll.current = top > 0 ? restoreScroll(scroller, top) : undefined
  })
  useEffect(() => () => cancelCollectionScroll.current?.(), [])
  const resetCollection = () => {
    collectionHistory.current = []
    setSelectedCollection(null)
    setCollectionResume(undefined)
    setCollectionSearch('')
  }
  const openCollection = (item: Collection, origin?: 'lyrics' | 'collection', resume?: CollectionResumeRequest) => {
    const scroll = activeStageScroll()?.scrollTop || 0
    if (origin) {
      collectionHistory.current.push({ item: selectedCollection, scroll, lyrics: origin === 'lyrics', search:collectionSearch, preview: stagePreview() })
    } else {
      collectionHistory.current = [{ item: null, scroll: collectionHistory.current[0]?.scroll ?? scroll, lyrics: false, search:collectionSearch, preview: collectionHistory.current[0]?.preview ?? stagePreview() }]
    }
    if (origin === 'lyrics') setLyricsOpen(false)
    setSelectedCollection(item)
    setCollectionResume(resume)
    setCollectionSearch('')
    scrollCollection(0)
  }
  const closeCollection = () => {
    const origin = collectionHistory.current.pop()
    setSelectedCollection(origin?.item ?? null)
    setCollectionResume(undefined)
    setCollectionSearch(origin?.search ?? '')
    if (origin?.lyrics && usePlayerStore.getState().current) setLyricsOpen(true)
    scrollCollection(origin?.scroll ?? 0)
  }
  useEffect(() => {
    const clear = () => { resetCollection(); setActiveNav('此刻'); setImportOpen(false); setRematchPlaylist(undefined); setSleepTimerOpen(false); setLyricsOpen(false); libraryReturn.current = null; searchReturn.current = undefined; recommendationReturn.current = undefined; exploreFocus.current = undefined }
    window.addEventListener('bilimusic-account-changing', clear)
    return () => window.removeEventListener('bilimusic-account-changing', clear)
  }, [])
  const [activeNav, setActiveNav] = useState('此刻')
  const [libraryTab, setLibraryTab] = useState<'saved' | 'recent' | 'downloads'>('saved')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const searchScroll = useRef<HTMLDivElement>(null)
  useEffect(() => { if (searchScroll.current) searchScroll.current.scrollTop = 0 }, [submittedQuery])
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [duplicatePreview, setDuplicatePreview] = useState(false)
  const [miniMode,setMiniMode]=useState(false)
  const chapters = usePlaybackChapters(lyricsOpen && !miniMode)
  const [fullscreenLayout, setFullscreenLayout] = useState<'compact' | 'wide' | null>(null)
  // The native rotation can cross the layout breakpoint. Keep the same
  // LyricsView and video element until full screen has been dismissed.
  const compactPlayer = isMobile && (fullscreenLayout ? fullscreenLayout === 'compact' : compact)
  const tabletPlayer = useTabletWidth() && isMobile
  const setVideoFullscreen = useCallback((enabled: boolean) => {
    setFullscreenLayout(enabled ? (compactPlayer ? 'compact' : 'wide') : null)
  }, [compactPlayer])
  useEffect(() => {
    if (!lyricsOpen || miniMode) setFullscreenLayout(null)
  }, [lyricsOpen, miniMode])
  const mobilePlayer = useMobilePlayerSurface(compactPlayer, lyricsOpen && !miniMode, tabletPlayer)
  const immersivePresent = usePanelPresence(lyricsOpen && !miniMode && !compactPlayer, tabletPlayer ? 224 : isMobile ? 160 : 210)
  const lyricsPresent = compactPlayer ? mobilePlayer.present : immersivePresent
  useEffect(() => {
    if (!lyricsOpen && !lyricsPresent) setDuplicatePreview(false)
  }, [lyricsOpen, lyricsPresent])
  const desktopLyrics = !isMobile && immersivePresent
  const desktopLyricsSurface = useRef<HTMLDivElement>(null)
  usePanelReveal(desktopLyricsSurface, lyricsOpen && !miniMode)
  const lyricsTrigger = useRef<HTMLElement>(null)
  const showLyrics = (trigger: HTMLElement, restoreFocus = true) => {
    lyricsTrigger.current = restoreFocus ? trigger : null
    setLyricsOpen(true)
  }
  useLayoutEffect(() => {
    if (lyricsPresent) return
    if (lyricsTrigger.current?.isConnected && !lyricsTrigger.current.closest('[inert]') &&
      (document.activeElement === document.body || document.activeElement === null)) {
      lyricsTrigger.current.focus({ preventScroll: true })
    }
    lyricsTrigger.current = null
  }, [lyricsPresent])
  const [miniBusy,setMiniBusy]=useState(false)
  const [windowReady,setWindowReady]=useState(!miniPlayerSupported)
  const miniRestoreLyrics=useRef(false)
  const miniChanging=useRef(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const createDialog = useRef<HTMLDivElement>(null)
  useOverlayDismiss(createDialog, creatingPlaylist, () => setCreatingPlaylist(false))
  const [playlistName, setPlaylistName] = useState('')
  const [createLinked, setCreateLinked] = useState(false)
  const [actionError, setActionError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const importJobState = usePlaylistImport(value => value.job?.state)
  const importRunning = importJobState === 'matching' || importJobState === 'waiting' || importJobState === 'saving'
  const [rematchPlaylist,setRematchPlaylist]=useState<Playlist>()
  const [favoritePending, setFavoritePending] = useState(false)
  const favoriteDesired = useRef<boolean | undefined>(undefined)
  const favoriteRunning = useRef(false)
  const dockGesture = useRef<{ id: number; startX: number; startY: number; startedAt: number; group: HTMLElement; axis?: ReturnType<typeof swipeAxis> } | null>(null)
  const suppressDockClick = useRef(false)
  const dockSwitch = useRef<{ from: string; direction: number; expires: number } | undefined>(undefined)
  const [dockSwipePhase, setDockSwipePhase] = useState<'idle' | 'dragging' | 'enter-left' | 'enter-right'>('idle')
  const themePreference = useThemeStore((state) => state.preference)
  const cycleTheme = useThemeStore((state) => state.cycleTheme)
  const systemSupported = systemThemeSupported()
  const queryClient = useQueryClient()
  useEffect(() => {
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: accountQueryKey('playlists') }); void queryClient.invalidateQueries({ queryKey: accountQueryKey('library') }) }
    window.addEventListener('bilimusic-import-updated', refresh)
    return () => window.removeEventListener('bilimusic-import-updated', refresh)
  }, [queryClient])
  const { history: searchHistory, onClear: clearHistory, clearing: clearingHistory } = useSearchHistory()
  const playlists = useQuery({ queryKey: accountQueryKey('playlists'), queryFn: listPlaylists })
  const offline = useOfflinePlayback()
  const homeTracks = useQuery({ queryKey: accountQueryKey('home-recent'), queryFn: listRecentTracks })
  useEffect(() => afterListMotion(() => {
    void hydrateVisibleTracks(homeTracks.data, queryClient).catch(() => undefined)
  }), [homeTracks.data, queryClient])
  const createList = useMutation({ mutationFn: (name: string) => createLinked ? createLinkedPlaylist(name) : createPlaylist(name), onSuccess: (playlist) => { queryClient.invalidateQueries({ queryKey: accountQueryKey('playlists') }); setActiveNav(`playlist:${playlist.id}`); setCreatingPlaylist(false); setPlaylistName(''); setCreateLinked(false) } })
  const displayPreferences=useListPreferences()
  const allPlaylists = rankList(playlists.data || [FAVORITES_PLAYLIST],displayPreferences.data?.preferences||[],playlistEntity)
  const sidebarOrganizer = useOrganizer(allPlaylists.map(item => ({ id: playlistEntity(item), name: item.name })), '整理歌单')
  const activePlaylist = allPlaylists.find(playlist => activeNav === `playlist:${playlist.id}`)
  const activeFolder = activeNav.startsWith('collections:') ? activeNav.slice('collections:'.length) : undefined
  const activeCreatorFolder=activeNav.startsWith('creator-folder:')?activeNav.slice('creator-folder:'.length):undefined
  const libraryDetail = activeNav.startsWith('playlist:') || activeFolder !== undefined || activeCreatorFolder!==undefined
  const searchActive = activeNav === '探索' && !selectedCollection
  const enabledSearchExtensions = useSearchExtensions()
  const showDaily = enabledSearchExtensions.includes('daily')
  const showBiliFeed = enabledSearchExtensions.includes('feed')
  const searchLabel = '搜索'
  const exploreLandingActive = searchActive && !submittedQuery
  const homeActive = !selectedCollection && (activeNav === '此刻' || compact && activeNav === '收藏库')
  const hubActive = !selectedCollection && !compact && activeNav === '收藏库'
  const musicActive = !selectedCollection && activeNav === '音乐库'
  const recommendationActive = showDaily && !selectedCollection && activeNav === '每日推荐'
  const biliFeedActive = showBiliFeed && !selectedCollection && activeNav === 'B 站推荐'
  const exploreDetail = recommendationActive || biliFeedActive
  const creatorsActive = !selectedCollection && activeNav === '关注'
  const settingsActive = !selectedCollection && activeNav === '我的'
  const extensionsActive = !selectedCollection && activeNav === '扩展'
  const detailActive = !!selectedCollection || libraryDetail
  const pageAccount = accountEpoch()
  const recentHomeTracks = useListDataDuringNavigation(homeTracks.data, 'home-recent')
  const loadingRecentHome = homeTracks.isLoading || Boolean(homeTracks.data && !recentHomeTracks)
  const recentHomeActive = homeActive && !compact
  const recentHomeTable = useRef<HTMLDivElement>(null)
  const recentHomeRows = useListRows(recentHomeTracks || [], 'home-recent', { active: recentHomeActive })
  useListReveal(recentHomeTable, loadingRecentHome, Boolean(recentHomeTracks?.length), recentHomeActive)
  const pageKey = selectedCollection ? `collection:${selectedCollection.bvid}` : searchActive ? `search:${submittedQuery}` : activeNav
  const pageDepth = Number(libraryDetail) + Number(extensionsActive || activeNav === '每日推荐' || activeNav === 'B 站推荐' || activeNav === '探索' && Boolean(submittedQuery)) + (selectedCollection ? collectionHistory.current.length : 0)
  const backPreview = selectedCollection ? collectionHistory.current.at(-1)?.preview :
    libraryDetail ? libraryReturn.current?.preview : exploreDetail ? recommendationReturn.current :
    extensionsActive ? extensionsReturn.current?.preview : searchActive && submittedQuery ? searchReturn.current : undefined
  useLayoutEffect(() => {
    if (previewHost.current) mountStagePreview(previewHost.current, backPreview)
  }, [backPreview])
  usePageMotion(isMobile ? stageFrame : searchActive ? searchScroll : contentScroll, pageKey, pageDepth, isMobile, undefined, pageDepth > 0)
  useLayoutEffect(() => {
    if (!exploreLandingActive || !exploreFocus.current) return
    const entry = exploreFocus.current === '每日推荐' ? recommendationEntry : biliFeedEntry
    exploreFocus.current = undefined
    entry.current?.focus({ preventScroll: true })
  }, [exploreLandingActive])
  useLayoutEffect(() => {
    const settings = settingsScroll.current
    if (!settingsActive || !settings || !extensionsReturn.current) return
    settings.scrollTop = extensionsReturn.current.scroll
    extensionsReturn.current = undefined
    settings.querySelector<HTMLButtonElement>('.extension-settings-entry')?.focus({ preventScroll: true })
  }, [settingsActive])
  useEffect(() => {
    if (activeNav === '每日推荐' && !showDaily || activeNav === 'B 站推荐' && !showBiliFeed) setActiveNav('探索')
  }, [activeNav, showDaily, showBiliFeed])
  const navIsActive = (label: string) => activeNav === label || (exploreDetail && label === '探索') || (extensionsActive && label === '我的') || (libraryDetail && label === (compact ? '此刻' : '收藏库'))
  useEffect(resetCollection, [activeNav])

  const openLibraryPage = (nav: string) => {
    resetCollection()
    setLyricsOpen(false)
    if (nav === activeNav) return
    if (!libraryDetail) {
      const origin = activeNav === '探索' ? (compact ? '此刻' : '收藏库') : activeNav
      libraryReturn.current = { nav: origin, preview: stagePreview() }
    }
    setActiveNav(nav)
    scrollCollection(0)
  }
  const closeLibraryPage = () => {
    const origin = libraryReturn.current
    libraryReturn.current = null
    setActiveNav(origin?.nav || (compact ? '此刻' : '收藏库'))
  }
  const openPlaylist = (id: string) => openLibraryPage(`playlist:${id}`)
  const openFolder = (id: string) => openLibraryPage(`collections:${id}`)
  const openCreatorFolder=(id:string)=>openLibraryPage(`creator-folder:${id}`)
  const playlistRemoved = (id: string) => { if (activeNav === `playlist:${id}`) closeLibraryPage() }
  const folderRemoved = (id: string) => { if (activeFolder === id) closeLibraryPage() }
  const hub = <PlaylistsView playlists={allPlaylists} loading={playlists.isLoading} onOpen={openPlaylist} onRemoved={playlistRemoved}
    onCreate={() => setCreatingPlaylist(true)} onImport={() => setImportOpen(true)}
    onCollectionOpen={openCollection} onOpenFolder={openFolder} onOpenCreatorFolder={openCreatorFolder} section={hubSection} onSectionChange={setHubSection}/>
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
      void queryClient.invalidateQueries({ queryKey: accountQueryKey('library') })
      void queryClient.invalidateQueries({ queryKey: accountQueryKey('home-recent') })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [current?.id, current?.partCount, current?.resolveParts, queryClient])
  const status = usePlayerStore((state) => state.status)
  const queueOpen = usePlayerStore((state) => state.queueOpen)
  const [queueSorting, setQueueSorting] = useState(false)
  const queueSheet = isMobile && compact
  const queuePresent = usePanelPresence(queueOpen, 220)
  const queuePanel = useRef<HTMLElement>(null)
  const queueTrigger = useRef<HTMLButtonElement>(null)
  const closeQueue = () => usePlayerStore.setState({ queueOpen: false })
  const queueDrag = useVerticalDismiss(queuePanel, queueOpen && queueSheet, closeQueue)
  useOverlayDismiss(queuePanel, queueOpen && !miniMode, closeQueue)
  useLayoutEffect(() => {
    if (!queueOpen || !queueSheet || miniMode) return
    const opener = document.activeElement
    queuePanel.current?.querySelector('button')?.focus({ preventScroll: true })
    return () => {
      requestAnimationFrame(() => {
        if (usePlayerStore.getState().queueOpen || document.activeElement !== document.body) return
        const target = opener instanceof HTMLElement && opener.isConnected && opener !== document.body ? opener : queueTrigger.current
        if (!target?.closest('[inert]')) target?.focus({ preventScroll: true })
      })
    }
  }, [queueOpen, queueSheet, miniMode])
  useEffect(() => {
    if (!queueOpen || queueSheet || miniMode) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (event.button !== 0 || target?.closest('.queue-drawer, .queue-control, .player-dock, [aria-modal="true"], [role="menu"], .action-menu-panel, .track-context-menu')) return
      usePlayerStore.setState({queueOpen:false})
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [queueOpen, queueSheet, miniMode])
  const queue = usePlayerStore((state) => state.queue)
  useLayoutEffect(() => {
    if (!queueOpen || queue.length < 2) setQueueSorting(false)
  }, [queueOpen, queue.length])
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
      if(enabled)miniRestoreLyrics.current=lyricsOpen
      const active=await setMiniPlayerMode(enabled)
      setMiniMode(active)
      if(active)setLyricsOpen(false)
      else{
        setLyricsOpen(lyrics||(!queue&&miniRestoreLyrics.current))
        if(queue)usePlayerStore.setState({queueOpen:true})
      }
    }catch(cause){setActionError(commandErrorMessage(cause))}
    finally{miniChanging.current=false;setMiniBusy(false)}
  }

  const openSearch = (value?: string, keepInputFocus = false) => {
    resetCollection(); setActiveNav('探索'); setLyricsOpen(false)
    if (value !== undefined) {
      if (!value.trim()) searchReturn.current = undefined
      else if (searchActive && !submittedQuery) searchReturn.current = stagePreview()
      setQuery(value); setSubmittedQuery(value.trim()); setSearchFocused(keepInputFocus)
    }
  }
  const openSearchInput = () => {
    // iOS only shows the keyboard when focus happens within the original tap.
    focusSearch(() => openSearch(), searchInput)
  }
  const openExploreDetail = (page: '每日推荐' | 'B 站推荐') => {
    recommendationReturn.current = stagePreview()
    searchInput.current?.blur()
    setSearchFocused(false)
    setActiveNav(page)
  }
  const closeExploreDetail = () => {
    exploreFocus.current = recommendationActive ? '每日推荐' : 'B 站推荐'
    openSearch()
  }
  const openExtensions = () => {
    extensionsReturn.current = { preview: stagePreview(), scroll: settingsScroll.current?.scrollTop ?? 0 }
    setActiveNav('扩展')
  }
  const runSearch = (value: string) => {
    const normalized = value.trim()
    if (!normalized) { openSearch(''); return }
    openSearch(normalized)
    queryClient.setQueryData<string[]>(accountQueryKey('search-history'), (existing = []) => [normalized, ...existing.filter((item) => item !== normalized)].slice(0, 30))
  }
  const submitSearch = (event: FormEvent) => { event.preventDefault(); if (!selectedCollection) runSearch(query) }
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
        queryClient.invalidateQueries({ queryKey: accountQueryKey('library') }),
        queryClient.invalidateQueries({ queryKey: accountQueryKey('home-recent') }),
        queryClient.invalidateQueries({ queryKey: accountQueryKey('playlists') }),
      ])
    } catch (error) {
      favoriteDesired.current = undefined
      const track = usePlayerStore.getState().queue.find(item => item.id === latest.id) || latest
      updatePlayerTrack({ ...track, liked: confirmed })
      setActionError(`收藏失败，已恢复原状态：${commandErrorMessage(error)}`)
    } finally { favoriteRunning.current = false; setFavoritePending(false) }
  }
  useEffect(connectMediaSession, [])
  useEffect(() => {
    if (!isMobile || !windowReady || miniMode) return
    void setImmersiveWindow(lyricsOpen, tabletPlayer).catch((error) => setActionError(commandErrorMessage(error)))
  }, [lyricsOpen,miniMode,windowReady,tabletPlayer])
  useEffect(() => {
    const refreshRecent = () => {
      void queryClient.invalidateQueries({ queryKey: accountQueryKey('home-recent') })
      void queryClient.invalidateQueries({ queryKey: accountQueryKey('library', 'recent') })
    }
    window.addEventListener('bilimusic-recent-changed', refreshRecent)
    return () => window.removeEventListener('bilimusic-recent-changed', refreshRecent)
  }, [queryClient])
  useLayoutEffect(() => {
    const pending = dockSwitch.current
    if (!pending || current?.id === pending.from) return
    dockSwitch.current = undefined
    if (current && !dockGesture.current && performance.now() < pending.expires) {
      setDockSwipePhase(pending.direction < 0 ? 'enter-left' : 'enter-right')
    }
  }, [current?.id])

  const startDockSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    suppressDockClick.current = false
    const target = event.target as Element
    const group = event.currentTarget.querySelector<HTMLDivElement>('.dock-track-group')
    if (!isMobile || !current || dockGesture.current || !event.isPrimary || event.button !== 0 || event.pointerType === 'mouse' ||
        !group || target.closest('button:not(.dock-track),input,[role="slider"]')) return
    dockGesture.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, startedAt: event.timeStamp, group }
    // Keep capture on the original target. Moving it to the wrapper emits
    // lostpointercapture on the pressed button during the same gesture.
    target.setPointerCapture(event.pointerId)
    setDockSwipePhase('idle')
  }
  const moveDockSwipe = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = dockGesture.current
    if (gesture?.id !== event.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    if (!gesture.axis) {
      gesture.axis = swipeAxis(dx, dy)
      if (!gesture.axis) return
      if (gesture.axis === 'horizontal') setDockSwipePhase('dragging')
    }
    if (gesture.axis === 'horizontal') gesture.group.style.setProperty('--dock-drag-x', `${Math.max(-96, Math.min(96, dx * .82))}px`)
  }
  const settleDockSwipe = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const gesture = dockGesture.current
    if (gesture?.id !== event.pointerId) return
    dockGesture.current = null
    gesture.group.style.removeProperty('--dock-drag-x')
    const dx = event.clientX - gesture.startX, dy = event.clientY - gesture.startY
    const elapsed = event.timeStamp - gesture.startedAt
    const axis = gesture.axis ?? swipeAxis(dx, dy)
    suppressDockClick.current = Boolean(axis)
    const direction = commit && axis === 'horizontal' ? trackSwipeDirection(dx, elapsed) : 0
    setDockSwipePhase('idle')
    if (direction && current) dockSwitch.current = { from: current.id, direction, expires: performance.now() + 1200 }
    if (direction < 0) void next()
    else if (direction > 0) void previous()
  }
  useEffect(installWindowShortcuts, [])

  useEffect(() => {
    const back = (event: Event) => {
      if (event.defaultPrevented || miniMode) return
      if (importOpen) { event.preventDefault(); setImportOpen(false); setRematchPlaylist(undefined); return }
      if (lyricsOpen) { event.preventDefault(); setLyricsOpen(false); return }
      if (searchFocused) { event.preventDefault(); searchInput.current?.blur(); setSearchFocused(false); return }
      if(selectedCollection){event.preventDefault();closeCollection();return}
      if (libraryDetail) { event.preventDefault(); closeLibraryPage(); return }
      if (exploreDetail) { event.preventDefault(); closeExploreDetail(); return }
      if (extensionsActive) { event.preventDefault(); setActiveNav('我的'); return }
      if (activeNav === '探索' && submittedQuery) { event.preventDefault(); openSearch(''); return }
      if (activeNav !== '此刻') { event.preventDefault(); setActiveNav('此刻') }
    }
    window.addEventListener('bilimusic-back', back)
    return () => window.removeEventListener('bilimusic-back', back)
  }, [lyricsOpen, importOpen, searchFocused, libraryDetail, selectedCollection, submittedQuery, activeNav, exploreDetail, extensionsActive, miniMode])

  const browseInert = lyricsPresent
  const wideTabletDock = tabletPlayer && !compactPlayer
  const renderLyrics = () => (
      <LyricsView open={lyricsOpen} duplicatePreview={duplicatePreview} chapters={chapters} fullscreenRequested={fullscreenLayout !== null} setVideoFullscreen={setVideoFullscreen} motionSurface={compactPlayer ? mobilePlayer.ref : undefined} onSwipeRelease={compactPlayer ? mobilePlayer.releaseDismiss : undefined} inert={queueSheet && queueOpen} onMiniPlayer={miniPlayerSupported?()=>void changeMiniMode(true):undefined} onOpenSleepTimer={() => setSleepTimerOpen(true)} onClose={() => setLyricsOpen(false)} onFavorite={() => void toggleCurrentFavorite()} favoritePending={favoritePending} onOpenCollection={item => openCollection(item, 'lyrics')} />
  )
  const renderDockTrack = (showCollapse: boolean, inactive = false) => (
    <div className={`dock-track-group dock-swipe-${dockSwipePhase}`} data-dock-track={showCollapse ? 'lyrics' : 'browse'}
      inert={inactive} onAnimationEnd={event => { if (event.target === event.currentTarget) setDockSwipePhase('idle') }}
      onContextMenu={(event) => { if (current) showTrackMenu(event, current) }}>
      <button className="dock-track" onClick={event => {
        if (event.detail && suppressDockClick.current) { suppressDockClick.current = false; return }
        if (lyricsOpen) setLyricsOpen(false)
        else showLyrics(event.currentTarget, !compactPlayer || event.detail === 0)
      }} disabled={!current} aria-expanded={lyricsOpen} aria-label={lyricsOpen ? (duplicatePreview ? '返回查重' : '收起歌词') : '打开歌词'}>
        {!(wideTabletDock && showCollapse) && <><Artwork variant="thumbnail" src={current?.coverUrl} className="dock-cover" adaptAspect /><span className="dock-track-copy"><strong>{current?.title || '尚未播放'}</strong><small>{current ? trackSubtitle(current) : '从音乐库选择歌曲'}</small></span></>}
        <span className="dock-lyrics-collapse" aria-hidden="true"><ChevronDown size={16} /><span>{duplicatePreview ? '返回查重' : '收起歌词'}</span></span>
      </button>
      <button className={current?.liked ? 'dock-heart liked' : 'dock-heart'} disabled={!current} aria-busy={favoritePending}
        aria-label={current?.liked ? '取消喜欢当前歌曲' : '喜欢当前歌曲'} aria-pressed={Boolean(current?.liked)}
        onClick={() => void toggleCurrentFavorite()}><Heart size={19} fill={current?.liked ? 'currentColor' : 'none'} /></button>
    </div>
  )
  const renderDock = (expanded = false, immersiveDesktop = false) => {
    const detailDock = expanded || immersiveDesktop || (isMobile && !compactPlayer && lyricsOpen)
    const browseDock = !expanded && !immersiveDesktop
    const phoneChapters = detailDock && isMobile && !tabletPlayer && chapters.items.length > 0
    return (
    <footer className="player-dock" data-mini-dock={compactPlayer && !expanded || undefined}
      data-tablet-lyrics-dock={expanded && tabletPlayer || undefined}
      data-dock-crossfade={browseDock && (!isMobile || tabletPlayer) || undefined}
      data-dock-lyrics-open={browseDock && lyricsOpen || undefined}
      data-wide-tablet-dock={browseDock && wideTabletDock || undefined}
      inert={queueSheet && queueOpen || (expanded || immersiveDesktop ? !lyricsOpen : (compactPlayer || !isMobile) && browseInert)}
      {...(!expanded ? {
        onPointerDown: startDockSwipe, onPointerMove: moveDockSwipe,
        onPointerUp: (event: ReactPointerEvent<HTMLElement>) => settleDockSwipe(event, true),
        onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => settleDockSwipe(event, false),
        onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => settleDockSwipe(event, false),
      } : {})}>
        {!expanded && renderDockTrack(immersiveDesktop, wideTabletDock && lyricsOpen)}
        {browseDock && wideTabletDock && renderDockTrack(true, !lyricsOpen)}
        <div className="dock-center">
          {queueFeedback && (!compactPlayer || expanded === lyricsOpen) && <div className="queue-switch-notice" key={queueFeedback.serial} role="status">
            <ListMusic size={15}/><span>{queueFeedback.title ? `已切换到 ${queueFeedback.title}` : '已切换播放队列'}</span>
          </div>}
          <div className="dock-controls"><PlaybackModeButton /><button data-playback-space-pointer aria-label="上一首" onClick={previous}><SkipBack size={19} fill="currentColor" /></button><button data-playback-space-pointer aria-label={status === 'playing' || status === 'buffering' || status === 'resolving' ? '暂停' : '播放'} className="play-toggle" onClick={toggle}>{status === 'playing' || status === 'buffering' || status === 'resolving' ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button><button data-playback-space-pointer aria-label="下一首" onClick={() => void next()}><SkipForward size={19} fill="currentColor" /></button><button ref={(isMobile ? !compactPlayer || expanded === lyricsOpen : immersiveDesktop === desktopLyrics) ? queueTrigger : undefined} className={queueOpen ? 'queue-control active' : 'queue-control'} aria-label="播放队列" aria-expanded={queueOpen} onClick={toggleQueue}><ListMusic size={18} /></button></div>
          <PlayerProgress chapters={detailDock ? chapters.items : undefined}
            endControl={phoneChapters ? <ChapterTrigger model={chapters} variant="time"/> : undefined}/>
        </div>
        {!expanded && <div className="dock-tools">{(isMobile || immersiveDesktop) && <div id="lyrics-dock-actions" className="lyrics-dock-actions" inert={wideTabletDock && !lyricsOpen}/>}<Volume2 size={18} /><RangeControl data-playback-space-range aria-label="音量" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></div>}
        {expanded && tabletPlayer && <div id="lyrics-tablet-dock-actions" className="lyrics-dock-actions"/>}
      </footer>
    )
  }

  return (
    <>{desktopChrome && !miniMode && <DesktopTitleBar />}
    <div hidden={miniMode} className={`app-shell ${queueOpen ? 'queue-visible' : ''} ${desktopLyrics ? 'desktop-lyrics-present' : immersivePresent && !compactPlayer ? 'lyrics-immersive frame-browser' : ''}`}>
      {isMobile && immersivePresent && !compactPlayer && <LyricsBackdrop cover={current?.coverUrl} className="immersive-backdrop" open={lyricsOpen} />}
      <aside inert={browseInert || queueSheet && queueOpen} className="rail" aria-label="主导航">
        <button className="brand-mark" aria-label="BiliMusic 首页" onClick={() => { resetCollection(); setActiveNav('此刻') }}>
          <Waves size={23} strokeWidth={2.5} />
        </button>
        <nav className="rail-nav">
          {navigation.filter(item=>!compact||(item.label!=='收藏库' && item.label!=='关注')).map(({ label, icon: Icon }) => (
            <button
              className={navIsActive(label) ? 'rail-button active' : 'rail-button'}
              key={label}
              onClick={() => { libraryReturn.current = null; if (label === '探索') { if (exploreDetail) closeExploreDetail(); else openSearch(); return }; setActiveNav(label); if (label === '我的' && syncAttention) revealSync(); resetCollection(); setLyricsOpen(false) }}
              title={label === '探索' ? searchLabel : label}
              aria-label={label === '我的' ? `我的${syncAttention ? `，${syncAttention}` : updateAvailable ? '，有新版本' : ''}` : label === '探索' ? searchLabel : label}
              aria-current={navIsActive(label) ? 'page' : undefined}
            >
              <Icon size={20} />{label === '我的' && syncAttention && <span className="sync-nav-warning" aria-hidden="true">!</span>}{label === '我的' && updateAvailable && !syncAttention && <span className="update-nav-dot" aria-hidden="true"/>}<span className="mobile-nav-label">{label === '探索' ? searchLabel : label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <aside inert={browseInert || queueSheet && queueOpen} id="library-navigation" className="library-panel" aria-label="收藏库导航">
        <header className="library-brand"><h1>BiliMusic</h1></header>
        <section className="sidebar-section">
          <div className="section-heading">
            <button className="sidebar-collapse" aria-expanded={playlistsExpanded} onClick={() => setPlaylistsExpanded(value => { localStorage.setItem('playlists-expanded', String(!value)); return !value })}>
              {playlistsExpanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
              <span>歌单</span>
              <small className="sidebar-count">{allPlaylists.length}</small>
            </button>
            <div className="sidebar-heading-actions library-action-rail" hidden={!playlistsExpanded}>
              {sidebarOrganizer.controls}
              <ActionMenu disabled={sidebarOrganizer.editing} panelClassName="sidebar-add-menu" label={importRunning ? '查看导入进度' : '新建或导入歌单'} icon={importRunning ? <LoaderCircle size={15} className="spin"/> : <Plus size={16}/>}>{close => <>
                <button role="menuitem" onClick={() => { close(); setCreatingPlaylist(true) }}><Plus size={16}/><span><strong>新建歌单</strong><small>创建本地或同步 B 站收藏夹</small></span></button>
                <button role="menuitem" onClick={() => { close(); setImportOpen(true) }}><ListPlus size={16}/><span><strong>{importRunning ? '查看导入进度' : '导入歌单'}</strong><small>B 站收藏夹、在线歌单或本地</small></span></button>
              </>}</ActionMenu>
            </div>
          </div>

          {playlistsExpanded && sidebarOrganizer.error && <p className="inline-error" role="alert">{sidebarOrganizer.error}</p>}
          <div className="collection-list" hidden={!playlistsExpanded} {...sidebarOrganizer.listProps}>
            {sidebarOrganizer.order(allPlaylists, playlistEntity).map(playlist => <PlaylistEntry key={playlist.id} playlist={playlist} sidebar order={{ organizer: sidebarOrganizer, id: playlistEntity(playlist) }}
              active={activeNav === `playlist:${playlist.id}`} onOpen={() => openPlaylist(playlist.id)} onRemoved={() => playlistRemoved(playlist.id)}/>)}
          </div>
        </section>
        <CollectionsView sidebar onOpenFolder={openFolder} onOpenLinked={openPlaylist}
          onLinkedRemoved={playlistRemoved} onSelect={openCollection} onFolderRemoved={folderRemoved}/>
        <CreatorsView followed sidebar onOpen={openCollection} onOpenFolder={openCreatorFolder} onFolderRemoved={id=>{if(activeCreatorFolder===id)closeLibraryPage()}}/>
        <div className="library-footer"><Sparkles size={16} /> 独立音乐空间 · {currentDisplayVersion}</div>
      </aside>
      {!isMobile && <SidebarResizeHandle/>}

      <main inert={browseInert || queueSheet && queueOpen} className="content-stage" data-stage-route={pageKey} data-edge-back={isMobile && backPreview ? '' : undefined}>
        {isMobile && <div className="stage-back-preview" ref={previewHost} aria-hidden="true" inert/>}
        <div ref={stageFrame} className="stage-route-frame" data-edge-track>
        {exploreDetail || extensionsActive ? <header className="topbar recommendation-topbar">
          <button type="button" aria-label={extensionsActive ? '返回设置' : '返回搜索'} onClick={extensionsActive ? () => setActiveNav('我的') : closeExploreDetail}><ArrowLeft size={19}/></button>
          <h1>{activeNav}</h1>
        </header> : <form className={`topbar ${searchActive ? 'searching' : ''}${exploreLandingActive ? ' explore-topbar' : ''}${selectedCollection ? ' scoped-content-search' : ''}`} onSubmit={submitSearch}>
          <div className="mobile-page-heading">
            {(libraryDetail || selectedCollection) && <button type="button" aria-label="返回上一页" onClick={selectedCollection ? closeCollection : closeLibraryPage}><ArrowLeft size={18}/></button>}
            <strong>{selectedCollection ? selectedCollection.bvid.startsWith('up:') ? 'UP 主详情' : '合集详情' : activePlaylist?.name || (activeCreatorFolder!==undefined?'关注文件夹':activeFolder !== undefined ? '收藏夹' : searchActive ? searchLabel : activeNav)}</strong>
          </div>
          {exploreLandingActive ? <h1 className="explore-topbar-title">搜索</h1> :
            <div className="history-buttons"><button type="button" disabled={!selectedCollection && !libraryDetail && activeNav === '此刻'} aria-label={libraryDetail || selectedCollection || (searchActive && submittedQuery) ? '返回上一页' : '返回主页'}
              onClick={selectedCollection ? closeCollection : libraryDetail ? closeLibraryPage : searchActive && submittedQuery ? () => openSearch('') : () => setActiveNav('此刻')}><ArrowLeft size={18}/></button></div>}
          {selectedCollection ? <ScopedSearchField className="collection-topbar-search" creator={selectedCollection.bvid.startsWith('up:')} value={collectionSearch} onChange={setCollectionSearch}/> : <>
          <SearchField inputRef={searchInput} value={query} focused={searchFocused} history={exploreLandingActive && enabledSearchExtensions.length ? [] : searchHistory}
            onFocus={() => { setSearchFocused(true); resetCollection(); setActiveNav('探索') }} onBlur={() => setSearchFocused(false)}
            onChange={value => { setQuery(value); if (!value.trim()) setSubmittedQuery('') }}
            onSearch={runSearch} onClear={() => openSearch('', true)} onClearHistory={clearHistory} /></>}

          {!selectedCollection && <button className="mobile-search-entry" type="button" aria-label="搜索歌曲" onClick={openSearchInput}><Search size={20} /></button>}
          <div className="topbar-actions">{miniPlayerSupported&&<button type="button" aria-label="迷你播放器" title="迷你播放器 · 置顶悬浮" disabled={miniBusy||!windowReady} onClick={()=>void changeMiniMode(true)}><PictureInPicture2 size={19}/></button>}<button type="button" className="theme-toggle" aria-label={themeActionLabel(themePreference, systemSupported)} title={`${themeActionLabel(themePreference, systemSupported)}（当前${themePreferenceLabel(themePreference)}）`} onClick={() => cycleTheme()}>{themePreference === 'light' ? <Sun size={19} /> : themePreference === 'dark' ? <Moon size={19} /> : <ThemeSystemIcon size={19} />}</button><AccountControl /></div>
        </form>}

        <div className="stage-scroll" ref={searchScroll} hidden={!searchActive}>
          {enabledSearchExtensions.length === 0 ? !submittedQuery && <SimpleSearchLanding onSearch={runSearch}/> :
            <ExploreLanding active={exploreLandingActive} history={searchHistory} onClearHistory={clearHistory} clearingHistory={clearingHistory} onSearch={runSearch}
              onOpenRecommendation={() => openExploreDetail('每日推荐')} recommendationRef={recommendationEntry}
              onOpenBiliFeed={() => openExploreDetail('B 站推荐')} biliFeedRef={biliFeedEntry}/>}
          {submittedQuery && <SearchView key={submittedQuery} query={submittedQuery} active={searchActive} onCollectionOpen={openCollection}/>}
        </div>
        <div className="stage-scroll" ref={contentScroll} hidden={!detailActive}>
          {[...new Map([...collectionHistory.current.map(entry => entry.item), selectedCollection].filter((item): item is Collection => Boolean(item)).map(item => [item.bvid,item])).values()].map(item => <div key={item.bvid} className="collection-route" hidden={item.bvid !== selectedCollection?.bvid}>
            <CollectionDetail item={item} onBack={closeCollection} hideBack active={item.bvid === selectedCollection?.bvid}
              resumeRequest={item.bvid === selectedCollection?.bvid ? collectionResume : undefined}
              searchQuery={item.bvid === selectedCollection?.bvid ? collectionSearch : collectionHistory.current.find(entry => entry.item?.bvid === item.bvid)?.search}
              onOpenCollection={(item, resume) => openCollection(item, 'collection', resume)}/>
          </div>)}
          <div hidden={Boolean(selectedCollection)}>
          {activeCreatorFolder!==undefined ? <CreatorsView key={activeCreatorFolder} followed folderId={activeCreatorFolder} onOpen={openCollection} onOpenFolder={openCreatorFolder} onFolderRemoved={closeLibraryPage}/> : activeFolder !== undefined ? <CollectionsView key={activeFolder} folderId={activeFolder} onOpenFolder={openFolder}
            onOpenLinked={openPlaylist} onLinkedRemoved={playlistRemoved} onSelect={openCollection} onFolderRemoved={folderRemoved}/> :
          activePlaylist?.biliFolderId ? <LinkedFolderView key={activePlaylist.id} playlist={{ ...activePlaylist, biliFolderId: activePlaylist.biliFolderId }} onUnlink={closeLibraryPage}/> :
          activePlaylist ? <LibraryView key={activePlaylist.id} playlist={activePlaylist} active={!selectedCollection && detailActive}
            lyricsPresent={lyricsOpen || lyricsPresent} onPreviewLyrics={() => { setDuplicatePreview(true); setLyricsOpen(true) }}
            onPlaylistDeleted={closeLibraryPage} onRematchImported={playlist=>{const job=usePlaylistImport.getState().job;setRematchPlaylist(job?.playlistId===playlist.id&&job.state!=='done'?undefined:playlist);setImportOpen(true)}}/> :
          libraryDetail && <ListSkeleton label="正在读取歌单" />}
          </div>
        </div>
        <RetainedStagePage key={`home:${pageAccount}`} active={homeActive} swipe>
          <section className="hero">
            {current?.coverUrl && <div className="hero-ambient" aria-hidden="true"><img src={current.coverUrl.replace(/^(?:http:)?\/\//, 'https://')} alt="" decoding="async" referrerPolicy="no-referrer" /></div>}
            <div className="hero-copy">
              <div className="hero-summary">
                <span className="eyebrow coral">{current ? 'NOW PLAYING' : 'YOUR MUSIC SPACE'}</span>
                <h2>{current?.title || '你的音乐，从这里开始'}</h2>
                <p>{current ? `${trackSubtitle(current)}${current.album ? ` · ${current.album}` : ''}` : '搜索 B 站音乐，收藏喜欢的分 P，整理自己的歌单。'}</p>
              </div>
              <button className="primary-action" onClick={() => { if (current) void toggle(); else if (homeTracks.data?.[0]) void usePlayerStore.getState().playFromList(homeTracks.data,homeTracks.data[0].id); else openSearchInput() }}>{status === 'playing' ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}{current ? status === 'playing' ? '暂停播放' : '继续聆听' : homeTracks.data?.length ? '继续聆听' : '开始探索'}</button>
            </div>
            {current && <button className="hero-cover-button" onClick={event => showLyrics(event.currentTarget, !compactPlayer || event.detail === 0)} aria-label="查看当前歌曲歌词"><Artwork src={current.coverUrl} adaptAspect /></button>}
          </section>


          {compact ? hub : <><section className="quick-actions home-quick-actions">
            <button onClick={openSearchInput}><span className="quick-icon coral-bg"><Sparkles /></span><span><strong>探索音乐</strong><small>寻找下一首歌</small></span><ChevronRight /></button>
            <button onClick={() => { openSearch('放松 纯音乐') }}><span className="quick-icon cyan-bg"><Waves /></span><span><strong>此刻放松</strong><small>搜索舒缓旋律</small></span><ChevronRight /></button>
            <button onClick={() => setActiveNav('音乐库')}><span className="quick-icon blue-bg"><ListMusic /></span><span><strong>我的音乐</strong><small>回到你的收藏</small></span><ChevronRight /></button>
          </section>

          <section className="tracks-section">
            <header><div><span className="eyebrow">RECENTLY PLAYED</span><h3>最近听过的声音</h3></div><button onClick={() => { setLibraryTab('recent'); setActiveNav('音乐库') }}>查看全部 <ChevronRight size={16} /></button></header>
            {loadingRecentHome ? <ListSkeleton label="正在读取最近播放" /> : <div className="track-table" role="table" ref={recentHomeTable}>
              <div className="track-row table-head" role="row"><span>#</span><span>歌曲</span><span>歌手</span><span>专辑</span><span>时长</span><span /></div>
              {recentHomeRows.rows.map((track, index) => {
                const isCurrent = current?.id === track.id
                return (
                  <div className="track-row playing-row" data-offline-unavailable={offlineUnavailable(track, offline) || undefined} data-current-row={isCurrent ? track.id : undefined} role="row" key={track.id} onDoubleClick={(event) => { if (offlineUnavailable(track, offline) || (event.target as Element).closest('button, a, input')) return; void usePlayerStore.getState().playFromList(homeTracks.data || [], track.id) }} onContextMenu={(event) => showTrackMenu(event, track,undefined,homeTracks.data)}>
                    <button className="row-play" disabled={offlineUnavailable(track, offline)} onClick={() => usePlayerStore.getState().playFromList(homeTracks.data||[],track.id)} aria-current={isCurrent ? 'true' : undefined} aria-label={`播放 ${track.title}`}>
                      {isCurrent ? <PlayingMark /> : <><span>{index + 1}</span><Play className="hover-play" size={15} fill="currentColor" /></>}
                    </button>
                    <span className="track-title"><button className="home-cover-button" disabled={offlineUnavailable(track, offline)} onClick={() => void usePlayerStore.getState().playFromList(homeTracks.data||[],track.id)} aria-label={`播放 ${track.title} 封面`}><Artwork variant="thumbnail" src={track.coverUrl} className="mini-cover" adaptAspect /></button><strong>{track.title}</strong></span>
                    <span>{track.artist || '歌手未知'}</span><span>{track.album || '专辑未知'}</span><span>{formatDuration(track.durationSeconds)}</span>
                    <div className="row-actions"><PlaylistButton track={track} /><TrackMenuButton track={track} tracks={homeTracks.data}/></div>
                  </div>
                )
              })}
              {recentHomeRows.more && <div ref={recentHomeRows.tail} className="list-render-tail" aria-hidden="true"/>}
              {recentHomeTracks?.length === 0 && <div className="home-tracks-empty">播放过的歌曲会出现在这里</div>}
            </div>}
          </section></>}
        </RetainedStagePage>
        {showDaily && <RetainedStagePage key={`recommendation:${pageAccount}`} active={recommendationActive} swipe>
          <RecommendationView active={recommendationActive} />
        </RetainedStagePage>}
        {showBiliFeed && <RetainedStagePage key={`bili-feed:${pageAccount}`} active={biliFeedActive} swipe>
          <BilibiliFeedView active={biliFeedActive} onCollectionOpen={openCollection} onLogin={() => setActiveNav('我的')}/>
        </RetainedStagePage>}
        {!compact && <RetainedStagePage key={`hub:${pageAccount}`} active={hubActive} swipe>{hub}</RetainedStagePage>}
        <RetainedStagePage key={`music:${pageAccount}`} active={musicActive} className={isMobile ? 'library-stage-pager' : undefined}>
          <MusicLibraryView tab={libraryTab} onTabChange={setLibraryTab} fill={isMobile} active={musicActive}/>
        </RetainedStagePage>
        <RetainedStagePage key={`creators:${pageAccount}`} active={creatorsActive}>
          <CreatorsView followed onOpen={openCollection} onOpenFolder={openCreatorFolder}/>
        </RetainedStagePage>
        <div className="stage-scroll" ref={settingsScroll} hidden={!settingsActive}>
          {settingsActive && <MyView onOpenDownloads={() => { setLibraryTab('downloads'); setActiveNav('音乐库') }} onOpenExtensions={openExtensions}/>}
        </div>
        {extensionsActive && <div className="stage-scroll"><ExtensionsSettings/></div>}
        </div>
      </main>

      {queueSheet && <div className="queue-sheet-backdrop" aria-hidden="true" onClick={queueOpen ? closeQueue : undefined} />}
      <aside ref={queuePanel} id="playback-queue" role={queueSheet ? 'dialog' : undefined} aria-label="播放队列" aria-modal={queueSheet && queueOpen || undefined} className={`queue-drawer${queueSheet ? ' queue-sheet' : ''}`} aria-hidden={!queueOpen} inert={!queueOpen} onKeyDown={event => {
        if (event.key !== 'Tab' || !queueSheet || !isTopOverlay(queuePanel.current)) return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const next = event.shiftKey ? buttons.at(-1) : buttons[0]
        if (document.activeElement !== (event.shiftKey ? buttons[0] : buttons.at(-1))) return
        event.preventDefault()
        next?.focus()
      }}>
        {!isMobile && <QueueResizeHandle/>}
        {queueSheet && <button type="button" className="queue-sheet-handle" aria-label="收起播放队列" {...queueDrag}><span /></button>}
        <header>
          <div><span className="eyebrow coral">播放队列 · {queue.length}</span><h3 className="queue-heading-title">{queueSource?.kind === 'video' && queue.length > 1 ? '视频选集' : queueSource?.kind === 'season' || queueSource?.kind === 'recommendation' ? queueSource.title : '接下来'}</h3></div>
          <div className="queue-header-actions">
            {queue.length > 1 && <button type="button" className="queue-organize" aria-pressed={queueSorting}
              aria-label={queueSorting ? '完成整理' : '整理播放队列'} title={queueSorting ? '完成整理' : '整理播放队列'}
              onClick={() => setQueueSorting(value => !value)}>{queueSorting ? <Check size={16}/> : <ListFilter size={16}/>}</button>}
            <button type="button" className="queue-reverse" disabled={queueSorting || queue.length < 2} onClick={reverseQueue} aria-pressed={queueReversed}
              aria-label={queueReversed ? '恢复原序' : '倒序播放'} title={queueReversed ? '恢复原序' : '倒序播放'}><ArrowDownUp size={16}/></button>
            <button disabled={queueSorting || !queue.length} onClick={clearQueue} aria-label="清空队列"><Trash2 size={16} /></button>
            <button onClick={toggleQueue} aria-label="收起队列">{queueSheet ? <ChevronDown size={20}/> : <X size={18}/>}</button>
          </div>
        </header>
        <div className="now-card">
          <Artwork src={current?.coverUrl} className="now-art" />
          <div className="now-meta"><div><strong>{current?.title || '尚未播放'}</strong><small>{current ? trackSubtitle(current) : '选择一首歌开始'}</small></div><button className={current?.liked ? 'icon-action liked' : 'icon-action'} onClick={() => void toggleCurrentFavorite()} disabled={!current}><Heart size={19} fill={current?.liked ? 'currentColor' : 'none'} /></button></div>
        </div>
        <QueueList open={queueOpen} visible={queuePresent} sorting={queueSorting} />
      </aside>

      {renderDock()}
      {desktopLyrics && <div ref={desktopLyricsSurface} className="desktop-lyrics-surface lyrics-immersive" inert={!lyricsOpen}>
        <LyricsBackdrop cover={current?.coverUrl} className="immersive-backdrop" />
        {renderLyrics()}
        {renderDock(false, true)}
      </div>}
      {mobilePlayer.present && <div ref={mobilePlayer.ref} className="mobile-player-surface lyrics-immersive"
        inert={!lyricsOpen || queueSheet && queueOpen}>
        <LyricsBackdrop cover={current?.coverUrl} className="immersive-backdrop" />
        {renderLyrics()}
        {renderDock(true)}
      </div>}
      {(playbackError || actionError) && <div className="playback-error" role="alert">
        {playbackError ? <PlaybackErrorText issue={playbackError}/> : <span>{actionError}</span>}
        <div className="playback-issue-actions">
          {playbackError && status === 'error' && current && <button onClick={() => void toggle()}>重试</button>}
          {playbackError && <CopyPlaybackDiagnostics issue={playbackError} track={current}/>}
          <button onClick={() => { setActionError(''); usePlayerStore.setState({ error: null }) }}>关闭</button>
        </div>
      </div>}
      <SleepTimer open={sleepTimerOpen} onClose={() => setSleepTimerOpen(false)}/>
      {isMobile && immersivePresent && !compactPlayer && renderLyrics()}
      {importOpen && <ImportFavorites key={rematchPlaylist?.id||'import'} reviewPlaylist={rematchPlaylist} onImported={(id) => {
        setImportOpen(false)
        setRematchPlaylist(undefined)
        setHubSection('playlists')
        libraryReturn.current = { nav: compact ? '此刻' : '收藏库' }
        setActiveNav(`playlist:${id}`)
        scrollCollection(0)
      }} onViewCollections={() => {
        setImportOpen(false)
        resetCollection()
        libraryReturn.current = null
        setHubSection('collections')
        setActiveNav(compact ? '此刻' : '收藏库')
        scrollCollection(0)
      }} onClose={() => {setImportOpen(false);setRematchPlaylist(undefined)}} />}
      {creatingPlaylist && <div ref={createDialog} className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setCreatingPlaylist(false)}}><form className="playlist-create-dialog" role="dialog" aria-modal="true" aria-label="新建歌单" onSubmit={e=>{e.preventDefault();if(playlistName.trim())createList.mutate(playlistName)}}><header><h3>新建歌单</h3><button type="button" aria-label="关闭" onClick={()=>setCreatingPlaylist(false)}><X size={18} /></button></header><input autoFocus aria-label="歌单名称" maxLength={createLinked ? 40 : 80} value={playlistName} onChange={e=>setPlaylistName(e.target.value)} placeholder="歌单名称" /><label className="create-linked-option"><input type="checkbox" checked={createLinked} disabled={createList.isPending} onChange={event => setCreateLinked(event.target.checked)}/><span>与 B 站收藏夹同步<small>在 B 站账号下新建私密收藏夹</small></span></label>{createList.isError && <p className="inline-error">{commandErrorMessage(createList.error)}</p>}<button disabled={createList.isPending || !playlistName.trim()}>创建歌单</button></form></div>}
      <TrackActionsHost />
    </div>{miniMode&&<MiniPlayer busy={miniBusy} onRestore={(lyrics,queue)=>void changeMiniMode(false,lyrics,queue)} onFavorite={()=>void toggleCurrentFavorite()} favoritePending={favoritePending} onError={cause=>setActionError(commandErrorMessage(cause))}/>}
    {miniMode&&(actionError||playbackError)&&<div className="mini-player-error" role="alert"><span>{actionError||playbackError?.message}</span>{playbackError && !actionError && <CopyPlaybackDiagnostics issue={playbackError} track={current}/>}<button onClick={()=>{setActionError('');usePlayerStore.setState({error:null})}} aria-label="关闭提示"><X size={12}/></button></div>}</>
  )
}
