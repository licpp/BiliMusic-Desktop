import { chooseDownload } from '../downloads/downloadRequest'
import { storedLyricLines, lyricAt } from './lyricTimeline'
import { FloatingLyricsToggle } from './FloatingLyricsToggle'
import { useFloatingLyrics } from '../../services/floatingLyrics'
import { WordLyric } from './WordLyric'
import { touchDirection, type TouchDirection } from '../../shared/touchDirection'
import { listen } from '@tauri-apps/api/event'
import { useCompactLayout } from '../../shared/useCompactLayout'
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
import { LyricsChooser } from './LyricsChooser'
import { rankLyricCandidates } from '../../services/musicMatchRanking'
import { automaticLyricQuery } from './lyricQuery'
import { useArtworkFit } from './useArtworkFit'
import { AiSubtitleIcon } from './AiSubtitleIcon'
import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Download, Image, LoaderCircle, Maximize2, MessageCircle, Minimize2, Pencil, RefreshCw, SlidersHorizontal, TvMinimalPlay, FolderPlus, ChevronRight, ListVideo, Sparkles, Settings2, Captions, PictureInPicture2, Play } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { MetadataDialog } from '../library/LibraryView'
import { TouchOptions } from '../../shared/TouchOptions'
import { ActionMenu } from '../../shared/ActionMenu'
import { chooseTrackPlaylist } from '../library/trackActionStore'
import { playbackClock, playbackRates, reloadCurrentAudioSource, usePlayerStore } from '../player/playerStore'
import {
  commandErrorMessage,
  getDanmaku,
  getVideoSource,
  getStoredLyrics,
  enrichStoredLyricLines,
  getVideoParts,
  saveStoredLyrics,
  searchLyrics,
  setStoredLyricsBias,
  type LyricCandidate,
  type LyricLine,
  type StoredLyrics,
} from '../../services/desktopApi'
import { candidateLines, lyricSupplementModes, nextLyricSupplement, parseLrc, type LyricSupplement } from './lrc'
import { Artwork } from '../../shared/Artwork'
import { MobilePartsPage } from '../library/MobilePartsPage'
import { CommentsPanel } from '../comments/CommentsPanel'
import { DanmakuCanvas } from './DanmakuCanvas'
import { SyncedVideo } from './SyncedVideo'
import { Heart } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { createBiasWriter, clampBias } from './biasWriter'
import { LyricsBiasControl } from './LyricsBiasControl'

const danmakuDensityLabels = ['1/8', '1/4', '1/2', '全屏']

type Props = { onMiniPlayer?: () => void; onOpenSleepTimer: () => void; onClose: () => void; onFavorite: () => void; favoritePending: boolean; onOpenCollection: (item: Collection) => void }

