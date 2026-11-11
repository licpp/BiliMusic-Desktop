import { SeasonBrowser } from '../collections/SeasonBrowser'
import { seasonCollection } from '../../services/mediaSources'
import type { Collection } from '../../services/collections'
import { MobilePlaybackRate, PlaybackRateEntry } from './MobilePlaybackRate'
import { PlaybackSettings } from './PlaybackSettings'
import { useBiliSubtitles } from './useBiliSubtitles'
import { isMobile } from '../../services/platform'
import { controlMobileAudio } from '../player/mobileAudio'
import { formatDuration } from '../../shared/time'
import { LyricsChooser } from './LyricsChooser'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Clock3, Image, LoaderCircle, Maximize2, MessageCircle, Minimize2, Pencil, RefreshCw, SlidersHorizontal, TvMinimalPlay, FolderPlus, ChevronRight, ListVideo, Sparkles, Settings2 } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { MetadataDialog } from '../library/LibraryView'
import { TouchOptions } from '../../shared/TouchOptions'
import { ActionMenu } from '../../shared/ActionMenu'
import { chooseTrackPlaylist } from '../library/trackActionStore'
import { playbackRates, reloadCurrentAudioSource, usePlayerStore } from '../player/playerStore'
import {
  commandErrorMessage,
  getDanmaku,
  getVideoSource,
  getStoredLyrics,
  getVideoParts,
  saveStoredLyrics,
  searchLyrics,
  setStoredLyricsBias,
  type LyricCandidate,
  type LyricLine,
  type StoredLyrics,
} from '../../services/desktopApi'
import { candidateLines, parseLrc } from './lrc'
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

type Props = { onOpenSleepTimer: () => void; onClose: () => void; onFavorite: () => void; favoritePending: boolean; onOpenCollection: (item: Collection) => void }

