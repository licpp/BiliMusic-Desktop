import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { useVerticalDismiss } from '../../shared/useVerticalDismiss'
import { usePanelReveal } from '../../shared/usePanelReveal'
import { usePanelPresence } from '../../shared/usePanelPresence'
import { ChapterSeekRange } from '../chapters/ChapterSeekRange'
import { ChapterTrigger } from '../chapters/ChapterTrigger'
import { ChapterDirectory } from '../chapters/ChapterDirectory'
import type { PlaybackChapters } from '../chapters/usePlaybackChapters'
import { ScrollingTrackTitle } from './ScrollingTrackTitle'
import { knownArtist } from '../../domain/sourceTitle'
import { useSourceTitleMetadata } from '../player/useSourceTitleMetadata'
import { accountQueryKey } from '../../services/queryKeys'
import { chooseDownload } from '../downloads/downloadRequest'
import { storedLyricLines } from '../../domain/lyricTimeline'
import { customControlActivation } from '../../domain/shortcuts'
import { FloatingLyricsToggle } from './FloatingLyricsToggle'
import { useFloatingLyrics } from '../../services/floatingLyrics'
import { WordLyric } from './WordLyric'
import { useLyricClockIndex } from './useLyricClockIndex'
import { touchDirection, type TouchDirection } from '../../shared/touchDirection'
import { listen } from '@tauri-apps/api/event'
import { useCompactLayout, useTabletWidth } from '../../shared/useCompactLayout'
import { SleepTimerEntry } from '../player/SleepTimer'
import { SeasonBrowser } from '../collections/SeasonBrowser'
import { seasonCollection } from '../../services/mediaSources'
import type { Collection } from '../../services/collections'
import { MobilePlaybackRate, PlaybackRateEntry } from './MobilePlaybackRate'
import { PlaybackSettings } from './PlaybackSettings'
import { useBiliSubtitles } from './useBiliSubtitles'
import { isMobile, isIOS, isOHOS } from '../../services/platform'
import { controlMobileAudio } from '../player/mobileAudio'
import { formatDuration } from '../../shared/time'
import { TrackLyricsDialog } from './TrackLyricsDialog'
import { useArtworkFit } from './useArtworkFit'
import { AiSubtitleIcon } from './AiSubtitleIcon'
import { createPortal, flushSync } from 'react-dom'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { ArrowLeft, ChevronDown, Download, Gauge, Image, LoaderCircle, Maximize2, MessageCircle, Minimize2, Pencil, RefreshCw, SlidersHorizontal, TvMinimalPlay, FolderPlus, ChevronRight, ListVideo, Sparkles, Settings2, Captions, PictureInPicture2, Play, Pause } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { MetadataDialog } from '../library/MetadataDialog'
import { PlayingVideoReplacement } from '../library/PlayingVideoReplacement'
import { TouchOptions } from '../../shared/TouchOptions'
import { ActionMenu } from '../../shared/ActionMenu'
import { chooseTrackPlaylist } from '../library/trackActionStore'
import { playbackClock, playbackRates, reloadCurrentAudioSource, usePlayerStore } from '../player/playerStore'
import { commandErrorMessage, getDanmaku, getStoredLyrics, enrichStoredLyricLines, getVideoParts, setStoredLyricsBias } from '../../services/desktopApi'
import { LyricBiasConflict, lyricsWereCleared, type LyricLine, type StoredLyrics } from '../../domain/lyrics'
import { hasTimedLyrics, lyricSupplementModes, nextLyricSupplement, type LyricSupplement } from '../../domain/lrc'
import { Artwork } from '../../shared/Artwork'
import { MobilePartsPage } from '../library/MobilePartsPage'
import { CommentsPanel } from '../comments/CommentsPanel'
import { DanmakuCanvas } from './DanmakuCanvas'
import { SyncedVideo } from './SyncedVideo'
import { getDiagnosticVideoSource, videoSourceIssue, type VideoDiagnosticTrace } from './videoDiagnostics'
import { CopyPlaybackDiagnostics, PlaybackErrorText } from '../player/PlaybackError'
import type { PlaybackIssue } from '../player/playbackIssue'
import { VideoStartup } from './VideoStartup'
import { Heart } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { createBiasWriter, roundedLyricBias } from './biasWriter'
import { LyricsBiasControl } from './LyricsBiasControl'
import { useAutoLyricAlignment } from './useAutoLyricAlignment'
import { createLyricSpringController, lyricAnchorRatio, lyricInterludeState, lyricLineVisual, lyricScrollTarget } from './appleLyricMotion'

const danmakuDensityLabels = ['1/8', '1/4', '1/2', '全屏']

type Props = { duplicatePreview?: boolean; chapters: PlaybackChapters; open?: boolean; fullscreenRequested: boolean; setVideoFullscreen: (enabled: boolean) => void; inert?: boolean; motionSurface?: RefObject<HTMLElement | null>; onSwipeRelease?: (offset: number, dismissed: boolean) => void; onMiniPlayer?: () => void; onOpenSleepTimer: () => void; onClose: () => void; onFavorite: () => void; favoritePending: boolean; onOpenCollection: (item: Collection) => void }

