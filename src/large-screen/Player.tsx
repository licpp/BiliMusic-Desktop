import { SeekRange } from '../shared/SeekRange'
import { PlayingVideoReplacement } from '../features/library/PlayingVideoReplacement'
import { useSourceTitleMetadata } from '../shared/useSourceTitleMetadata'
import { trackSubtitle } from '../domain/sourceTitle'
import { accountQueryKey, accountKeyAt } from '../services/queryKeys'
import { createPortal } from 'react-dom'
import { fitMediaFrame, centeredLyricScroll, playerDensity, lyricRowCount, observePlayerBox } from './playerLayout'
import { progressKeyAction } from './playerNavigation'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Expand, Heart, ListVideo, LoaderCircle, MonitorPlay, Music2, Pause, Play, Settings2, SkipBack, SkipForward, Sparkles, Search, SlidersHorizontal, Timer, MessageSquareText, RefreshCw } from 'lucide-react'
import { usePlayerStore, playbackClock, playbackRates, reloadCurrentAudioSource } from '../features/player/playerStore'
import { PlaybackModeButton } from '../features/player/PlaybackModeButton'
import { PlaybackSettings } from '../features/lyrics/PlaybackSettings'
import { DanmakuCanvas } from '../features/lyrics/DanmakuCanvas'
import { useLargeDanmaku, LargeDanmakuSettings } from './danmaku'
import { SyncedVideo } from '../features/lyrics/SyncedVideo'
import { VideoStartup } from '../features/lyrics/VideoStartup'
import { WordLyric } from '../features/lyrics/WordLyric'
import { lyricSupplementModes, nextLyricSupplement, type LyricSupplement } from '../domain/lrc'
import { storedLyricLines, lyricAt } from '../domain/lyricTimeline'
import { useBiliSubtitles } from '../features/lyrics/useBiliSubtitles'
import { useAutoLyricAlignment } from '../features/lyrics/useAutoLyricAlignment'
import { clampBias } from '../features/lyrics/biasWriter'
import { LyricsBackdrop } from '../features/lyrics/LyricsBackdrop'
import { getStoredLyrics, enrichStoredLyricLines, getVideoSource, setStoredLyricsBias } from '../services/desktopApi'
import type { StoredLyrics, LyricLine } from '../domain/lyrics'
import { accountEpoch } from '../services/accountScope'
import { controlMobileAudio } from '../features/player/mobileAudio'
import { isAndroid } from '../services/platform'
import { RangeControl } from '../shared/RangeControl'
import { Artwork } from '../shared/Artwork'
import { formatDuration } from '../shared/time'
import type { Track } from '../domain/track'
import { LargeLyricSearch } from './LyricSearch'
import { LargeDialog } from './LargeDialog'
import { Failure, type Navigate } from './Library'