export function LyricsView({ onOpenSleepTimer, onClose, onFavorite, favoritePending, onOpenCollection }: Props) {
  const queryClient = useQueryClient()
  const status = usePlayerStore(state => state.status)
  const duration = usePlayerStore(state => state.durationSeconds)

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
  const [candidates, setCandidates] = useState<LyricCandidate[]>([])
  const [chooserOpen, setChooserOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const subtitles = useBiliSubtitles(current?.source, stored?.trackId === current?.id && lines.length > 0, Boolean(loading || (stored && stored.trackId !== current?.id)))
  const [error, setError] = useState('')
  const [warning, setWarning] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualText, setManualText] = useState('')
  const lineRefs = useRef<Array<HTMLParagraphElement | null>>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [mediaPreference, setMediaPreference] = useState<'cover' | 'video'>(() => localStorage.getItem('lyrics-media-mode') === 'video' ? 'video' : 'cover')
  const [videoFailed, setVideoFailed] = useState(false)
  const mediaMode = current?.source.provider === 'bilibili' && !videoFailed ? mediaPreference : 'cover'
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
  const [lyricQuery, setLyricQuery] = useState(current?.title || '')
  const [lyricArtist, setLyricArtist] = useState(current?.artist || '')
  const [searched, setSearched] = useState(false)

  useEffect(() => {
    const update = (event: Event) => {
      const lyrics = (event as CustomEvent<StoredLyrics>).detail
      if (lyrics.trackId !== current?.id) return
      setStored(lyrics); setLines(parseStoredLines(lyrics)); setError(''); setWarning('')
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
          setLines(parseStoredLines(existing))
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
    setSeasonOpen(false); setPartsOpen(false); setControlsShown(false); setVideoFullscreen(false); setCommentsOpen(false); setChooserOpen(false); setEditing(null); setBiasOpen(false)
    setVideoFailed(false); setLyricQuery(current?.title || ''); setLyricArtist(current?.artist || '')
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
  const timingPreview = !subtitles.lines && biasOpen && syncedLyrics
  const biasMs = subtitles.lines ? 0 : stored?.biasMs || 0
  const activeIndex = useMemo(() => {
    if (!subtitles.lines && !syncedLyrics) return -1
    const currentMs = progressSeconds * 1_000 - biasMs
    let result = -1
    for (let index = 0; index < displayLines.length; index += 1) {
      const { timeMs, endTimeMs } = displayLines[index]
      if (timeMs > currentMs) break
      result = endTimeMs !== undefined && currentMs >= endTimeMs ? -1 : index
    }
    return result
  }, [displayLines, progressSeconds, biasMs, syncedLyrics, subtitles.lines])

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
    if (timingPreview && hoveredLine !== null) return
    const line = lineRefs.current[activeIndex]
    if (scrollRef.current && line) centerLyric(scrollRef.current, line, biasOpen || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
  }, [activeIndex, timingPreview, hoveredLine === null, biasMs, displayLines])

  async function refreshCandidates() {
    if (!current) return
    const request = ++lyricRequest.current
    setLoading(true); setError(''); setWarning(''); setSearched(true)
    try { const results = await searchLyrics(lyricQuery.trim(), lyricArtist.trim() || undefined, true); if (request === lyricRequest.current) { setCandidates(results.candidates); setWarning(results.warning || '') } }
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
    setStored(next); setBiasSaveError(false); setError(''); setBiasActivity(Date.now())
    biasWriter.set(current.id, next.biasMs)
  }

  function alignLine(timeMs: number) {
    if (!biasOpen || !storedRef.current) return
    const target = progressSeconds * 1000 - timeMs
    if (Math.abs(target) > 30_000) { setError('这句距离当前播放超过 30 秒，请选择附近的歌词对齐'); return }
    adjustBias(clampBias(target) - storedRef.current.biasMs)
  }

  if (!current) return <section className="lyrics-view"><button className="lyrics-close" onClick={onClose}><ChevronDown /></button><div className="lyrics-empty"><h2>尚未播放</h2><p>选择歌曲后，这里会显示歌词。</p></div></section>

  const subtitleLabel = subtitles.lines && !subtitles.choice?.ai ? 'B 站字幕' : 'AI 字幕'
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
      <header className="lyrics-topbar">
        <button className="lyrics-close" onClick={onClose} aria-label="收起歌词"><ChevronDown /></button>
        <span>正在播放</span>
        <div className="lyrics-actions">
          <button className="lyrics-comments-trigger" aria-label="查看评论" title="评论" onClick={openComments} disabled={!current.source.aid}><MessageCircle size={18} /></button>
          {bvid && !isMobile && <button className="lyrics-subtitle-toggle" aria-pressed={subtitles.active} aria-busy={subtitles.busy}
            onClick={toggleSubtitles}>
            {subtitles.busy && <LoaderCircle size={13} className="spin" />}
            {subtitleLabel}
          </button>}
          {!(isMobile && videoFullscreen) && <ActionMenu label={isMobile ? "播放设置" : "歌词页面更多操作"} panel touchSheet={isMobile}>{(close) => <>
            {isMobile && <>
              <PlaybackRateEntry onOpen={() => { close(); setRateOpen(true) }}/>
              <PlaybackSettings track={current} kind="audio" onChanged={reloadCurrentAudioSource}/>
            </>}
            {isMobile && bvid && <button className="lyrics-subtitle-menu-item" type="button" role="switch" aria-checked={subtitles.active} onClick={toggleSubtitles}>
              <Sparkles size={16}/>{subtitleLabel}<small>{subtitles.active ? '已开启' : subtitles.preferred ? '歌词优先' : '已关闭'}</small>
            </button>}
            {subtitles.active && subtitles.choices.length > 1 && (isMobile ? <TouchOptions label="字幕版本" selected={subtitles.choice?.language ?? ''}
              options={subtitles.choices.map(choice => ({ value: choice.language, label: choice.label || choice.language }))}
              onChange={subtitles.select}/> : <label className="lyrics-subtitle-language">
              字幕版本
              <select aria-label="字幕版本" value={subtitles.choice?.language} onChange={event => { subtitles.select(event.target.value); close() }}>
                {subtitles.choices.map(choice => <option key={choice.language} value={choice.language}>{choice.label || choice.language} · {choice.ai ? 'AI' : 'B 站'}</option>)}
              </select>
            </label>)}
            {isMobile && <div className="touch-sheet-section">歌曲与歌词</div>}
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); setEditing(current); setChooserOpen(false); setCommentsOpen(false) }}><Pencil size={16} />编辑歌曲信息</button>
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); chooseTrackPlaylist([current]) }}><FolderPlus size={16} />加入歌单…</button>
            <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); setChooserOpen(true) }}><RefreshCw size={16} />{stored ? '更换歌词' : '匹配歌词'}</button>
            <button role={isMobile ? undefined : "menuitem"} disabled={Boolean(subtitles.lines)} onClick={() => { close(); setHoveredLine(null); setBiasOpen(true); setBiasActivity(Date.now()) }}><SlidersHorizontal size={16} />调整歌词时间</button>
            {videoDetail && videoDetail.parts.length > 1 && <button role={isMobile ? undefined : "menuitem"} onClick={() => {
              close()
              if (isMobile) setPartsOpen(true)
              else onOpenCollection({ ...videoDetail, folderId: '' })
            }}><ListVideo size={16}/>查看分 P</button>}
            {isMobile && <button role={isMobile ? undefined : "menuitem"} onClick={() => { close(); onOpenSleepTimer() }}><Clock3 size={16}/>定时暂停</button>}
            {!isMobile && <><PlaybackRateControl/>
              <PlaybackSettings track={current} kind="audio" onChanged={reloadCurrentAudioSource}/></>}
          </>}</ActionMenu>}
        </div>
      </header>
      <div className={videoFullscreen ? 'lyrics-album-pane video-fullscreen' : 'lyrics-album-pane'}>
        <div className="lyrics-media">
        <div ref={videoCover} className={mediaMode === 'video' ? 'lyrics-cover video-active' : 'lyrics-cover'}>{videoUrl && <SyncedVideo src={videoUrl} poster={coverUrl} active={mediaMode === 'video'} onReady={setReadyVideoUrl} />}{mediaMode === 'video' ? <>{!videoUrl && <div className="video-startup"><Artwork src={coverUrl} /><div className="video-startup-status"><LoaderCircle size={16} className="spin" />正在解析视频线路…</div></div>}{danmakuVisible && videoReady && danmaku.data && danmaku.data.length > 0 && <DanmakuCanvas items={danmaku.data} scale={danmakuSize} opacity={danmakuOpacity} density={2 ** (danmakuDensity - 3)} />}</> : <Artwork src={coverUrl} adaptAspect />}{isMobile && mediaMode === 'video' && videoReady && <button type="button" className="video-reveal-controls" aria-label="显示视频控件" onClick={revealControls}/>}</div>
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
            {current.source.provider === 'bilibili' && <button aria-label={mediaMode === 'video' ? '显示封面' : '播放视频'} aria-pressed={mediaMode === 'video'} onClick={() => void showVideo()}>{mediaMode === 'video' ? <Image size={20}/> : <TvMinimalPlay size={20}/>}</button>}
            <button aria-label="查看评论" disabled={!current.source.aid} onClick={openComments}><MessageCircle size={20}/></button>
          </div>
        </div>
      </div>
      <div ref={scrollRef} onPointerLeave={() => setHoveredLine(null)} className={`lyrics-scroll${timingPreview ? ' lyrics-timing-preview' : ''}`} aria-live="polite">
        {loading && !displayLines.length ? <div className="lyrics-status"><LoaderCircle className="spin" />正在读取歌词</div> : displayLines.length ? displayLines.map((line, index) => (
          <p key={`${line.timeMs}-${index}`} ref={(node) => { lineRefs.current[index] = node }} className={`${index === activeIndex ? 'active' : index < activeIndex ? 'past' : ''}${timingPreview && hoveredLine === index ? ' timing-target' : ''}`} onPointerEnter={timingPreview ? event => { if (event.pointerType === 'mouse') setHoveredLine(index) } : undefined} role={timingPreview ? 'button' : undefined} tabIndex={timingPreview ? 0 : undefined} title={timingPreview ? '将这一句对齐到现在' : undefined} onClick={timingPreview ? () => alignLine(line.timeMs) : undefined} onKeyDown={timingPreview ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); alignLine(line.timeMs) } } : undefined}>{line.text}</p>
        )) : <div className="lyrics-status"><span>{error || '还没有歌词，手动搜索并选择一个版本吧'}</span><button className="load-more" onClick={() => setChooserOpen(true)}>匹配或导入歌词</button></div>}
      </div>
      {biasOpen && !subtitles.lines && <LyricsBiasControl value={stored?.biasMs || 0} enabled={syncedLyrics} error={biasSaveError}
        onAdjust={adjustBias} onClose={() => { setBiasOpen(false); void biasWriter.flush() }} onActivity={() => setBiasActivity(Date.now())} />}

      {(subtitles.message || (error && displayLines.length > 0)) && <div className="lyrics-toast" role="status">{subtitles.message || error}</div>}
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

function parseStoredLines(stored: StoredLyrics): LyricLine[] {
  try {
    const parsed = JSON.parse(stored.parsedJson)
    return Array.isArray(parsed) ? parsed.filter((line) => Number.isFinite(line?.timeMs) && typeof line?.text === 'string') : []
  } catch { return [] }
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