export function LyricsView({ open = true, duplicatePreview, chapters, fullscreenRequested, setVideoFullscreen, inert = false, motionSurface, onSwipeRelease, onMiniPlayer, onOpenSleepTimer, onClose, onFavorite, favoritePending, onOpenCollection }: Props) {
  const compact = useCompactLayout()
  const tablet = useTabletWidth() && isMobile
  const dockLyrics = !isMobile || !compact || tablet
  const dockActionsId = tablet && compact ? 'lyrics-tablet-dock-actions' : 'lyrics-dock-actions'
  const panel = useRef<HTMLElement>(null)
  usePanelReveal(panel, isMobile ? open : undefined)
  const closeDrag = useVerticalDismiss(motionSurface ?? panel, open && isMobile, onClose, { settle: onSwipeRelease })
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLButtonElement>('.lyrics-close')?.focus({ preventScroll: true })
  }, [open])
  const [dockActions, setDockActions] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setDockActions(document.getElementById(dockActionsId))
  }, [dockActionsId, open])
  const queryClient = useQueryClient()
  const status = usePlayerStore(state => state.status)
  const duration = usePlayerStore(state => state.durationSeconds)
  const floatingError = useFloatingLyrics(state => state.error)

  const [seasonOpen,setSeasonOpen] = useState(false)
  const [editing, setEditing] = useState<Track | null>(null)
  const [replacingVideo, setReplacingVideo] = useState<Track | null>(null)
  const current = usePlayerStore((state) => state.current)
  const bvid = current?.source.provider === 'bilibili' ? current.source.bvid : ''
  const videoDetail = useSourceTitleMetadata(current)
  const season = videoDetail?.season || current?.sourceTitleContext?.season
  const coverUrl = current?.coverUrl || videoDetail?.coverUrl
  const [partsOpen, setPartsOpen] = useState(false)
  const progressSeconds = usePlayerStore((state) => state.progressSeconds)
  const [stored, setStored] = useState<StoredLyrics | null>(null)
  const [lines, setLines] = useState<LyricLine[]>([])
  const [supplementPreference, setSupplementPreference] = useState<LyricSupplement>(() => {
    const saved = localStorage.getItem('lyrics-supplement')
    return saved === 'translation' || saved === 'romanization' ? saved : 'off'
  })
  const [chooserOpen, setChooserOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const subtitles = useBiliSubtitles()
  const [error, setError] = useState('')
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [mediaPreference, setMediaPreference] = useState<'cover' | 'video'>(() => localStorage.getItem('lyrics-media-mode') === 'video' ? 'video' : 'cover')
  const [videoFailed, setVideoFailed] = useState(false)
  const [videoIssue, setVideoIssue] = useState<{ trackId: string; issue: PlaybackIssue }>()
  const mediaMode = current?.source.provider === 'bilibili' && !videoFailed ? mediaPreference : 'cover'
  const artworkFit = useArtworkFit(coverUrl, mediaMode === 'cover', compact)
  const [videoSource, setVideoSource] = useState<{ trackId: string; url: string; codecs: string; revision: number; diagnostic: VideoDiagnosticTrace } | null>(null)
  const videoUrl = videoSource?.trackId === current?.id ? videoSource?.url || '' : ''
  const [readyVideoUrl, setReadyVideoUrl] = useState('')
  const videoCover = useRef<HTMLDivElement>(null)
  const mediaFade = useRef<Animation | undefined>(undefined)
  useLayoutEffect(() => () => {
    mediaFade.current?.cancel()
    mediaFade.current = undefined
  }, [current?.id, open])
  const [controlsShown, setControlsShown] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [videoSettingsOpen, setVideoSettingsOpen] = useState(false)
  const [videoSeeking, setVideoSeeking] = useState(false)
  const [controlsTouched, setControlsTouched] = useState(0)
  const revealControls = useCallback(() => { setControlsShown(true); setControlsTouched(Date.now()) }, [])
  useEffect(() => {
    if (!controlsShown || status !== 'playing' || videoSettingsOpen || rateOpen || videoSeeking || chapters.directoryOpen) return
    const timer = window.setTimeout(() => setControlsShown(false), 3000)
    return () => window.clearTimeout(timer)
  }, [controlsShown, controlsTouched, status, videoSettingsOpen, rateOpen, videoSeeking, chapters.directoryOpen])
  const videoFullscreen = open && mediaMode === 'video' && fullscreenRequested
  const swipeCover = isMobile && mediaMode === 'cover' && !videoFullscreen
  const coverDrag = useVerticalDismiss<HTMLDivElement>(motionSurface ?? panel, swipeCover && open, onClose, { settle: onSwipeRelease })
  useLayoutEffect(() => {
    if (!isMobile || !videoFullscreen) return
    const root = document.documentElement
    root.dataset.videoFullscreen = 'true'
    void controlMobileAudio('videoFullscreen', 1).catch(() => undefined)
    return () => {
      delete root.dataset.videoFullscreen
      void controlMobileAudio('videoFullscreen', 0).catch(() => undefined)
    }
  }, [videoFullscreen])
  useEffect(() => {
    if (!open || mediaMode !== 'video') setVideoFullscreen(false)
  }, [open, mediaMode, setVideoFullscreen])
  const [danmakuVisible, setDanmakuVisible] = useState(() => localStorage.getItem('danmakuVisible') !== 'false')
  const [danmakuSize, setDanmakuSize] = useState(() => Number(localStorage.getItem('danmakuSize') || 1))
  const [danmakuOpacity, setDanmakuOpacity] = useState(() => Number(localStorage.getItem('danmakuOpacity') || .8))
  const [danmakuDensity, setDanmakuDensity] = useState(() => {
    const value = Number(localStorage.getItem('danmakuDensity') ?? 3)
    return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 3
  })
  const [commentsOpen, setCommentsOpen] = useState(false)
  const commentsPresent = usePanelPresence(commentsOpen && open, 220)
  const chaptersOpen = open && chapters.directoryOpen
  const desktopChaptersPresent = usePanelPresence(!isMobile && chaptersOpen, 200)
  const closeComments = useCallback(() => setCommentsOpen(false), [])
  const openComments = useCallback(() => setCommentsOpen(true), [])
  const toggleDockComments = (trigger: HTMLButtonElement) => {
    if (commentsOpen) { closeComments(); return }
    if (!isMobile && chapters.directoryOpen) {
      trigger.focus({ preventScroll: true })
      chapters.close()
    }
    openComments()
  }
  const toggleDesktopChapters = (trigger: HTMLElement) => {
    if (!chapters.directoryOpen) closeComments()
    chapters.toggle(trigger)
  }
  const [biasOpen, setBiasOpen] = useState(false)
  const [browsingLyrics, setBrowsingLyrics] = useState(false)
  const [browseIndex, setBrowseIndex] = useState(-1)
  const lyricTouch = useRef<{ x: number; y: number; direction: TouchDirection } | null>(null)
  const lyricDragged = useRef(false)
  const [foregroundRevision, setForegroundRevision] = useState(0)
  const instantCenter = useRef(false)
  const seekCenter = useRef(false)
  useEffect(() => {
    const resume = () => {
      instantCenter.current = true
      if (Date.now() - browseActivity.current > 6000) setBrowsingLyrics(false)
      setForegroundRevision(value => value + 1)
    }
    window.addEventListener('bilimusic-playback-reconciled', resume)
    return () => window.removeEventListener('bilimusic-playback-reconciled', resume)
  }, [])
  const browseActivity = useRef(0)
  const springRef = useRef<ReturnType<typeof createLyricSpringController> | null>(null)
  if (!springRef.current) springRef.current = createLyricSpringController()
  const prevActiveRef = useRef(-1)
  const anchorRatio = lyricAnchorRatio(compact)
  const anchorRatioRef = useRef(anchorRatio)
  anchorRatioRef.current = anchorRatio
  useEffect(() => {
    if (!open) springRef.current?.stop()
  }, [open])
  useEffect(() => () => { springRef.current?.stop() }, [])
  const browseLyrics = () => { springRef.current?.releaseForUserScroll(); browseActivity.current = Date.now(); setBrowsingLyrics(true); updateBrowseLine() }
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const [biasActivity, setBiasActivity] = useState(0)
  const storedRef = useRef(stored)
  storedRef.current = stored
  const mounted = useRef(false)
  const [biasSaveError, setBiasSaveError] = useState(false)
  const applyBiasConflict = (latest: StoredLyrics | null) => {
    const previous = storedRef.current
    storedRef.current = latest
    setStored(latest)
    if (latest?.writeToken !== previous?.writeToken || latest?.parsedJson !== previous?.parsedJson) {
      setLines(latest ? storedLyricLines(latest) : [])
    }
    if (latest) window.dispatchEvent(new CustomEvent('bilimusic-lyric-bias', { detail: latest }))
  }
  const [biasWriter] = useState(() => {
    return createBiasWriter((expected, value) => setStoredLyricsBias(expected.trackId, value, expected), (expected, _, error) => {
      const current = storedRef.current
      setBiasSaveError(Boolean(error) && !(error instanceof LyricBiasConflict))
      if (error instanceof LyricBiasConflict) {
        applyBiasConflict(error.lyrics)
      } else if (error && current) {
        const restored = { ...current, biasMs: expected.biasMs }
        storedRef.current = restored
        setStored(restored)
        window.dispatchEvent(new CustomEvent('bilimusic-lyric-bias', { detail: restored }))
      }
    })
  })
  useEffect(() => {
    mounted.current = true
    const flush = () => { void biasWriter.flush() }
    const hidden = () => { if (document.hidden) flush() }
    const cancel = () => biasWriter.cancel()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('bilimusic-account-changing', cancel)
    return () => {
      mounted.current = false; flush()
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('bilimusic-account-changing', cancel)
    }
  }, [biasWriter])
  useEffect(() => () => { void biasWriter.flush() }, [current?.id, biasWriter])
  useOverlayDismiss(panel, open && (biasOpen || videoFullscreen), () => {
    if (biasOpen) { setBiasOpen(false); void biasWriter.flush() }
    else setVideoFullscreen(false)
  })
  useEffect(() => {
    if (open) return
    setVideoFullscreen(false)
    void biasWriter.flush()
  }, [open, biasWriter])
  const lyricRequest = useRef(0)
  const videoRequest = useRef(0)
  const [videoRetry, setVideoRetry] = useState(0)
  useEffect(() => {
    const subscription = listen('media-proxy-restarted', () => {
      setVideoSource(null); setReadyVideoUrl(''); setVideoRetry(value => value + 1)
    }).catch(() => undefined)
    return () => { void subscription.then(stop => stop?.()) }
  }, [])

  useEffect(() => {
    const update = (event: Event) => {
      const lyrics = (event as CustomEvent<StoredLyrics>).detail
      if (lyrics.trackId !== current?.id) return
      ++lyricRequest.current
      storedRef.current = lyrics
      setStored(lyrics); setLines(storedLyricLines(lyrics)); setLoading(false); setError('')
    }
    window.addEventListener('bilimusic-lyrics-updated', update)
    return () => window.removeEventListener('bilimusic-lyrics-updated', update)
  }, [current?.id])

  useEffect(() => {
    let cancelled = false
    const request = ++lyricRequest.current
    instantCenter.current = true
    setStored(null); setBiasSaveError(false); setLines([]); setError('')
    if (!current) return () => { cancelled = true }
    const load = async () => {
      setLoading(true)
      try {
        const existing = await getStoredLyrics(current.id)
        if (cancelled || request !== lyricRequest.current) return
        if (existing) {
          setStored(existing)
          setLines(storedLyricLines(existing))
          return
        }
      } catch (cause) {
        if (!cancelled && request === lyricRequest.current) setError(commandErrorMessage(cause))
      } finally {
        if (!cancelled && request === lyricRequest.current) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true; ++lyricRequest.current }
  }, [current?.id])

  useEffect(() => {
    if (!stored || stored.trackId !== current?.id || !stored.rawText || lines.some(line => line.translation || line.romanization)) return
    let cancelled = false
    void enrichStoredLyricLines(stored).then(enriched => {
      if (!cancelled && storedRef.current?.writeToken === stored.writeToken && enriched?.some(line => line.translation || line.romanization)) setLines(enriched)
    }).catch(() => undefined) // Supplement failure must not hide existing lyrics.
    return () => { cancelled = true }
  }, [stored?.trackId, stored?.provider, stored?.providerLyricId, stored?.rawText, current?.id])

  useEffect(() => {
    setSeasonOpen(false); setPartsOpen(false); setControlsShown(false); setVideoFullscreen(false); setCommentsOpen(false); setChooserOpen(false); setEditing(null); setBiasOpen(false)
    setVideoFailed(false); setVideoIssue(undefined)
  }, [current?.id])

  useEffect(() => {
    const request = ++videoRequest.current, epoch = accountEpoch()
    if (!open || !current || current.source.provider !== 'bilibili' || current.source.cid <= 0 || mediaPreference !== 'video') return
    const existing = videoSource?.trackId === current.id ? videoSource : undefined
    if (existing?.revision === videoRetry) return
    void getDiagnosticVideoSource(current.source.bvid, current.source.cid).then(source => {
      if (request !== videoRequest.current || epoch !== accountEpoch()) return
      setVideoIssue(undefined)
      setVideoSource({ trackId: current.id, url: source.videoUrl, codecs: source.codecs, revision: videoRetry, diagnostic: source.diagnostic })
    }).catch(cause => {
      if (request !== videoRequest.current || epoch !== accountEpoch()) return
      if (!existing) setVideoFailed(true)
      setVideoIssue({ trackId: current.id, issue: videoSourceIssue(cause) })
    })
    return () => { ++videoRequest.current }
  }, [open, current?.id, mediaPreference, videoRetry])

  const reloadVideo = useCallback(async (compatible: boolean) => {
    if (!current) return
    const request = ++videoRequest.current, epoch = accountEpoch()
    const source = await getDiagnosticVideoSource(current.source.bvid, current.source.cid, true, compatible, videoSource?.trackId === current.id ? videoSource.diagnostic : undefined)
    if (request !== videoRequest.current || epoch !== accountEpoch()) return
    setReadyVideoUrl('')
    setVideoSource({ trackId: current.id, url: source.videoUrl, codecs: source.codecs, revision: videoRetry, diagnostic: source.diagnostic })
  }, [current?.id, videoRetry, videoSource?.diagnostic])

  const videoReady = Boolean(videoUrl && readyVideoUrl === videoUrl)
  useEffect(() => {
    if (isMobile && mediaMode === 'video' && videoReady) revealControls()
  }, [mediaMode, videoReady, videoFullscreen, revealControls])
  const mobileFullscreen = isMobile && videoFullscreen
  const controlsHidden = isMobile && videoReady && (mobileFullscreen || status === 'playing') && !controlsShown && !videoSettingsOpen && !rateOpen
  const toggleVideoControls = () => {
    if (!mobileFullscreen) { revealControls(); return }
    setControlsShown(shown => !shown)
    setControlsTouched(Date.now())
  }
  const cid = current?.source.cid || 0
  const danmaku = useQuery({
    queryKey: ['video-danmaku', cid],
    queryFn: () => getDanmaku(cid),
    enabled: Boolean(bvid && cid && mediaMode === 'video' && videoReady && danmakuVisible),
    staleTime: 5 * 60_000,
    gcTime: 60_000,
    retry: false,
  })

  const showVideo = () => {
    if (!current || current.source.provider !== 'bilibili') return
    const next = mediaMode === 'video' ? 'cover' : 'video'
    const apply = () => {
      setVideoFailed(false); setVideoIssue(undefined); setError(''); setVideoFullscreen(false)
      // Retry without changing the remembered preference.
      if (next === 'video' && mediaPreference === 'video') setVideoRetry(value => value + 1)
      else setMediaPreference(next)
      localStorage.setItem('lyrics-media-mode', next)
    }
    const frame = videoCover.current
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const opacity = frame ? getComputedStyle(frame).opacity : '1'
    mediaFade.current?.cancel()
    if (!frame?.animate || motion.matches || videoFullscreen) {
      apply()
      return
    }
    // Change the frame's size between the two fades so neither image stretches.
    const exiting = frame.animate([{ opacity }, { opacity: 0 }], { duration: 90, easing: 'ease-out', fill: 'forwards' })
    mediaFade.current = exiting
    void exiting.finished.then(() => {
      if (mediaFade.current !== exiting || !frame.isConnected) return
      flushSync(apply)
      exiting.cancel()
      mediaFade.current = motion.matches ? undefined :
        videoCover.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 175, easing: 'ease-out' })
    }, () => {})
  }
  const changeVideoQuality = () => {
    setVideoFailed(false)
    setError('')
    setVideoRetry(value => value + 1)
  }
  const toggleSubtitles = () => {
    subtitles.toggle()
    setBiasOpen(false)
  }
  const toggleDanmaku = () => setDanmakuVisible(value => {
    localStorage.setItem('danmakuVisible', String(!value))
    return !value
  })

  const syncedLyrics = useMemo(() => hasTimedLyrics(stored?.rawText), [stored?.rawText])
  const autoAlignment = useAutoLyricAlignment({ track: current, stored, lines, enabled: biasOpen && syncedLyrics && !subtitles.lines,
    onConflict: latest => { if (storedRef.current === stored) applyBiasConflict(latest) },
    beforeAlign: () => biasWriter.flush(), onAligned: saved => {
      storedRef.current = saved; setStored(saved); setBiasSaveError(false); setBiasActivity(Date.now())
    },
  })
  useEffect(() => {
    if (!biasOpen || autoAlignment.busy) return
    const timer = window.setTimeout(() => setBiasOpen(false), 20000)
    return () => window.clearTimeout(timer)
  }, [biasOpen, biasActivity, autoAlignment.busy])
  const displayLines = subtitles.lines ?? lines
  const supplementModes = useMemo(() => lyricSupplementModes(lines), [lines])
  const supplementMode = !subtitles.lines && supplementModes.includes(supplementPreference) ? supplementPreference : 'off'
  const cycleSupplement = () => {
    const next = nextLyricSupplement(supplementMode, supplementModes)
    setSupplementPreference(next); localStorage.setItem('lyrics-supplement', next)
  }
  const timingPreview = !subtitles.lines && biasOpen && syncedLyrics
  const clickableLyrics = !timingPreview && (syncedLyrics || Boolean(subtitles.lines))
  const biasMs = subtitles.lines ? 0 : stored?.biasMs || 0
  const lyricTimeMs = progressSeconds * 1_000 - biasMs
  const lyricClock = useCallback(() => playbackClock() * 1000 - biasMs, [biasMs])
  const liveClock = open && (syncedLyrics || subtitles.lines) && status === 'playing' ? lyricClock : undefined
  const clockIndex = useLyricClockIndex(displayLines, lyricTimeMs, liveClock)
  // Hold the highlighted line through gaps until the next line starts.
  const activeIndex = subtitles.lines || syncedLyrics ? clockIndex : -1
  const interlude = useMemo(() => {
    if (!clickableLyrics || browsingLyrics) return null
    return lyricInterludeState(displayLines, lyricTimeMs)
  }, [clickableLyrics, browsingLyrics, displayLines, lyricTimeMs])

  useLayoutEffect(() => {
    setBrowsingLyrics(false); setBrowseIndex(-1); prevActiveRef.current = -1
    instantCenter.current = true
    seekCenter.current = false
    lineRefs.current.length = displayLines.length
    springRef.current?.stop()
  }, [current?.id, displayLines])
  useEffect(() => {
    if (!browsingLyrics) return
    const timer = window.setInterval(() => { if (Date.now() - browseActivity.current > 6000) setBrowsingLyrics(false) }, 500)
    return () => window.clearInterval(timer)
  }, [browsingLyrics])
  const updateBrowseLine = () => {
    if (!scrollRef.current) return
    browseActivity.current = Date.now()
    const scroll = scrollRef.current, anchor = scroll.getBoundingClientRect().top + scroll.clientHeight * anchorRatioRef.current
    let closest = -1, distance = Infinity
    lineRefs.current.forEach((line, index) => { if (!line) return; const rect = line.getBoundingClientRect(), delta = Math.abs(rect.top + rect.height / 2 - anchor); if (delta < distance) { distance = delta; closest = index } })
    setBrowseIndex(closest)
  }
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const syncSpacers = () => {
      // Size spacers to the actual lyric viewport, not the complete window.
      // Oversized vh padding can scroll the outer page and hide its toolbar.
      const ratio = anchorRatioRef.current
      const topPad = `${Math.max(0, Math.floor(scroll.clientHeight * ratio) - 1)}px`
      const bottomPad = `${Math.max(0, Math.floor(scroll.clientHeight * (1 - ratio)) - 1)}px`
      // Content spacers must not become the viewport's minimum box height when
      // resizing between desktop and phone layouts.
      scroll.style.setProperty('--lyric-spacer', topPad)
      scroll.style.setProperty('--lyric-spacer-top', topPad)
      scroll.style.setProperty('--lyric-spacer-bottom', bottomPad)
      const active = scroll.querySelector<HTMLParagraphElement>('p.active')
      if (active && !scroll.matches('.lyrics-timing-preview:hover')) {
        const target = lyricScrollTarget(active.offsetTop, active.offsetHeight, scroll.clientHeight, ratio)
        springRef.current?.animate(scroll, target, lineRefs.current, -1, -1, true)
      }
    }
    const observer = new ResizeObserver(syncSpacers)
    observer.observe(scroll, { box: 'border-box' })
    syncSpacers()
    return () => observer.disconnect()
  }, [current?.id, anchorRatio])
  useLayoutEffect(() => {
    if (!open || browsingLyrics || timingPreview && hoveredLine !== null) return
    const scroll = scrollRef.current
    if (!scroll) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const seekChangedLine = seekCenter.current && activeIndex !== prevActiveRef.current
    const instant = instantCenter.current || seekChangedLine || biasOpen || reduced
    if (seekChangedLine) seekCenter.current = false
    const line = lineRefs.current[activeIndex]
    if (line) {
      const target = lyricScrollTarget(line.offsetTop, line.offsetHeight, scroll.clientHeight, anchorRatio)
      const currentTime = displayLines[activeIndex].timeMs
      const previousTime = displayLines[activeIndex - 1]?.timeMs ?? -Infinity
      const nextTime = displayLines[activeIndex + 1]?.timeMs ?? Infinity
      const intervalMs = Math.min(currentTime - previousTime, nextTime - currentTime) / usePlayerStore.getState().rate
      springRef.current?.animate(scroll, target, lineRefs.current, activeIndex, prevActiveRef.current, instant, intervalMs)
      prevActiveRef.current = activeIndex
      instantCenter.current = false
    } else if (activeIndex < 0 && displayLines.length > 0 && (instant || prevActiveRef.current >= 0)) {
      springRef.current?.animate(scroll, 0, lineRefs.current, -1, -1, true)
      prevActiveRef.current = -1
      instantCenter.current = false
    }
  }, [open, activeIndex, browsingLyrics, timingPreview, hoveredLine === null, biasMs, displayLines, supplementMode, foregroundRevision, anchorRatio, biasOpen])

  function adjustBias(delta: number) {
    const lyrics = storedRef.current
    if (!current || !lyrics || lyrics.trackId !== current.id || autoAlignment.busy) return
    const epoch = accountEpoch(), playback = usePlayerStore.getState().current
    const next = { ...lyrics, biasMs: roundedLyricBias(lyrics.biasMs + delta) }
    storedRef.current = next
    window.dispatchEvent(new CustomEvent('bilimusic-lyric-bias',{detail:next}))
    setStored(next); setBiasSaveError(false); setError(''); setBiasActivity(Date.now())
    biasWriter.set(lyrics, next.biasMs, () => mounted.current && epoch === accountEpoch()
      && playback === usePlayerStore.getState().current && storedRef.current === next)
  }

  function alignLine(timeMs: number) {
    if (!biasOpen || !storedRef.current) return
    const target = playbackClock() * 1000 - timeMs
    adjustBias(roundedLyricBias(target) - storedRef.current.biasMs)
  }

  const seekLine = (index: number) => {
    const line = displayLines[index]
    if (!line) return
    if (index !== activeIndex) seekCenter.current = true
    usePlayerStore.getState().seek(Math.max(0, (line.timeMs + (subtitles.lines ? 0 : biasMs)) / 1000))
    if (usePlayerStore.getState().status === 'paused') void usePlayerStore.getState().toggle()
    setBrowsingLyrics(false)
  }

  if (!current) return <section ref={panel} className="lyrics-view" inert={!open || inert}><button type="button" className="lyrics-close" {...closeDrag} aria-label={duplicatePreview ? "返回查重" : "收起歌词"}><ChevronDown /></button><div className="lyrics-empty"><h2>尚未播放</h2><p>选择歌曲后，这里会显示歌词。</p></div></section>

  const subtitleLabel = subtitles.lines && !subtitles.choice?.ai ? 'B 站字幕' : 'AI 字幕'
  const supplementControl = !subtitles.lines && supplementModes.length > 1 && <button type="button" className="lyrics-supplement-toggle" data-enabled={supplementMode !== 'off' || undefined}
    title={`附加歌词：${supplementMode === 'romanization' ? '音译' : supplementMode === 'translation' ? '翻译' : '关闭'}，点击切换`}
    aria-label={`附加歌词：${supplementMode === 'romanization' ? '音译' : supplementMode === 'translation' ? '翻译' : '关闭'}，点击切换`}
    onClick={cycleSupplement}><span aria-hidden="true">{supplementMode === 'romanization' ? '音' : supplementMode === 'translation' ? '译' : '原'}</span></button>
  const videoSettings = <>
    <PlaybackSettings track={current} kind="video" onChanged={changeVideoQuality}/>
    <div className="danmaku-settings">
      {danmaku.error && danmakuVisible && <p className="inline-error">弹幕加载失败 <button type="button" onClick={() => void danmaku.refetch()}>重试</button></p>}
      <strong className="danmaku-settings-heading">弹幕</strong>
      <label>密度 <output>{danmakuDensityLabels[danmakuDensity]}</output>
        <input aria-label="弹幕密度" aria-valuetext={danmakuDensityLabels[danmakuDensity]} type="range" min="0" max="3" step="1" value={danmakuDensity}
          style={{ '--range-fill': `${danmakuDensity / 3 * 100}%` } as CSSProperties}
          onChange={event => {
          const value = Number(event.target.value)
          setDanmakuDensity(value)
          localStorage.setItem('danmakuDensity', String(value))
        }}/>
        <span className="danmaku-density-ticks" aria-hidden="true">{danmakuDensityLabels.map(label => <span key={label}>{label}</span>)}</span>
      </label>
      <label>字号 <output>{danmakuSize.toFixed(1)}×</output><input aria-label="弹幕字号" type="range" min="0.6" max="1.6" step="0.1" value={danmakuSize} style={{ '--range-fill': `${(danmakuSize - 0.6) / 1.0 * 100}%` } as CSSProperties} onChange={event => { const value = Number(event.target.value); setDanmakuSize(value); localStorage.setItem('danmakuSize', String(value)) }}/></label>
      <label>透明度 <output>{Math.round(danmakuOpacity * 100)}%</output><input aria-label="弹幕透明度" type="range" min="0.2" max="1" step="0.1" value={danmakuOpacity} style={{ '--range-fill': `${(danmakuOpacity - 0.2) / 0.8 * 100}%` } as CSSProperties} onChange={event => { const value = Number(event.target.value); setDanmakuOpacity(value); localStorage.setItem('danmakuOpacity', String(value)) }}/></label>
    </div>
  </>
  const danmakuToggle = <button type="button" className="video-danmaku-toggle" onClick={toggleDanmaku} aria-label={danmakuVisible ? '关闭弹幕' : '显示弹幕'} aria-pressed={danmakuVisible}><span>弹</span>{!danmakuVisible && <i/>}</button>
  const videoMenu = <ActionMenu label="视频设置" icon={<Settings2 size={18}/>} panel floating={mobileFullscreen} onOpenChange={setVideoSettingsOpen}>
    {close => <>{mobileFullscreen && <PlaybackRateEntry onOpen={() => { close(); revealControls(); setRateOpen(true) }}/>}{videoSettings}</>}
  </ActionMenu>
  const videoTools = mobileFullscreen ? <div className="video-fullscreen-toolbar" data-controls-hidden={controlsHidden || undefined} onPointerDown={revealControls}>
    <button type="button" className="video-fullscreen-back" aria-label="退出全屏" onClick={() => setVideoFullscreen(false)}><ArrowLeft size={22}/></button>
    {videoMenu}
  </div> : <div className={`video-tools${mediaMode === 'video' ? ' video-tools-overlay' : ''}`} data-controls-hidden={mediaMode === 'video' && controlsHidden || undefined} onPointerDown={revealControls}>
    {current.source.provider === 'bilibili' && <button className="video-mode-toggle" aria-label={mediaMode === 'video' ? '显示封面' : '播放视频'} title={mediaMode === 'video' ? '显示封面' : '播放视频'} aria-pressed={mediaMode === 'video'} onClick={() => void showVideo()}>{mediaMode === 'video' ? <Image size={18} /> : <TvMinimalPlay size={18} />}</button>}
    {mediaMode === 'video' && <>
      {danmakuToggle}
      <button onClick={() => setVideoFullscreen(!videoFullscreen)} aria-label="切换视频全屏">{videoFullscreen ? <Minimize2 /> : <Maximize2 />}</button>
      {videoMenu}
    </>}
  </div>

  return (
    <section ref={panel} className="lyrics-view" inert={!open || inert}>
      {dockLyrics && dockActions && createPortal(<>
        {supplementControl}
        {!isIOS && !isOHOS && <FloatingLyricsToggle/>}
        {(!isMobile || tablet) && <ChapterTrigger model={isMobile ? chapters : { ...chapters, toggle: toggleDesktopChapters }}/>}
        <button type="button" className="lyrics-dock-comments" aria-label={commentsOpen?'收起评论':'查看评论'} title="评论" aria-pressed={commentsOpen} onClick={event => toggleDockComments(event.currentTarget)} disabled={!current.source.aid}><MessageCircle size={18}/></button>
        {bvid&&<button type="button" className="lyrics-dock-ai" aria-label={subtitles.active?'关闭 AI / B站字幕':'开启 AI / B站字幕'} title={`${subtitleLabel} · ${subtitles.active?'已开启':subtitles.preferred?'歌词优先':'已关闭'}`} aria-pressed={subtitles.active} aria-busy={subtitles.busy} onClick={toggleSubtitles}><AiSubtitleIcon active={subtitles.active} busy={subtitles.busy} manual={subtitleLabel==='B 站字幕'}/></button>}
      </>,dockActions)}
      <header className="lyrics-topbar" data-duplicate-preview={duplicatePreview || undefined}>
        <button type="button" className="lyrics-close" {...closeDrag} aria-label={duplicatePreview ? "返回查重" : "收起歌词"} title={duplicatePreview ? "返回查重" : "收起歌词"}><ChevronDown /></button>
        <span>{duplicatePreview ? "查重试听" : "正在播放"}</span>
        <div className="lyrics-actions">
          {isMobile && !dockLyrics && !isIOS && !isOHOS && !videoFullscreen && <FloatingLyricsToggle/>}
          {!isMobile&&onMiniPlayer&&<button type="button" aria-label="迷你播放器" title="迷你播放器 · 置顶悬浮" onClick={onMiniPlayer}><PictureInPicture2 size={19}/></button>}
          {!(isMobile && videoFullscreen) && <ActionMenu label={compact ? "播放设置" : "歌词页面更多操作"} panel panelClassName={compact ? "mobile-playback-settings" : undefined} touchSheet={compact}>{(close) => <>
            {current.importedEntry?.trackId === current.id && <button type="button" role="menuitem" onClick={() => { close(); setReplacingVideo(current) }}><RefreshCw size={18}/><span>更换视频</span></button>}
            {compact && <>
              <PlaybackRateEntry onOpen={() => { close(); setRateOpen(true) }}/>
              <PlaybackSettings track={current} kind="audio" onChanged={reloadCurrentAudioSource}/>
            </>}
            <SleepTimerEntry onOpen={() => { close(); onOpenSleepTimer() }}/>
            {compact && isMobile && !dockLyrics && bvid && <button className="lyrics-subtitle-menu-item" type="button" role="switch" aria-checked={subtitles.active} onClick={toggleSubtitles}>
              <AiSubtitleIcon active={subtitles.active} busy={subtitles.busy} manual={subtitleLabel==='B 站字幕'}/><span>{subtitleLabel}</span>{subtitles.preferred && !subtitles.active && <small>歌词优先</small>}<span className="playback-setting-switch" aria-hidden="true" data-enabled={subtitles.active}><i/></span>
            </button>}
            {subtitles.active && subtitles.choices.length > 1 && <TouchOptions icon={<Captions size={18}/>} label="字幕版本" selected={subtitles.choice?.language ?? ''}
              options={subtitles.choices.map(choice => ({ value: choice.language, label: `${choice.label || choice.language}${compact ? '' : ` · ${choice.ai ? 'AI' : 'B 站'}`}` }))}
              onChange={value => { subtitles.select(value); if (!compact) close() }}/>}
            {compact && <div className="touch-sheet-section">歌曲与歌词</div>}
            <div className={compact ? 'lyrics-song-actions lyrics-song-actions-grid' : 'lyrics-song-actions'}>
            {current.source.provider === 'bilibili' && <button role={isMobile ? undefined : 'menuitem'} type="button" onClick={() => { close(); chooseDownload([current]) }}><Download size={16}/>下载歌曲</button>}
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); setEditing(current); setChooserOpen(false); setCommentsOpen(false) }}><Pencil size={16} />编辑歌曲信息</button>
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); chooseTrackPlaylist([current]) }}><FolderPlus size={16} />加入歌单…</button>
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); setChooserOpen(true) }}><RefreshCw size={16} />{stored && !lyricsWereCleared(stored) ? '更换歌词' : '匹配歌词'}</button>
            <button role={isMobile ? undefined : "menuitem"} disabled={Boolean(subtitles.lines)} onClick={() => { close(); setHoveredLine(null); setBiasOpen(true); setBiasActivity(Date.now()) }}><SlidersHorizontal size={16} />调整歌词时间</button>
            {(isMobile || (videoDetail && videoDetail.parts.length > 1)) && <button role={isMobile ? undefined : "menuitem"} disabled={!videoDetail || videoDetail.parts.length <= 1} onClick={() => {
              if (!videoDetail || videoDetail.parts.length <= 1) return
              close()
              if (isMobile) setPartsOpen(true)
              else onOpenCollection({ ...videoDetail, folderId: '' })
            }}><ListVideo size={16}/>查看分 P</button>}
            </div>
            {!compact && <><PlaybackRateControl/>
              <PlaybackSettings track={current} kind="audio" onChanged={reloadCurrentAudioSource}/></>}
          </>}</ActionMenu>}
        </div>
      </header>
      <div className={videoFullscreen ? 'lyrics-album-pane video-fullscreen' : 'lyrics-album-pane'}>
        <div className="lyrics-media" ref={artworkFit.stage}>
        <div ref={videoCover} style={artworkFit.style} className={mediaMode === 'video' ? 'lyrics-cover video-active' : 'lyrics-cover'} data-swipe-cover={swipeCover || undefined} data-media-mode={mediaMode} {...(swipeCover ? coverDrag : {})} onClick={undefined}>{videoUrl && <SyncedVideo key={current?.id} onReload={reloadVideo} src={videoUrl} poster={coverUrl} track={current} codecs={videoSource?.codecs} diagnostic={videoSource?.diagnostic} active={mediaMode === 'video'} suspended={!open} onReady={setReadyVideoUrl} />}{mediaMode === 'video' ? <>{!videoUrl && <VideoStartup key={current.id} poster={coverUrl} message={open ? "正在解析视频线路…" : undefined}/>}{open && danmakuVisible && videoReady && danmaku.data && danmaku.data.length > 0 && <DanmakuCanvas items={danmaku.data} scale={danmakuSize} opacity={danmakuOpacity} density={2 ** (danmakuDensity - 3)} />}</> : <Artwork src={coverUrl} adaptAspect variant="progressive" onAspectRatio={artworkFit.onRatio} />}{isMobile && mediaMode === 'video' && videoReady && <button type="button" className="video-reveal-controls" aria-label={mobileFullscreen && !controlsHidden ? '隐藏视频控件' : '显示视频控件'} onClick={toggleVideoControls}/>}</div>
        {videoTools}
        {mobileFullscreen && <div className="video-fullscreen-transport" data-controls-hidden={controlsHidden || undefined} onPointerDown={revealControls}>
          <button aria-label={status === 'playing' ? '暂停' : '播放'} onClick={() => void usePlayerStore.getState().toggle()}>{status === 'playing' ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button>
          <span>{formatDuration(progressSeconds, duration >= 3600)}</span><ChapterSeekRange aria-label="视频播放进度" duration={duration} trackKey={current.id} chapters={chapters.items} value={Math.min(progressSeconds, duration)} onPreview={seconds => { setVideoSeeking(seconds !== undefined); if (seconds !== undefined) revealControls() }} onSeek={seconds => { revealControls(); usePlayerStore.getState().seek(seconds) }}/>{chapters.items.length ? <ChapterTrigger model={chapters} variant="time"/> : <span>{formatDuration(duration)}</span>}{danmakuToggle}
        </div>}
        </div>
        <div className="lyrics-track-meta">
          <div className="lyrics-meta-heading">
          <span className="eyebrow coral">NOW PLAYING</span>
          <ScrollingTrackTitle text={current.title} enabled={isMobile}/>
          </div>
          <div className="lyrics-meta-copy">
          <div className="lyrics-record-meta">
          {knownArtist(current) && <p title={knownArtist(current)}>{knownArtist(current)}</p>}
          {current.album && current.album !== season?.title && <small title={current.album}>{current.album}</small>}
          </div>
          <div className="lyrics-source-meta">
          {current.source.uploaderName && <button type="button" className="lyrics-uploader" title={current.source.uploaderName} aria-label={`查看 UP 主：${current.source.uploaderName}`} disabled={!current.source.uploaderId} onClick={() => onOpenCollection({bvid:`up:${current.source.uploaderId}`,folderId:'',title:current.source.uploaderName || '',coverUrl:'',uploaderName:current.source.uploaderName || ''})}><span className="lyrics-uploader-badge" aria-hidden="true">UP</span><span className="lyrics-uploader-name">{current.source.uploaderName}</span></button>}
          {current.source.uploaderName && season && <span className="lyrics-source-divider" aria-hidden="true"/>}
          {season && <button className="lyrics-season-link" title={season.title} onClick={() => {
            if (isMobile) setSeasonOpen(true)
            else onOpenCollection(seasonCollection(season))
          }}>
            <ListVideo size={14}/><span>{season.title || '查看合集'}</span><ChevronRight size={13}/>
          </button>}
          </div>
          </div>
          {compact && <div className="lyrics-meta-actions">
            <button className={current.liked ? 'liked' : ''} aria-label={current.liked ? '取消喜欢' : '喜欢这首歌'} aria-pressed={Boolean(current.liked)} aria-busy={favoritePending} onClick={onFavorite}><Heart size={20} fill={current.liked ? 'currentColor' : 'none'} /></button>
            {isMobile && !dockLyrics && supplementControl}
            {current.source.provider === 'bilibili' && <button aria-label={mediaMode === 'video' ? '显示封面' : '播放视频'} aria-pressed={mediaMode === 'video'} onClick={() => void showVideo()}>{mediaMode === 'video' ? <Image size={20}/> : <TvMinimalPlay size={20}/>}</button>}
            {!dockLyrics && <button aria-label="查看评论" disabled={!current.source.aid} onClick={openComments}><MessageCircle size={20}/></button>}
          </div>}
        </div>
      </div>
      <div ref={scrollRef} onWheel={browseLyrics} onPointerDown={event => { lyricDragged.current = false; lyricTouch.current = { x: event.clientX, y: event.clientY, direction: 'pending' } }} onPointerMove={event => { const touch = lyricTouch.current; if (!touch) return; touch.direction = touchDirection(event.clientX, event.clientY, touch.x, touch.y, touch.direction); if (touch.direction === 'vertical') { lyricDragged.current = true; browseLyrics() } }} onPointerUp={() => { lyricTouch.current = null }} onPointerCancel={() => { lyricDragged.current = true; lyricTouch.current = null }} onScroll={open && browsingLyrics ? updateBrowseLine : undefined} onPointerLeave={() => setHoveredLine(null)} className={`lyrics-scroll${timingPreview ? ' lyrics-timing-preview' : ''}`} data-browsing={browsingLyrics || undefined} aria-live="polite">
        {loading && !displayLines.length ? <div className="lyrics-status"><LoaderCircle className="spin" />正在读取歌词</div> : displayLines.length ? displayLines.map((line, index) => {
          const visual = lyricLineVisual(index, activeIndex, browsingLyrics || timingPreview)
          const nearActive = activeIndex >= 0 && Math.abs(index - activeIndex) <= 6
          const showInterlude = interlude && interlude.beforeIndex === index && index > activeIndex
          const active = index === activeIndex
          return <Fragment key={`${line.timeMs}-${index}`}>
            {showInterlude && <div className="lyric-interlude" data-exiting={interlude.exiting || undefined} aria-hidden="true">
              {interlude.dots.map((level, dotIdx) => <span key={dotIdx} className="lyric-interlude-dot" style={{ '--dot-fill': String(level) } as CSSProperties} />)}
            </div>}
            <p ref={(node) => { lineRefs.current[index] = node }} style={{ '--lyric-blur': `${visual.blurPx}px`, '--lyric-opacity': String(visual.opacity) } as CSSProperties} data-lyric-near={nearActive || undefined} data-lyric-clickable={clickableLyrics || undefined} className={`${index === activeIndex ? 'active' : index < activeIndex ? 'past' : ''}${timingPreview && hoveredLine === index ? ' timing-target' : ''}${browsingLyrics && clickableLyrics && browseIndex === index ? ' browse-target' : ''}`} onPointerEnter={timingPreview ? event => { if (event.pointerType === 'mouse') setHoveredLine(index) } : undefined} role={timingPreview || clickableLyrics ? 'button' : undefined} tabIndex={timingPreview || clickableLyrics ? 0 : undefined} title={timingPreview ? '将这一句对齐到现在' : undefined} onClick={timingPreview ? () => alignLine(line.timeMs) : clickableLyrics ? () => { if (lyricDragged.current) { lyricDragged.current = false; return } seekLine(index) } : undefined} onKeyDown={timingPreview ? event => { if (customControlActivation(event)) { event.preventDefault(); alignLine(line.timeMs) } } : clickableLyrics ? event => { if (customControlActivation(event)) { event.preventDefault(); seekLine(index) } } : undefined}>
              <span className="lyric-line-body">
                <span className="lyric-original">
                  <WordLyric line={line} active={active} timeMs={active ? liveClock?.() ?? lyricTimeMs : 0}
                    clock={active ? liveClock : undefined} stableLayout/>
                </span>
                {supplementMode !== 'off' && line[supplementMode] && <span className="lyric-secondary">{line[supplementMode]}</span>}
              </span>
              {browsingLyrics && clickableLyrics && browseIndex === index && <button type="button" className="lyric-seek-button" aria-label={`从这句播放：${line.text}`} title="从这句播放" onClick={event => { event.stopPropagation(); seekLine(index) }}><Play size={17} fill="currentColor" aria-hidden="true" /></button>}
            </p>
          </Fragment>
        }) : <div className="lyrics-status"><span>{error || '还没有歌词，手动搜索并选择一个版本吧'}</span><button className="load-more" onClick={() => setChooserOpen(true)}>匹配或导入歌词</button></div>}
      </div>
      {(isMobile ? chaptersOpen : desktopChaptersPresent) && <ChapterDirectory model={chapters} mobile={isMobile} open={chaptersOpen} fullscreen={videoFullscreen}/>}
      {biasOpen && !subtitles.lines && <LyricsBiasControl value={stored?.biasMs || 0} enabled={syncedLyrics} error={biasSaveError}
        onAutoAlign={() => void autoAlignment.run()} autoBusy={autoAlignment.busy} onAdjust={adjustBias} onClose={() => { setBiasOpen(false); void biasWriter.flush() }} onActivity={() => setBiasActivity(Date.now())} />}

      {videoIssue?.trackId === current.id && <div className="lyrics-toast playback-issue-toast" role="alert">
        <PlaybackErrorText issue={videoIssue.issue}/><div className="playback-issue-actions">
          <button type="button" onClick={() => { setVideoFailed(false); setVideoIssue(undefined); setVideoRetry(value => value + 1) }}>重试</button>
          <CopyPlaybackDiagnostics issue={videoIssue.issue} track={current}/>
          <button type="button" onClick={() => setVideoIssue(undefined)}>关闭</button>
        </div>
      </div>}
      {!videoIssue && (floatingError || subtitles.message || autoAlignment.message || (error && displayLines.length > 0)) && <div className={`lyrics-toast${autoAlignment.message && !floatingError && !subtitles.message ? ' lyrics-alignment-toast' : ''}`} role={floatingError || autoAlignment.failed ? 'alert' : 'status'}>{floatingError || subtitles.message || autoAlignment.message || error}{floatingError && <button type="button" onClick={() => useFloatingLyrics.setState({error:''})}>知道了</button>}</div>}
      {open && chooserOpen && <TrackLyricsDialog key={current.id} track={current} stored={stored} onClose={() => setChooserOpen(false)}
        onSaved={() => { if (subtitles.active) subtitles.toggle() }}/>}
      {open && rateOpen && <MobilePlaybackRate onClose={() => setRateOpen(false)}/>}
      {open && seasonOpen && season && <SeasonBrowser locateCurrent summary={season} onClose={() => setSeasonOpen(false)}/>}
      {open && partsOpen && videoDetail && <MobilePartsPage locateCurrent detail={videoDetail} onBack={() => setPartsOpen(false)}/>}
      {commentsPresent && current.source.aid && <CommentsPanel open={commentsOpen && open} key={current.id} trackId={current.id} aid={current.source.aid} onClose={closeComments} chapters={chapters.canImport ? {
        durationSeconds: chapters.duration, existingChapters: chapters.existingChapters, isCurrent: chapters.isCurrent, onSave: chapters.save,
      } : undefined} video={mediaMode === 'video' ? videoCover.current : null} />}
      {open && editing && <MetadataDialog track={editing} onClose={() => setEditing(null)} onSaved={(updated) => { usePlayerStore.getState().updateTrack(updated); setEditing(null); void queryClient.invalidateQueries({ queryKey: accountQueryKey('library') }); void queryClient.invalidateQueries({ queryKey: accountQueryKey('home-recent') }) }} />}
      {open && replacingVideo && <PlayingVideoReplacement track={replacingVideo} onClose={() => setReplacingVideo(null)}/>}
    </section>
  )
}

function PlaybackRateControl() {
  const rate = usePlayerStore(state => state.rate)
  const setRate = usePlayerStore(state => state.setRate)
  return <div className="playback-rate-control">
    <TouchOptions icon={<Gauge size={17}/>} label="播放倍速" selected={String(rate)}
      options={playbackRates.map(value => ({ value: String(value), label: `${value}×` }))}
      onChange={value => void setRate(Number(value))} layout="grid" />
  </div>
}