export function LargeControls() {
  const status = usePlayerStore(s => s.status), current = usePlayerStore(s => s.current)
  const busy = status === 'resolving' || status === 'buffering'
  return <div className="large-controls"><button className="large-icon" aria-label="上一首" disabled={!current} onClick={() => void usePlayerStore.getState().previous()}><SkipBack/></button><button className="large-play" data-primary-focus aria-label={status === 'playing' || busy ? '暂停' : '播放'} disabled={!current} onClick={() => void usePlayerStore.getState().toggle()}>{busy ? <LoaderCircle className="spin"/> : status === 'playing' ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button><button className="large-icon" aria-label="下一首" disabled={!current} onClick={() => void usePlayerStore.getState().next()}><SkipForward/></button></div>
}

export function LargeProgress() {
  const position = usePlayerStore(s => s.progressSeconds), duration = usePlayerStore(s => s.durationSeconds)
  const id = usePlayerStore(s => s.current?.id)
  const [draft, setDraft] = useState<number | null>(null)
  useEffect(() => {
    if (draft === null) return
    const back = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); setDraft(null) }
    window.addEventListener('bilimusic-back', back, true)
    return () => window.removeEventListener('bilimusic-back', back, true)
  }, [draft])
  return <div className={`large-progress${draft !== null ? ' adjusting' : ''}`}><SeekRange duration={duration} trackKey={id} onSeek={seconds => { usePlayerStore.getState().seek(seconds); setDraft(null) }} data-focus="playback-seek" aria-label="播放进度" aria-valuetext={`${formatDuration(draft ?? position)}，${draft === null ? '按确定调整进度' : '左右调整，确定保存，返回取消'}`} min={0} max={Math.max(1, duration)} value={Math.min(duration, draft ?? position)} disabled={!duration} onBlur={() => setDraft(null)}
    onKeyDown={e => {
      const action = progressKeyAction(e.key, draft, position, duration, e.repeat)
      if (!action) return
      if (action.kind === 'leave') { setDraft(null); return }
      e.preventDefault(); e.stopPropagation()
      if (action.kind === 'seek') { usePlayerStore.getState().seek(action.value); setDraft(null) }
      else setDraft(action.value)
    }} onValueChange={value => { if (draft !== null) setDraft(value); else usePlayerStore.getState().seek(value) }}/><div><span>{formatDuration(draft ?? position)}</span><span>{draft !== null ? '确定保存 · 返回取消' : ''}</span><span>{formatDuration(duration)}</span></div></div>
}