export function LyricsView({ onMiniPlayer, onOpenSleepTimer, onClose, onFavorite, favoritePending, onOpenCollection }: Props) {
  const compact = useCompactLayout()
  const [dockActions, setDockActions] = useState<HTMLElement|null>(()=>document.getElementById('lyrics-dock-actions'))
  useEffect(()=>{setDockActions(document.getElementById('lyrics-dock-actions'))},[])
  const queryClient = useQueryClient()
  const status = usePlayerStore(state => state.status)
  const duration = usePlayerStore(state => state.durationSeconds)
  const floatingError = useFloatingLyrics(state => state.error)

  const [seasonOpen,setSeasonOpen] = useState(false)
  const [editing, setEditing] = useState<Track | null>(null)
  const current = usePlayerStore((state) => state.current)
  const bvid = current?.source.provider === 'bilibili' ? current.source.bvid : ''
  const videoDetail = useQuery({
    queryKey: ['video-detail', accountEpoch(), bvid],
    queryFn: () => getVideoParts(bvid),
    enabled: Boolean(bvid),
    staleTime: 5 * 60_000,
    retry: false,
  }).data
  const season = videoDetail?.season
  const legacyFrame = videoDetail?.parts.find(part => part.cid === current?.source.cid)?.firstFrameUrl
  const coverUrl = legacyFrame && current?.coverUrl === legacyFrame ? videoDetail?.coverUrl || legacyFrame : current?.coverUrl || videoDetail?.coverUrl
  const [partsOpen, setPartsOpen] = useState(false)
  const progressSeconds = usePlayerStore((state) => state.progressSeconds)
  const [stored, setStored] = useState<StoredLyrics | null>(null)
  const [lines, setLines] = useState<LyricLine[]>([])
  const [supplementPreference, setSupplementPreference] = useState<LyricSupplement>(() => {
    const saved = localStorage.getItem('lyrics-supplement')
    return saved === 'translation' || saved === 'romanization' ? saved : 'off'
  })
  const [candidates, setCandidates] = useState<LyricCandidate[]>([])
  const [chooserOpen, setChooserOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const subtitles = useBiliSubtitles()
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualText, setManualText] = useState('')
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [mediaPreference, setMediaPreference] = useState<'cover' | 'video'>(() => localStorage.getItem('lyrics-media-mode') === 'video' ? 'video' : 'cover')
  const [videoFailed, setVideoFailed] = useState(false)
  const mediaMode = current?.source.provider === 'bilibili' && !videoFailed ? mediaPreference : 'cover'
  const artworkFit = useArtworkFit(coverUrl, mediaMode === 'cover', compact)
  const [videoSource, setVideoSource] = useState<{ trackId: string; url: string; revision: number } | null>(null)
  const videoUrl = videoSource?.trackId === current?.id ? videoSource?.url || '' : ''
  const [readyVideoUrl, setReadyVideoUrl] = useState('')
  const videoCover = useRef<HTMLDivElement>(null)
  const [controlsShown, setControlsShown] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [videoSettingsOpen, setVideoSettingsOpen] = useState(false)
  const [controlsTouched, setControlsTouched] = useState(0)
  const revealControls = useCallback(() => { setControlsShown(true); setControlsTouched(Date.now()) }, [])
  useEffect(() => {
    if (!controlsShown || status !== 'playing' || videoSettingsOpen || rateOpen) return
    const timer = window.setTimeout(() => setControlsShown(false), 3000)
    return () => window.clearTimeout(timer)
  }, [controlsShown, controlsTouched, status, videoSettingsOpen, rateOpen])
  const [videoFullscreen, setVideoFullscreen] = useState(false)
  useEffect(() => {
    if (!isMobile) return
    if (videoFullscreen) document.documentElement.dataset.videoFullscreen = 'true'
    else delete document.documentElement.dataset.videoFullscreen
    void controlMobileAudio('videoFullscreen', videoFullscreen ? 1 : 0).catch(() => undefined)
  }, [videoFullscreen])
  useEffect(() => () => {
    if (!isMobile) return
    delete document.documentElement.dataset.videoFullscreen
    void controlMobileAudio('videoFullscreen', 0).catch(() => undefined)
  }, [])
  const [danmakuVisible, setDanmakuVisible] = useState(() => localStorage.getItem('danmakuVisible') !== 'false')
  const [danmakuSize, setDanmakuSize] = useState(() => Number(localStorage.getItem('danmakuSize') || 1))
  const [danmakuOpacity, setDanmakuOpacity] = useState(() => Number(localStorage.getItem('danmakuOpacity') || .8))
  const [danmakuDensity, setDanmakuDensity] = useState(() => {
    const value = Number(localStorage.getItem('danmakuDensity') ?? 3)
    return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 3
  })
  const [commentsOpen, setCommentsOpen] = useState(false)
  const closeComments = useCallback(() => setCommentsOpen(false), [])
  const openComments = useCallback(() => setCommentsOpen(true), [])
  const [biasOpen, setBiasOpen] = useState(false)
  const [browsingLyrics, setBrowsingLyrics] = useState(false)
  const [browseIndex, setBrowseIndex] = useState(-1)
  const lyricTouch = useRef<{ x: number; y: number; direction: TouchDirection } | null>(null)
  const [foregroundRevision, setForegroundRevision] = useState(0)
  const instantCenter = useRef(false)
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
  const browseLyrics = () => { browseActivity.current = Date.now(); setBrowsingLyrics(true); updateBrowseLine() }
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const [biasActivity, setBiasActivity] = useState(0)
  const storedRef = useRef(stored)
  storedRef.current = stored
  const mounted = useRef(false)
  const [biasSaveError, setBiasSaveError] = useState(false)
  const biasScope = useRef(accountEpoch())
  const [biasWriter] = useState(() => {
    return createBiasWriter(async (id, value) => {
      if (accountEpoch() !== biasScope.current) return
      await setStoredLyricsBias(id, value)
    }, (id, value, error) => {
      if (mounted.current && storedRef.current?.trackId === id && storedRef.current.biasMs === value) setBiasSaveError(Boolean(error))
    })
  })
  useEffect(() => {
    mounted.current = true
    const flush = () => { void biasWriter.flush() }
    const hidden = () => { if (document.hidden) flush() }
    const cancel = () => { biasWriter.cancel(); biasScope.current = accountEpoch() }
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
  useEffect(() => {
    if (!biasOpen) return
    const timer = window.setTimeout(() => setBiasOpen(false), 20000)
    return () => window.clearTimeout(timer)
  }, [biasOpen, biasActivity])
  useEffect(() => {
    const back = (event: Event) => {
      if (event.defaultPrevented || document.querySelector('[data-overflow-panel], .mobile-comments')) return
      if (biasOpen) { event.preventDefault(); setBiasOpen(false); return }
      if (chooserOpen || editing || rateOpen) return // The shared dialog handler closes these first.
      if (commentsOpen) { event.preventDefault(); setCommentsOpen(false) }
      else if (videoFullscreen) { event.preventDefault(); setVideoFullscreen(false) }
    }
    window.addEventListener('bilimusic-back', back, true)
    return () => window.removeEventListener('bilimusic-back', back, true)
  }, [chooserOpen, editing, rateOpen, commentsOpen, videoFullscreen, biasOpen])
  const lyricRequest = useRef(0)
  const videoRequest = useRef(0)
  const [videoRetry, setVideoRetry] = useState(0)
  useEffect(() => {
    const subscription = listen('media-proxy-restarted', () => {
      setVideoSource(null); setReadyVideoUrl(''); setVideoRetry(value => value + 1)
    }).catch(() => undefined)
    return () => { void subscription.then(stop => stop?.()) }
  }, [])
  const [lyricQuery, setLyricQuery] = useState(current ? automaticLyricQuery(current).title : '')
  const [lyricArtist, setLyricArtist] = useState(current ? automaticLyricQuery(current).artist : '')
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    const update = (event: Event) => {
      const lyrics = (event as CustomEvent<StoredLyrics>).detail
      if (lyrics.trackId !== current?.id) return
      setStored(lyrics); setLines(storedLyricLines(lyrics)); setError(''); setWarning('')
    }
    window.addEventListener('bilimusic-lyrics-updated', update)
    return () => window.removeEventListener('bilimusic-lyrics-updated', update)
  }, [current?.id])

  useEffect(() => {
    let cancelled = false
    const request = ++lyricRequest.current
    setStored(null); setBiasSaveError(false); setLines([]); setCandidates([]); setError(''); setWarning(''); setManualOpen(false); setManualText(''); setSearched(false)
    if (!current) return () => { cancelled = true }
    const load = async () => {
      setLoading(true)
      try {
        const existing = await getStoredLyrics(current.id)
        if (cancelled || request !== lyricRequest.current) return
        if (existing) {
          setStored(existing)
          setLines(storedLyricLines(existing))
          if (!existing.rawText) setWarning(existing.provider === 'local' ? '本地导入的歌词正文未上传，请在这台设备重新导入。时间偏移已保留。' : '歌词选择和时间偏移已同步，歌词服务暂未返回正文，可稍后重试匹配。')
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
      if (!cancelled && enriched?.some(line => line.translation || line.romanization)) setLines(enriched)
    }).catch(() => undefined) // Supplement failure must not hide existing lyrics.
    return () => { cancelled = true }
  }, [stored?.trackId, stored?.provider, stored?.providerLyricId, stored?.rawText, current?.id])

  useEffect(() => {
    setSeasonOpen(false); setPartsOpen(false); setControlsShown(false); setVideoFullscreen(false); setCommentsOpen(false); setChooserOpen(false); setEditing(null); setBiasOpen(false)
    setVideoFailed(false); setLyricQuery(current ? automaticLyricQuery(current).title : ''); setLyricArtist(current ? automaticLyricQuery(current).artist : '')
  }, [current?.id])

  useEffect(() => {
    const request = ++videoRequest.current
    if (!current || current.source.provider !== 'bilibili' || current.source.cid <= 0 || mediaPreference !== 'video') return
    const existing = videoSource?.trackId === current.id ? videoSource : undefined
    if (existing?.revision === videoRetry) return
    const pending = getVideoSource(current.source.bvid, current.source.cid).then(source => source.videoUrl)
    void pending.then(url => {
      if (request !== videoRequest.current) return
      setVideoSource({ trackId: current.id, url, revision: videoRetry })
    }).catch(cause => {
      if (request !== videoRequest.current) return
      if (!existing) setVideoFailed(true)
      setError(`视频加载失败：${commandErrorMessage(cause)}`)
    })
    return () => { ++videoRequest.current }
  }, [current?.id, mediaPreference, videoRetry])

  const videoReady = Boolean(videoUrl && readyVideoUrl === videoUrl)
  useEffect(() => {
    if (isMobile && mediaMode === 'video' && videoReady) revealControls()
  }, [mediaMode, videoReady, videoFullscreen, revealControls])
  const controlsHidden = isMobile && videoReady && status === 'playing' && !controlsShown && !videoSettingsOpen && !rateOpen
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
    setVideoFailed(false); setError(''); setVideoFullscreen(false)
    // Retry without changing the remembered preference.
    if (next === 'video' && mediaPreference === 'video') {
      setVideoRetry(value => value + 1)
    } else setMediaPreference(next)
    localStorage.setItem('lyrics-media-mode', next)
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

  const syncedLyrics = useMemo(() => Boolean(stored && parseLrc(stored.rawText).length), [stored?.rawText])
  const displayLines = subtitles.lines ?? lines
  const supplementModes = useMemo(() => lyricSupplementModes(lines), [lines])
  const supplementMode = !subtitles.lines && supplementModes.includes(supplementPreference) ? supplementPreference : 'off'
  const cycleSupplement = () => {
    const next = nextLyricSupplement(supplementMode, supplementModes)
    setSupplementPreference(next); localStorage.setItem('lyrics-supplement', next)
  }
  const timingPreview = !subtitles.lines && biasOpen && syncedLyrics
  const biasMs = subtitles.lines ? 0 : stored?.biasMs || 0
  const lyricClock = useCallback(() => playbackClock() * 1000 - biasMs, [biasMs])
  const activeIndex = useMemo(() => {
    if (!subtitles.lines && !syncedLyrics) return -1
    const currentMs = progressSeconds * 1_000 - biasMs
    return lyricAt(displayLines, currentMs, !subtitles.lines)
  }, [displayLines, progressSeconds, biasMs, syncedLyrics, subtitles.lines])

  useEffect(() => { setBrowsingLyrics(false); setBrowseIndex(-1) }, [current?.id, displayLines])
  useEffect(() => {
    if (!browsingLyrics) return
    const timer = window.setInterval(() => { if (Date.now() - browseActivity.current > 6000) setBrowsingLyrics(false) }, 500)
    return () => window.clearInterval(timer)
  }, [browsingLyrics])
  const updateBrowseLine = () => {
    if (!scrollRef.current) return
    browseActivity.current = Date.now()
    const scroll = scrollRef.current, middle = scroll.getBoundingClientRect().top + scroll.clientHeight / 2
    let closest = -1, distance = Infinity
    lineRefs.current.forEach((line, index) => { if (!line) return; const rect = line.getBoundingClientRect(), delta = Math.abs(rect.top + rect.height / 2 - middle); if (delta < distance) { distance = delta; closest = index } })
    setBrowseIndex(closest)
  }
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const observer = new ResizeObserver(() => {
      // Size spacers to the actual lyric viewport, not the complete window.
      // Oversized vh padding can scroll the outer page and hide its toolbar.
      const padding = `${Math.max(0, Math.floor(scroll.clientHeight / 2) - 1)}px`
      // Content spacers must not become the viewport's minimum box height when
      // resizing between desktop and phone layouts.
      scroll.style.setProperty('--lyric-spacer', padding)
      const active = scroll.querySelector<HTMLParagraphElement>('p.active')
      if (active && !scroll.matches('.lyrics-timing-preview:hover')) centerLyric(scroll, active, 'auto')
    })
    observer.observe(scroll, { box: 'border-box' })
    return () => observer.disconnect()
  }, [current?.id])
  useEffect(() => {
    if (browsingLyrics || timingPreview && hoveredLine !== null) return
    const line = lineRefs.current[activeIndex]
    if (scrollRef.current && line) {
      centerLyric(scrollRef.current, line, instantCenter.current || biasOpen || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
      instantCenter.current = false
    }
  }, [activeIndex, browsingLyrics, timingPreview, hoveredLine === null, biasMs, displayLines, supplementMode, foregroundRevision])

  async function refreshCandidates() {
    if (!current) return
    const request = ++lyricRequest.current
    setLoading(true); setError(''); setWarning(''); setSearched(true)
    try { const results = await searchLyrics(lyricQuery.trim(), lyricArtist.trim() || undefined, true); if (request === lyricRequest.current) { setCandidates(rankLyricCandidates(results.candidates,lyricQuery,lyricArtist,current.durationSeconds)); setWarning(results.warning || '') } }
    catch (cause) { if (request === lyricRequest.current) setError(commandErrorMessage(cause)) }
    finally { if (request === lyricRequest.current) setLoading(false) }
  }

  useEffect(() => {
    if (chooserOpen && isMobile && lyricQuery.trim()) void refreshCandidates()
  }, [chooserOpen])

  async function importManualLyrics() {
    if (!current || !manualText.trim()) return
    const request = ++lyricRequest.current
    setLoading(false)
    const synced = parseLrc(manualText).length > 0
    await selectCandidate({ provider: 'local', id: 0, trackName: current.title, artistName: current.artist || '', albumName: current.album || '', duration: current.durationSeconds, instrumental: false, syncedLyrics: synced ? manualText.trim() : undefined, plainLyrics: synced ? undefined : manualText.trim() }, true, request)
  }

  async function selectCandidate(candidate: LyricCandidate, manual: boolean, request = lyricRequest.current) {
    if (!current) return
    const parsed = candidateLines(candidate)
    if (!parsed.length) { setError('这个版本没有可显示的歌词'); return }
    try {
      const saved = await saveStoredLyrics(current.id, candidate, parsed, manual)
      if (request !== lyricRequest.current) return
      setStored(saved); setLines(parsed); setChooserOpen(false); setError('')
    } catch (cause) { if (request === lyricRequest.current) setError(commandErrorMessage(cause)) }
  }

  function adjustBias(delta: number) {
    const lyrics = storedRef.current
    if (!current || !lyrics || lyrics.trackId !== current.id) return
    const next = { ...lyrics, biasMs: clampBias(lyrics.biasMs + delta) }
    storedRef.current = next
    window.dispatchEvent(new CustomEvent('bilimusic-lyric-bias',{detail:next}))
    setStored(next); setBiasSaveError(false); setError(''); setBiasActivity(Date.now())
    biasWriter.set(current.id, next.biasMs)
  }

  function alignLine(timeMs: number) {
    if (!biasOpen || !storedRef.current) return
    const target = progressSeconds * 1000 - timeMs
    if (Math.abs(target) > 30_000) { setError('这句距离当前播放超过 30 秒，请选择附近的歌词对齐'); return }
    adjustBias(clampBias(target) - storedRef.current.biasMs)
  }

  const seekLine = (index: number) => {
    const line = displayLines[index]
    if (!line) return
    usePlayerStore.getState().seek(Math.max(0, (line.timeMs + (subtitles.lines ? 0 : biasMs)) / 1000))
    if (usePlayerStore.getState().status === 'paused') void usePlayerStore.getState().toggle()
    setBrowsingLyrics(false)
  }

  if (!current) return <section className="lyrics-view"><button className="lyrics-close" onClick={onClose}><ChevronDown /></button><div className="lyrics-empty"><h2>尚未播放</h2><p>选择歌曲后，这里会显示歌词。</p></div></section>

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
        <input aria-label="弹幕密度" aria-valuetext={danmakuDensityLabels[danmakuDensity]} type="range" min="0" max="3" step="1" value={danmakuDensity} onChange={event => {
          const value = Number(event.target.value)
          setDanmakuDensity(value)
          localStorage.setItem('danmakuDensity', String(value))
        }}/>
        <span className="danmaku-density-ticks" aria-hidden="true">{danmakuDensityLabels.map(label => <span key={label}>{label}</span>)}</span>
      </label>
      <label>字号 <output>{danmakuSize.toFixed(1)}×</output><input aria-label="弹幕字号" type="range" min="0.6" max="1.6" step="0.1" value={danmakuSize} onChange={event => { const value = Number(event.target.value); setDanmakuSize(value); localStorage.setItem('danmakuSize', String(value)) }}/></label>
      <label>透明度 <output>{Math.round(danmakuOpacity * 100)}%</output><input aria-label="弹幕透明度" type="range" min="0.2" max="1" step="0.1" value={danmakuOpacity} onChange={event => { const value = Number(event.target.value); setDanmakuOpacity(value); localStorage.setItem('danmakuOpacity', String(value)) }}/></label>
    </div>
  </>

  return (
    <section className="lyrics-view">
      {(!isMobile||!compact)&&dockActions&&createPortal(<>
        {!isMobile && supplementControl}
        {!isMobile && <FloatingLyricsToggle/>}
        <button type="button" className="lyrics-dock-comments" aria-label={commentsOpen?'收起评论':'查看评论'} title="评论" aria-pressed={commentsOpen} onClick={()=>setCommentsOpen(value=>!value)} disabled={!current.source.aid}><MessageCircle size={18}/></button>
        {bvid&&<button type="button" className="lyrics-dock-ai" aria-label={subtitles.active?'关闭 AI / B站字幕':'开启 AI / B站字幕'} title={`${subtitleLabel} · ${subtitles.active?'已开启':subtitles.preferred?'歌词优先':'已关闭'}`} aria-pressed={subtitles.active} aria-busy={subtitles.busy} onClick={toggleSubtitles}><AiSubtitleIcon active={subtitles.active} busy={subtitles.busy} manual={subtitleLabel==='B 站字幕'}/></button>}
      </>,dockActions)}
      <header className="lyrics-topbar">
        <button className="lyrics-close" onClick={onClose} aria-label="收起歌词"><ChevronDown /></button>
        <span>正在播放</span>
        <div className="lyrics-actions">
          {isMobile && !isIOS && !isOHOS && !videoFullscreen && <FloatingLyricsToggle/>}
          {!isMobile&&onMiniPlayer&&<button type="button" aria-label="迷你播放器" title="迷你播放器 · 置顶悬浮" onClick={onMiniPlayer}><PictureInPicture2 size={19}/></button>}
          {isMobile && !compact && supplementControl}
          {!(isMobile && videoFullscreen) && <ActionMenu label={compact ? "播放设置" : "歌词页面更多操作"} panel panelClassName={compact ? "mobile-playback-settings" : undefined} touchSheet={compact}>{(close) => <>
            {compact && <>
              <PlaybackRateEntry onOpen={() => { close(); setRateOpen(true) }}/>
              {isMobile && <SleepTimerEntry onOpen={() => { close(); onOpenSleepTimer() }}/>}
              <PlaybackSettings track={current} kind="audio" onChanged={reloadCurrentAudioSource}/>
            </>}
            {compact && isMobile && bvid && <button className="lyrics-subtitle-menu-item" type="button" role="switch" aria-checked={subtitles.active} onClick={toggleSubtitles}>
              <AiSubtitleIcon active={subtitles.active} busy={subtitles.busy} manual={subtitleLabel==='B 站字幕'}/><span>{subtitleLabel}</span>{subtitles.preferred && !subtitles.active && <small>歌词优先</small>}<span className="playback-setting-switch" aria-hidden="true" data-enabled={subtitles.active}><i/></span>
            </button>}
            {subtitles.active && subtitles.choices.length > 1 && (compact ? <TouchOptions icon={<Captions size={18}/>} label="字幕版本" selected={subtitles.choice?.language ?? ''}
              options={subtitles.choices.map(choice => ({ value: choice.language, label: choice.label || choice.language }))}
              onChange={subtitles.select}/> : <label className="lyrics-subtitle-language">
              字幕版本
              <select aria-label="字幕版本" value={subtitles.choice?.language} onChange={event => { subtitles.select(event.target.value); close() }}>
                {subtitles.choices.map(choice => <option key={choice.language} value={choice.language}>{choice.label || choice.language} · {choice.ai ? 'AI' : 'B 站'}</option>)}
              </select>
            </label>)}
            {compact && <div className="touch-sheet-section">歌曲与歌词</div>}
            <div className={compact ? 'lyrics-song-actions lyrics-song-actions-grid' : 'lyrics-song-actions'}>
            {current.source.provider === 'bilibili' && <button role={isMobile ? undefined : 'menuitem'} type="button" onClick={() => { close(); chooseDownload([current]) }}><Download size={16}/>下载歌曲</button>}
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); setEditing(current); setChooserOpen(false); setCommentsOpen(false) }}><Pencil size={16} />编辑歌曲信息</button>
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); chooseTrackPlaylist([current]) }}><FolderPlus size={16} />加入歌单…</button>
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); setChooserOpen(true) }}><RefreshCw size={16} />{stored ? '更换歌词' : '匹配歌词'}</button>
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
        <div ref={videoCover} style={artworkFit.style} className={mediaMode === 'video' ? 'lyrics-cover video-active' : 'lyrics-cover'}>{videoUrl && <SyncedVideo src={videoUrl} poster={coverUrl} active={mediaMode === 'video'} onReady={setReadyVideoUrl} />}{mediaMode === 'video' ? <>{!videoUrl && <div className="video-startup"><Artwork src={coverUrl} /><div className="video-startup-status"><LoaderCircle size={16} className="spin" />正在解析视频线路…</div></div>}{danmakuVisible && videoReady && danmaku.data && danmaku.data.length > 0 && <DanmakuCanvas items={danmaku.data} scale={danmakuSize} opacity={danmakuOpacity} density={2 ** (danmakuDensity - 3)} />}</> : <Artwork src={coverUrl} adaptAspect onAspectRatio={artworkFit.onRatio} />}{isMobile && mediaMode === 'video' && videoReady && <button type="button" className="video-reveal-controls" aria-label="显示视频控件" onClick={revealControls}/>}</div>
        <div className={`video-tools${mediaMode === 'video' ? ' video-tools-overlay' : ''}`} data-controls-hidden={mediaMode === 'video' && controlsHidden || undefined} onPointerDown={revealControls}>
          {current.source.provider === 'bilibili' && <button className="video-mode-toggle" aria-label={mediaMode === 'video' ? '显示封面' : '播放视频'} title={mediaMode === 'video' ? '显示封面' : '播放视频'} aria-pressed={mediaMode === 'video'} onClick={() => void showVideo()}>{mediaMode === 'video' ? <Image size={18} /> : <TvMinimalPlay size={18} />}</button>}
          {mediaMode === 'video' && <>
            <button className="video-danmaku-toggle" onClick={toggleDanmaku} aria-label={danmakuVisible ? '关闭弹幕' : '显示弹幕'} aria-pressed={danmakuVisible}><span>弹</span>{!danmakuVisible && <i/>}</button>
            <button onClick={() => setVideoFullscreen((value) => !value)} aria-label="切换视频全屏">{videoFullscreen ? <Minimize2 /> : <Maximize2 />}</button>
            <ActionMenu label="视频设置" icon={<Settings2 size={18}/>} panel floating={isMobile && videoFullscreen} onOpenChange={setVideoSettingsOpen}>
              {close => <>{isMobile && videoFullscreen && <PlaybackRateEntry onOpen={() => { close(); setRateOpen(true) }}/>}{videoSettings}</>}
            </ActionMenu>
          </>}
        </div>
        {videoFullscreen && isMobile && <div className="video-fullscreen-transport" data-controls-hidden={controlsHidden || undefined} onPointerDown={revealControls}>
          <button aria-label={status === 'playing' ? '暂停' : '播放'} onClick={() => void usePlayerStore.getState().toggle()}>{status === 'playing' ? 'Ⅱ' : '▶'}</button>
          <span>{formatDuration(progressSeconds)}</span><input aria-label="视频播放进度" type="range" min={0} max={Math.max(1, duration)} step={0.1} value={Math.min(progressSeconds, Math.max(1, duration))} onChange={event => { revealControls(); usePlayerStore.getState().seek(Number(event.target.value)) }}/><span>{formatDuration(duration)}</span>
        </div>}
        </div>
        <div className="lyrics-track-meta">
          <div className="lyrics-meta-copy">
          <span className="eyebrow coral">NOW PLAYING</span>
          <h1>{current.title}</h1>
          <p>{current.artist || '歌手未知'}</p>
          {current.album && <small>{current.album}</small>}
          {current.source.uploaderName && <button type="button" className="lyrics-uploader" disabled={!current.source.uploaderId} onClick={() => onOpenCollection({bvid:`up:${current.source.uploaderId}`,folderId:'',title:current.source.uploaderName || '',coverUrl:'',uploaderName:current.source.uploaderName || ''})}>UP 主 · {current.source.uploaderName}</button>}
          {season && <button className="lyrics-season-link" title={season.title} onClick={() => {
            if (isMobile) setSeasonOpen(true)
            else onOpenCollection(seasonCollection(season))
          }}>
            <ListVideo size={14}/><span>合集 · {season.title || '查看合集'}</span><ChevronRight size={13}/>
          </button>}
          </div>
          <div className="lyrics-meta-actions">
            <button className={current.liked ? 'liked' : ''} aria-label={current.liked ? '取消喜欢' : '喜欢这首歌'} aria-pressed={Boolean(current.liked)} aria-busy={favoritePending} onClick={onFavorite}><Heart size={20} fill={current.liked ? 'currentColor' : 'none'} /></button>
            {isMobile && compact && supplementControl}
            {current.source.provider === 'bilibili' && <button aria-label={mediaMode === 'video' ? '显示封面' : '播放视频'} aria-pressed={mediaMode === 'video'} onClick={() => void showVideo()}>{mediaMode === 'video' ? <Image size={20}/> : <TvMinimalPlay size={20}/>}</button>}
            <button aria-label="查看评论" disabled={!current.source.aid} onClick={openComments}><MessageCircle size={20}/></button>
          </div>
        </div>
      </div>
      <div ref={scrollRef} onWheel={browseLyrics} onPointerDown={event => { lyricTouch.current = { x: event.clientX, y: event.clientY, direction: 'pending' } }} onPointerMove={event => { const touch = lyricTouch.current; if (!touch) return; touch.direction = touchDirection(event.clientX, event.clientY, touch.x, touch.y, touch.direction); if (touch.direction === 'vertical') browseLyrics() }} onPointerUp={() => { lyricTouch.current = null }} onPointerCancel={() => { lyricTouch.current = null }} onScroll={updateBrowseLine} onPointerLeave={() => setHoveredLine(null)} className={`lyrics-scroll${timingPreview ? ' lyrics-timing-preview' : ''}`} aria-live="polite">
        {loading && !displayLines.length ? <div className="lyrics-status"><LoaderCircle className="spin" />正在读取歌词</div> : displayLines.length ? displayLines.map((line, index) => (
          <p key={`${line.timeMs}-${index}`} ref={(node) => { lineRefs.current[index] = node }} className={`${index === activeIndex ? 'active' : index < activeIndex ? 'past' : ''}${timingPreview && hoveredLine === index ? ' timing-target' : ''}${browsingLyrics && !timingPreview && (syncedLyrics || subtitles.lines) && browseIndex === index ? ' browse-target' : ''}`} onPointerEnter={timingPreview ? event => { if (event.pointerType === 'mouse') setHoveredLine(index) } : undefined} role={timingPreview ? 'button' : undefined} tabIndex={timingPreview ? 0 : undefined} title={timingPreview ? '将这一句对齐到现在' : undefined} onClick={timingPreview ? () => alignLine(line.timeMs) : undefined} onKeyDown={timingPreview ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); alignLine(line.timeMs) } } : undefined}><span className="lyric-original"><WordLyric line={line} active={index === activeIndex} timeMs={progressSeconds * 1000 - biasMs} clock={lyricClock}/></span>{supplementMode !== 'off' && line[supplementMode] && <span className="lyric-secondary">{line[supplementMode]}</span>}{browsingLyrics && !timingPreview && (syncedLyrics || subtitles.lines) && browseIndex === index && <button type="button" className="lyric-seek-button" aria-label={`从这句播放：${line.text}`} title="从这句播放" onClick={() => seekLine(index)}><Play size={17} fill="currentColor" aria-hidden="true" /></button>}</p>
        )) : <div className="lyrics-status"><span>{error || '还没有歌词，手动搜索并选择一个版本吧'}</span><button className="load-more" onClick={() => setChooserOpen(true)}>匹配或导入歌词</button></div>}
      </div>
      {biasOpen && !subtitles.lines && <LyricsBiasControl value={stored?.biasMs || 0} enabled={syncedLyrics} error={biasSaveError}
        onAdjust={adjustBias} onClose={() => { setBiasOpen(false); void biasWriter.flush() }} onActivity={() => setBiasActivity(Date.now())} />}

      {(floatingError || subtitles.message || (error && displayLines.length > 0)) && <div className="lyrics-toast" role={floatingError ? 'alert' : 'status'}>{floatingError || subtitles.message || error}{floatingError && <button type="button" onClick={() => useFloatingLyrics.setState({error:''})}>知道了</button>}</div>}
      {chooserOpen && <LyricsChooser title={lyricQuery} artist={lyricArtist} onTitle={setLyricQuery} onArtist={setLyricArtist}
        loading={loading} searched={searched} error={error} warning={warning} candidates={candidates} stored={stored}
        onSearch={refreshCandidates} onChoose={candidate => selectCandidate(candidate, true)} onClose={() => { setChooserOpen(false); setManualOpen(false) }}
        manualOpen={manualOpen} onManualOpen={setManualOpen} manualText={manualText} onManualText={setManualText} onImport={importManualLyrics}/>}
      {rateOpen && <MobilePlaybackRate onClose={() => setRateOpen(false)}/>}
      {seasonOpen && season && <SeasonBrowser locateCurrent summary={season} onClose={() => setSeasonOpen(false)}/>}
      {partsOpen && videoDetail && <MobilePartsPage locateCurrent detail={videoDetail} onBack={() => setPartsOpen(false)}/>}
      {commentsOpen && current.source.aid && <CommentsPanel key={current.source.aid} aid={current.source.aid} onClose={closeComments} video={mediaMode === 'video' ? videoCover.current : null} />}
      {editing && <MetadataDialog track={editing} onClose={() => setEditing(null)} onSaved={(updated) => { usePlayerStore.getState().updateTrack(updated); setEditing(null); setLyricQuery(updated.title); setLyricArtist(updated.artist || ''); void queryClient.invalidateQueries({ queryKey: ['library'] }); void queryClient.invalidateQueries({ queryKey: ['home-recent'] }) }} />}
    </section>
  )
}

function centerLyric(scroll: HTMLDivElement, line: HTMLParagraphElement, behavior: ScrollBehavior) {
  scroll.scrollTo({ top: line.offsetTop - (scroll.clientHeight - line.offsetHeight) / 2, behavior })
}

function PlaybackRateControl() {
  const rate = usePlayerStore(state => state.rate)
  const setRate = usePlayerStore(state => state.setRate)
  return <label className="lyrics-subtitle-language">
    播放倍速
    <select aria-label="播放倍速" value={rate} onChange={event => void setRate(Number(event.target.value))}>
      {playbackRates.map(value => <option key={value} value={value}>{value}×</option>)}
    </select>
  </label>
}