export function LargePlayer({ onBack, onQueue, onFavorite, onMore, onSleep, navigate }: { onBack: () => void; onQueue: () => void; onFavorite: () => void; onMore: (track: Track) => void; onSleep: () => void; navigate: Navigate }) {
  const sourceClient = useQueryClient()
  const [replacingVideo, setReplacingVideo] = useState<Track | null>(null)
  const current = usePlayerStore(s => s.current), error = usePlayerStore(s => s.error)
  useSourceTitleMetadata(current)
  const [video, setVideo] = useState(() => localStorage.getItem('lyrics-media-mode') === 'video')
  const [fullscreen, setFullscreen] = useState(false), [settings, setSettings] = useState(false), [revision, setRevision] = useState(0)
  const trigger = useRef<HTMLButtonElement>(null), [shown, setShown] = useState(true), [activity, setActivity] = useState(0)
  const [lyricTools, setLyricTools] = useState<HTMLDivElement | null>(null)
  const player = useRef<HTMLDivElement>(null), [density, setDensity] = useState<ReturnType<typeof playerDensity>>('regular')
  const mediaStage = useRef<HTMLDivElement>(null), [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [videoAspect, setVideoAspect] = useState({ trackId: '', ratio: 16 / 9 })
  const hasTrack = Boolean(current)
  useLayoutEffect(() => {
    // The parent is already inside the safe area, including on builds where
    // Android gives the WebView native margins instead of CSS insets.
    const area = player.current?.parentElement
    if (!area) return
    return observePlayerBox(area, () => setDensity(playerDensity(area.clientWidth, area.clientHeight)))
  }, [hasTrack])
  useLayoutEffect(() => {
    const stage = mediaStage.current
    if (!stage) return
    return observePlayerBox(stage, () => {
      const width = stage.clientWidth, height = stage.clientHeight
      setStageSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    })
  }, [hasTrack, density])
  const mediaFit = fitMediaFrame(stageSize.width, stageSize.height, videoAspect.trackId === current?.id ? videoAspect.ratio : 16 / 9)
  const wasFullscreen = useRef(false)
  useLayoutEffect(() => {
    if (!fullscreen) { if (wasFullscreen.current) trigger.current?.focus({ preventScroll: true }); wasFullscreen.current = false; return }
    wasFullscreen.current = true
    if (settings) return
    if (!shown) document.querySelector<HTMLElement>('.large-video-surface')?.focus({ preventScroll: true })
    else if (!document.activeElement?.closest('.large-video-controls')) document.querySelector<HTMLElement>('.large-video-controls button')?.focus({ preventScroll: true })
  }, [fullscreen, shown, settings])
  const [readyUrl, setReadyUrl] = useState('')
  const ready = useCallback((url: string) => setReadyUrl(url), [])
  const source = useQuery({ queryKey: accountQueryKey('large-video', current?.id, revision), queryFn: () => getVideoSource(current!.source.bvid, current!.source.cid), enabled: video && Boolean(current && current.source.cid > 0), retry: false })
  const videoIntent = useRef('')
  videoIntent.current = JSON.stringify([accountEpoch(), current?.id, revision, video])
  const reloadVideo = useCallback(async () => {
    const epoch = accountEpoch(), intent = videoIntent.current
    const fresh = await getVideoSource(current!.source.bvid, current!.source.cid, true)
    if (epoch !== accountEpoch() || intent !== videoIntent.current) return
    sourceClient.setQueryData(accountKeyAt(epoch, 'large-video', current!.id, revision), fresh)
    setReadyUrl('')
  }, [current?.id, revision, sourceClient])
  const videoReady = video && Boolean(source.data && readyUrl === source.data.videoUrl)
  const danmaku = useLargeDanmaku(current?.source.cid || 0, videoReady)
  useEffect(() => { if (!fullscreen || !isAndroid) return; void controlMobileAudio('videoFullscreen', 1).catch(() => undefined); return () => { void controlMobileAudio('videoFullscreen', 0).catch(() => undefined) } }, [fullscreen])
  useEffect(() => {
    if (!fullscreen) return
    const back = (e: Event) => { if (document.querySelector('.large-dialog,[data-overflow-panel]')) return; e.preventDefault(); if (!shown) { setShown(true); setActivity(n => n + 1); return }; setFullscreen(false) }
    window.addEventListener('bilimusic-back', back)
    return () => window.removeEventListener('bilimusic-back', back)
  }, [fullscreen, shown])
  useEffect(() => { if (!fullscreen || settings) return; const timer = window.setTimeout(() => { setShown(false) }, 3500); return () => clearTimeout(timer) }, [fullscreen, settings, activity])
  const reveal = () => { setShown(true); setActivity(n => n + 1) }
  if (!current) return null
  const frame = <>{source.data && <SyncedVideo key={current.id} onReload={reloadVideo} src={source.data.videoUrl} poster={current.coverUrl} active={video} onReady={ready}/>}<Failure error={source.error} retry={() => void source.refetch()}/>{!source.data && !source.error && <VideoStartup key={current.id} poster={current.coverUrl} message="正在准备画面…"/>}</>
  return <div ref={player} className={`large-player${fullscreen ? ' is-fullscreen' : ''}`} data-density={density} data-media-error={error ? true : undefined}>
    <LyricsBackdrop cover={current.coverUrl}/>
    <header className="large-player-header"><button className="large-text-button" data-focus="player-back" aria-label="返回浏览" onClick={onBack}><ArrowLeft/><span>返回浏览</span></button><div className="large-toolbar"><button data-focus="player-video" data-focus-down={video ? 'video-fullscreen' : undefined} aria-label={video ? '封面' : '视频'} aria-pressed={video} onClick={() => { const next = !video; setVideo(next); setFullscreen(false); localStorage.setItem('lyrics-media-mode', next ? 'video' : 'cover') }}>{video ? <Music2/> : <MonitorPlay/>}<span>{video ? '封面' : '视频'}</span></button><button aria-label="队列" onClick={onQueue}><ListVideo/><span>队列</span></button>{current.importedEntry?.trackId === current.id && <button aria-label="更换视频" onClick={() => setReplacingVideo(current)}><RefreshCw/><span>更换视频</span></button>}</div></header>
    <div className="large-player-body"><section className="large-player-info">
      <div className="large-media-stage" ref={mediaStage}><div className="large-media-frame" style={stageSize.width ? mediaFit : undefined} onLoadedMetadataCapture={e => { const element = e.target; if (element instanceof HTMLVideoElement && element.videoWidth && element.videoHeight) setVideoAspect({ trackId: current.id, ratio: element.videoWidth / element.videoHeight }) }}>{video ? <div className={`large-video${fullscreen ? ' expanded' : ''}`} role={fullscreen ? 'dialog' : undefined} aria-modal={fullscreen ? true : undefined} aria-label={fullscreen ? '全屏视频' : '视频小窗'} onPointerMove={fullscreen ? reveal : undefined} onKeyDownCapture={fullscreen ? e => { if (!shown) { e.preventDefault(); e.stopPropagation(); reveal() } else reveal() } : undefined}>
        {frame}{videoReady && danmaku.visible && danmaku.query.data && <DanmakuCanvas items={danmaku.query.data} scale={danmaku.size} opacity={danmaku.opacity} density={2 ** (danmaku.density - 3)}/>}{!fullscreen && <button tabIndex={-1} aria-hidden="true" className="large-video-tap" onClick={() => { setFullscreen(true); reveal() }}/>}
        {fullscreen && <><button className="large-video-surface" tabIndex={shown ? -1 : 0} aria-label="显示视频播放控制" onClick={reveal}/><div className="large-video-controls" hidden={!shown} onFocus={reveal}><header><button onClick={() => { setFullscreen(false) }}><ArrowLeft/>退出全屏</button><strong>{current.title}</strong><button aria-pressed={danmaku.visible} aria-label={danmaku.visible ? '关闭弹幕' : '显示弹幕'} onClick={danmaku.toggle}><MessageSquareText/>弹幕</button><button onClick={() => setSettings(true)}><Settings2/>播放设置</button></header><LargeProgress/><LargeControls/></div></>}
      </div> : <Artwork adaptAspect className="large-player-cover" src={current.coverUrl}/>}</div>
      {video && !fullscreen && <button ref={trigger} className="large-video-open" aria-label="全屏播放视频" data-focus="video-fullscreen" data-focus-left="player-back" data-focus-up="player-back"
        style={{ '--large-frame-right': `${(stageSize.width - mediaFit.width) / 2}px`, '--large-frame-bottom': `${(stageSize.height - mediaFit.height) / 2}px` } as CSSProperties}
        onClick={() => { setFullscreen(true); reveal() }}><Expand/><span>全屏</span></button>}</div>
      <div className="large-player-title"><h1>{current.displayTitle || current.title}</h1><p>{trackSubtitle(current)}</p></div><LargeProgress/><LargeControls/>
      <Failure error={error} retry={() => void usePlayerStore.getState().play(current)}/>
    </section><LargeLyrics track={current} toolsHost={lyricTools} density={density}/></div>
    <footer className="large-player-footer"><div className="large-player-extras"><button className={current.liked ? 'liked' : ''} aria-pressed={current.liked} aria-label={current.liked ? '取消喜欢' : '喜欢'} onClick={onFavorite}><Heart fill={current.liked ? 'currentColor' : 'none'}/></button><PlaybackModeButton/><button aria-label="选集" onClick={() => navigate({ kind: 'collection', item: { bvid: current.source.bvid, title: current.videoTitle || current.title, coverUrl: current.coverUrl || '', uploaderName: current.source.uploaderName || '', folderId: '' } })}><ListVideo/><span>选集</span></button><button aria-label="设置" onClick={() => setSettings(true)}><Settings2/><span>设置</span></button><button aria-label="当前歌曲更多操作" onClick={() => onMore(current)}>···</button></div><div className="large-lyrics-tools-host" ref={setLyricTools}/></footer>
    {replacingVideo && <PlayingVideoReplacement track={replacingVideo} onClose={() => setReplacingVideo(null)} renderDialog={body => <LargeDialog title="更换视频" className="import-match-large-dialog" onClose={() => setReplacingVideo(null)}>{body}</LargeDialog>}/>}
    {settings && <LargeDialog className="large-playback-settings" title="播放设置" onClose={() => setSettings(false)}><div className="large-setting-stack"><PlaybackSettings track={current} kind="audio" onChanged={reloadCurrentAudioSource}/>{video && <PlaybackSettings track={current} kind="video" onChanged={() => setRevision(n => n + 1)}/>}<RateSetting/>{video && <LargeDanmakuSettings state={danmaku}/>}<CaptionSetting/><button onClick={() => { setSettings(false); onSleep() }}><Timer/>定时暂停</button></div></LargeDialog>}
  </div>
}
function RateSetting() { const rate = usePlayerStore(s => s.rate); return <section className="large-setting-section"><h3>播放速度</h3><div className="large-options">{playbackRates.map(r => <button key={r} aria-pressed={rate === r} onClick={() => void usePlayerStore.getState().setRate(r)}>{r}×</button>)}</div></section> }
function CaptionSetting() { const subtitles = useBiliSubtitles(); return <button className="large-setting-toggle" aria-pressed={subtitles.active} onClick={subtitles.toggle}><Sparkles/><span>AI字幕</span><small>{subtitles.active ? '已开启' : '未开启'}</small></button> }

function LargeLyrics({ track, toolsHost, density }: { track: Track; toolsHost: HTMLElement | null; density: ReturnType<typeof playerDensity> }) {
  const client = useQueryClient(), epoch = accountEpoch(), key = accountKeyAt(epoch, 'large-lyrics', track.id)
  const stored = useQuery({ queryKey: key, queryFn: () => getStoredLyrics(track.id) })
  const [enriched, setEnriched] = useState<{ stored: StoredLyrics; lines: LyricLine[] }>()
  const [chooserOpen, setChooserOpen] = useState(false)
  const [biasOpen, setBiasOpen] = useState(false), [biasBusy, setBiasBusy] = useState(false), [biasError, setBiasError] = useState('')
  useEffect(() => { let alive = true; if (stored.data) void enrichStoredLyricLines(stored.data).then(lines => { if (alive && lines) setEnriched({ stored: stored.data!, lines }) }).catch(() => undefined); return () => { alive = false } }, [stored.data])
  useEffect(() => { const update = (e: Event) => { const value = (e as CustomEvent<StoredLyrics>).detail; if (value.trackId === track.id && epoch === accountEpoch()) client.setQueryData(key, value) }; window.addEventListener('bilimusic-lyrics-updated', update); return () => window.removeEventListener('bilimusic-lyrics-updated', update) }, [track.id, client, epoch])
  const captions = useBiliSubtitles(), bias = captions.active ? 0 : stored.data?.biasMs || 0
  const lines = captions.active ? captions.lines || [] : enriched && enriched.stored === stored.data ? enriched.lines : stored.data ? storedLyricLines(stored.data) : []
  const autoAlignment = useAutoLyricAlignment({ track, stored: stored.data, lines, enabled: biasOpen && !captions.active && !biasBusy, onAligned: saved => { client.setQueryData(key, saved); setBiasError('') } })
  const [supplementPreference, setSupplementPreference] = useState<LyricSupplement>(() => {
    const saved = localStorage.getItem('lyrics-supplement')
    return saved === 'romanization' || saved === 'translation' ? saved : 'off'
  })
  const supplementModes = useMemo(() => lyricSupplementModes(lines), [lines])
  const supplementMode = !captions.active && supplementModes.includes(supplementPreference) ? supplementPreference : 'off'
  const cycleSupplement = () => {
    const next = nextLyricSupplement(supplementMode, supplementModes)
    setSupplementPreference(next); localStorage.setItem('lyrics-supplement', next)
  }
  const supplementLabel = `附加歌词：${supplementMode === 'romanization' ? '音译' : supplementMode === 'translation' ? '翻译' : '关闭'}，点击切换`
  const [index, setIndex] = useState(-1), [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const viewport = useRef<HTMLElement>(null), scroll = useRef<HTMLDivElement>(null), [viewportHeight, setViewportHeight] = useState(0)
  const browsing = useRef(false), resumeTimer = useRef(0), [browseRevision, setBrowseRevision] = useState(0)
  const gesture = useRef({ y: 0, moved: false })
  const resumeFollowing = () => { clearTimeout(resumeTimer.current); browsing.current = false; setFocusedIndex(null); setBrowseRevision(n => n + 1) }
  const pauseFollowing = () => { browsing.current = true; clearTimeout(resumeTimer.current) }
  const resumeLater = () => { clearTimeout(resumeTimer.current); resumeTimer.current = window.setTimeout(resumeFollowing, 5000) }
  useEffect(() => () => clearTimeout(resumeTimer.current), [])
  const rows = lyricRowCount(viewportHeight, supplementMode !== 'off')
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    return observePlayerBox(element, () => {
      const style = getComputedStyle(element)
      setViewportHeight(element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))
    })
  }, [density])
  useEffect(() => { resumeFollowing() }, [track.id, stored.data])
  useEffect(() => { setChooserOpen(false); setBiasOpen(false) }, [track.id])
  const clock = useCallback(() => playbackClock() * 1000 - bias, [bias])
  const playing = usePlayerStore(state => state.status === 'playing')
  useEffect(() => { const update = () => setIndex(lyricAt(lines, clock())); update(); const timer = window.setInterval(update, 100); return () => clearInterval(timer) }, [lines, clock])
  const adjustBias = async (delta: number) => { if (!stored.data || biasBusy || autoAlignment.busy) return; setBiasBusy(true); setBiasError(''); try { const next = await setStoredLyricsBias(track.id, clampBias(stored.data.biasMs + delta)); if (epoch === accountEpoch()) client.setQueryData(key, next) } catch (e) { setBiasError(String((e as Error).message || e)) } finally { setBiasBusy(false) } }
  const rowHeight = Math.max(44, (viewportHeight - (rows - 1) * 6) / rows)
  const lastCentered = useRef('')
  useLayoutEffect(() => {
    if (browsing.current) return
    const container = scroll.current, at = focusedIndex ?? Math.max(0, index)
    const line = container?.querySelector<HTMLElement>(`[data-lyric-index="${at}"]`)
    if (!container || !line) return
    const offset = line.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
    const next = centeredLyricScroll(offset, line.clientHeight, container.clientHeight, container.scrollHeight)
    const identity = `${track.id}:${supplementMode}:${viewportHeight}`
    container.scrollTo({ top: next, behavior: lastCentered.current === identity && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant' })
    lastCentered.current = identity
  }, [index, focusedIndex, lines, viewportHeight, rows, supplementMode, browseRevision, track.id])
  const tools = <div className="large-lyrics-tools">{!captions.active && supplementModes.length > 1 && <button className="large-supplement-toggle" aria-label={supplementLabel} title={supplementLabel} aria-pressed={supplementMode !== 'off'} onClick={cycleSupplement}><span aria-hidden="true">{supplementMode === 'romanization' ? '音' : supplementMode === 'translation' ? '译' : '原'}</span></button>}<button aria-label="匹配歌词" onClick={() => setChooserOpen(true)}><Search/><span>匹配歌词</span></button>{stored.data && !captions.active && <button aria-label="歌词偏移" onClick={() => setBiasOpen(true)}><SlidersHorizontal/><span>歌词偏移</span></button>}</div>
  return <section ref={viewport} className="large-lyrics" onFocusCapture={e => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-lyric-index]')
    if (target && e.currentTarget.contains(target) && !browsing.current) setFocusedIndex(Number(target.dataset.lyricIndex))
  }} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedIndex(null) }} aria-label={captions.active ? '字幕' : '歌词'}>
    {lines.length ? <div ref={scroll} className="large-lyric-window" data-supplement={supplementMode} style={{ '--large-lyric-row-height': `${rowHeight}px`, '--large-lyric-inset': `${Math.max(0, (viewportHeight - rowHeight) / 2)}px` } as CSSProperties}
      onPointerDown={e => { gesture.current = { y: e.clientY, moved: false }; if (e.pointerType !== 'mouse') pauseFollowing() }}
      onPointerMove={e => { if (Math.abs(e.clientY - gesture.current.y) > 8 && e.buttons) gesture.current.moved = true }}
      onPointerCancel={() => { gesture.current.moved = true; resumeLater() }}
      onPointerUp={() => { if (browsing.current) resumeLater() }}
      onWheel={() => { pauseFollowing(); resumeLater() }} onScroll={() => { if (browsing.current) resumeLater() }}
      onClickCapture={e => { if (gesture.current.moved && e.detail > 0) { e.preventDefault(); e.stopPropagation() } }}
      onKeyDown={e => {
        if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-lyric-index]')
        if (!target) return
        const next = Number(target.dataset.lyricIndex) + (e.key === 'ArrowDown' ? 1 : -1)
        const destination = scroll.current?.querySelector<HTMLElement>(`[data-lyric-index="${next}"]`)
        if (!destination) return
        e.preventDefault(); e.stopPropagation(); clearTimeout(resumeTimer.current); browsing.current = false
        destination.focus({ preventScroll: true }); setFocusedIndex(next)
      }}>
      {lines.map((line, at) => <button key={`${at}:${line.timeMs}`} data-lyric-index={at} className={at === index ? 'active' : at < index ? 'past' : ''} aria-current={at === index ? 'true' : undefined} onClick={() => { resumeFollowing(); usePlayerStore.getState().seek((line.timeMs + bias) / 1000) }}><span className="large-lyric-original"><WordLyric line={line} active={at === index} timeMs={clock()} clock={playing ? clock : undefined}/></span>{supplementMode !== 'off' && line[supplementMode] && <span className="large-lyric-secondary">{line[supplementMode]}</span>}</button>)}
    </div> : <div className="large-lyrics-empty"><Music2/><h2>{captions.busy || stored.isPending ? '正在寻找歌词…' : '暂无歌词'}</h2>{captions.message && <p>{captions.message}</p>}<CaptionSetting/></div>}
    {lines.length > 0 && captions.message && <p className="large-caption-notice" role="status">{captions.message}</p>}
    {toolsHost && createPortal(tools, toolsHost)}
    {chooserOpen && <LargeLyricSearch key={track.id} track={track} stored={stored.data} onClose={() => setChooserOpen(false)} onSaved={value => { client.setQueryData(key, value); if (captions.active) captions.toggle(); window.dispatchEvent(new CustomEvent('bilimusic-lyrics-updated', { detail: value })) }}/>}
    {biasOpen && <LargeDialog title="歌词偏移" onClose={() => setBiasOpen(false)}><p className="large-muted">{((stored.data?.biasMs || 0) / 1000).toFixed(1)} 秒</p><div className="large-options"><button disabled={autoAlignment.busy || biasBusy} aria-busy={autoAlignment.busy} onClick={() => void autoAlignment.run()}>{autoAlignment.busy ? <LoaderCircle className="spin"/> : <Sparkles/>}自动对齐</button><button aria-disabled={biasBusy || autoAlignment.busy} onClick={() => void adjustBias(-500)}>提前 0.5秒</button><button aria-disabled={biasBusy || autoAlignment.busy} onClick={() => void adjustBias(500)}>延后 0.5秒</button><button aria-disabled={biasBusy || autoAlignment.busy} onClick={() => void adjustBias(-(stored.data?.biasMs || 0))}>重置</button></div>{(biasError || autoAlignment.message) && <p className={biasError || autoAlignment.failed ? "large-error" : "large-muted"} role={biasError || autoAlignment.failed ? "alert" : "status"}>{biasError || autoAlignment.message}</p>}</LargeDialog>}
  </section>
}
