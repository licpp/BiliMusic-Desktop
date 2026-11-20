import { dispatchBack } from '../shared/overlayStack'
import { usePageMotion } from '../shared/pageMotion'
import { useUpdateStore } from '../services/updates'
import { useVisibilityRules } from '../services/contentVisibility'
import { accountQueryKey } from '../services/queryKeys'
import { CopyPlaybackDiagnostics, PlaybackErrorText } from '../features/player/PlaybackError'
import { LargeDownloadDialogHost } from './DownloadDialog'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft, Cloud, Download, Heart, Home, Library, ListMusic, Play, Search, Settings, Trash2 } from 'lucide-react'
import type { Track } from '../domain/track'
import { Artwork } from '../shared/Artwork'
import { captureBookmark, restoreView, type FocusBookmark } from './navigation'
import { LargeKeyboardBar, dismissLargeKeyboard } from './keyboard'
import { commandErrorMessage, listPlaylists, listRecentTracks, saveLibraryTrack, toggleStoredFavorite } from '../services/desktopApi'
import { accountEpoch } from '../services/accountScope'
import { hydrateVisibleTracks } from '../services/sync'
import { useSyncAttention } from '../services/syncAttention'
import { usePlayerStore } from '../features/player/playerStore'
import { connectMediaSession } from '../features/player/mediaSession'
import { controlMobileAudio } from '../features/player/mobileAudio'
import { isAndroid } from '../services/platform'
import { LargeSleep } from './Sleep'
import { hydrateSourceTitles } from '../services/sourceTitles'
import { installDirectionalFocus } from './focus'
import { Card, Failure, LargeLibrary, LargePlaylist, LargeCollection, LargeCreator, LargeSearch, TrackRows, type Route, type LibraryTab } from './Library'
import { LargeControls, LargePlayer } from './Player'
import { LargeDialog } from './LargeDialog'
import { LargeSettings } from './Settings'
import { LargeTrackActions } from './TrackActions'
import { LargeOffline } from './Offline'
import { currentDisplayVersion } from '../shared/version'

type ReturnPoint = { route: Route; scroll: number; focus?: FocusBookmark }
export function LargeScreenApp() {
  useVisibilityRules()
  const updateAvailable = useUpdateStore(s => s.result?.status === 'available')
  const [filters, setFilters] = useState<Record<string, string>>({}), [searchKind, setSearchKind] = useState<'video' | 'creator'>('video')
  const [route, setRoute] = useState<Route>({ kind: 'home' }), [tab, setTab] = useState<LibraryTab>('playlists'), [query, setQuery] = useState('')
  const history = useRef<ReturnPoint[]>([]), main = useRef<HTMLElement>(null), restore = useRef<ReturnPoint | undefined>(undefined), initialFocus = useRef(false)
  const pageMotion = useRef<'back' | 'player' | undefined>(undefined)
  const pageKey = route.kind === 'creator' || route.kind === 'collection' ? `${route.kind}:${route.item.bvid}`
    : route.kind === 'folder' ? `folder:${route.id}` : route.kind === 'playlist' ? `playlist:${route.playlist.id}` : route.kind
  const pageDepth = ['creator', 'collection', 'folder', 'playlist', 'player'].includes(route.kind) ? 1 : 0
  usePageMotion(main, pageKey, pageDepth, false, pageMotion)
  const [queueOpen, setQueueOpen] = useState(false), [menu, setMenu] = useState<{ track: Track; queue?: boolean; visibilityScope?:string; replaceVideo?:()=>void }>(), [sleep, setSleep] = useState(false)
  const current = usePlayerStore(s => s.current), queue = usePlayerStore(s => s.queue)
  const playbackError = usePlayerStore(s => s.error)
  const playbackFailed = usePlayerStore(s => s.status === 'error')
  const attention = useSyncAttention(s => s.library || s.statistics), [message, setMessage] = useState(''), [actionError, setActionError] = useState('')
  const client = useQueryClient(), toggling = useRef(false)
  const navigate = useCallback((next: Route) => {
    const shell = main.current?.closest<HTMLElement>('.large-shell')
    history.current.push({ route, scroll: main.current?.scrollTop || 0, focus: shell ? captureBookmark(shell) : undefined })
    pageMotion.current = next.kind === 'player' ? 'player' : undefined
    restore.current = undefined; initialFocus.current = true; setRoute(next)
  }, [route])
  const back = useCallback(() => {
    const previous = history.current.pop()
    if (previous || route.kind !== 'home') pageMotion.current = 'back'
    if (previous) { restore.current = previous; setRoute(previous.route) }
    else if (route.kind !== 'home') { initialFocus.current = true; setRoute({ kind: 'home' }) }
    else return false
    return true
  }, [route.kind])
  useLayoutEffect(() => {
    const target = restore.current
    if (target && main.current) {
      restore.current = undefined
      return restoreView(main.current.closest<HTMLElement>('.large-shell')!, main.current, target.focus, target.scroll, () => client.isFetching() > 0)
    }
    if (main.current) main.current.scrollTop = 0
    if (initialFocus.current) { initialFocus.current = false; main.current?.querySelector<HTMLElement>('button,input,summary')?.focus({ preventScroll: true }) }
  }, [route])
  useEffect(() => { document.getElementById('app-bootstrap')?.remove(); document.querySelector<HTMLElement>('[data-focus="nav-home"]')?.focus(); return installDirectionalFocus({ onEdit: () => { if (isAndroid) void controlMobileAudio('keyboard', 1).catch(() => undefined) } }) }, [])
  useEffect(connectMediaSession, [])
  useEffect(() => { if (queue.length) void hydrateSourceTitles(queue.slice(0, 50).map(t => t.id), client).catch(() => undefined) }, [queue, client])
  useEffect(() => {
    const changed = () => { history.current = []; setFilters({}); setQuery(''); setSearchKind('video'); setMenu(undefined); setQueueOpen(false); setSleep(false); setActionError(''); setRoute({ kind: 'home' }) }
    const status = (event: Event) => setMessage(String((event as CustomEvent).detail || ''))
    const recent = () => { void client.invalidateQueries({ queryKey: accountQueryKey('home-recent') }) }
    window.addEventListener('bilimusic-account-changing', changed); window.addEventListener('bilimusic-sync-status', status); window.addEventListener('bilimusic-recent-changed', recent)
    return () => { window.removeEventListener('bilimusic-account-changing', changed); window.removeEventListener('bilimusic-sync-status', status); window.removeEventListener('bilimusic-recent-changed', recent) }
  }, [client])
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 5000); return () => clearTimeout(timer) }, [message])
  useEffect(() => {
    const handle = (event: Event) => { if (event.defaultPrevented || document.querySelector('[data-overflow-panel],[aria-modal="true"],.sleep-timer-settings,.sleep-timer-notice')) return; if (back()) event.preventDefault() }
    const keyboard = (event: KeyboardEvent) => { if (event.defaultPrevented || !['Escape', 'BrowserBack'].includes(event.key)) return; if (dispatchBack()) event.preventDefault() }
    window.addEventListener('bilimusic-back', handle); window.addEventListener('keydown', keyboard)
    return () => { window.removeEventListener('bilimusic-back', handle); window.removeEventListener('keydown', keyboard) }
  }, [back])
  useEffect(() => {
    if (!isAndroid) return
    let alive = true, requested = false
    const apply = () => { if (!alive) return; const keep = route.kind === 'player' && localStorage.getItem('large-keep-awake') === 'true'; requested = keep; void controlMobileAudio('keepAwake', keep ? 1 : 0).catch(() => undefined) }
    apply(); window.addEventListener('bilimusic-display-changed', apply)
    return () => { alive = false; window.removeEventListener('bilimusic-display-changed', apply); if (requested) void controlMobileAudio('keepAwake', 0).catch(() => undefined) }
  }, [route.kind])
  const favorite = async (track: Track) => {
    if (toggling.current) return
    toggling.current = true; const epoch = accountEpoch()
    try { const saved = await saveLibraryTrack(track); if (epoch !== accountEpoch()) return; const liked = await toggleStoredFavorite(saved.id); if (epoch !== accountEpoch()) return; usePlayerStore.getState().updateTrack({ ...track, liked }); await Promise.all([client.invalidateQueries({ queryKey: accountQueryKey('library') }), client.invalidateQueries({ queryKey: accountQueryKey('playlists') })]) }
    finally { toggling.current = false }
  }
  const favoriteCurrent = () => { if (current) void favorite(current).catch(e => setActionError(commandErrorMessage(e))) }
  const showMenu = (track: Track, visibilityScope?:string, replaceVideo?:()=>void) => setMenu({ track, visibilityScope, replaceVideo })
  const filterKey = route.kind === 'folder' ? `folder:${route.id}` : route.kind === 'playlist' ? `playlist:${route.playlist.id}` : route.kind === 'collection' ? `collection:${route.item.bvid}` : `library:${tab}`
  const filterState: [string, (value: string) => void] = [filters[filterKey] || '', value => setFilters(previous => ({ ...previous, [filterKey]: value }))]
  const active = ['playlist', 'folder', 'collection', 'creator'].includes(route.kind) ? 'library' : route.kind
  return <div onSubmitCapture={dismissLargeKeyboard} className={`large-shell${route.kind === 'player' ? ' player-open' : route.kind === 'home' ? ' home-open' : ''}`}>
    <nav className="large-nav" aria-label="主导航"><button className="large-brand" aria-label="BiliMusic首页" onClick={() => navigate({ kind: 'home' })}><img src="/app-icon.png" alt=""/><span>BiliMusic</span></button><div className="large-nav-items">{([{ kind: 'home', title: '首页', Icon: Home }, { kind: 'library', title: '音乐库', Icon: Library }, { kind: 'search', title: '搜索', Icon: Search }, { kind: 'offline', title: '离线', Icon: Download }, { kind: 'settings', title: '设置', Icon: Settings }] as const).map(({ kind, title, Icon }) => <button data-focus={`nav-${kind}`} key={kind} aria-current={active === kind ? 'page' : undefined} onClick={() => { if (route.kind !== kind) navigate({ kind }) }}><Icon/><span>{title}</span>{kind === 'settings' && updateAvailable && !attention && <span className="update-nav-dot" aria-label="有新版本"/>}{kind === 'settings' && attention && <AlertCircle className="large-attention" aria-label="同步需要处理"/>}</button>)}</div><small className="large-version">{currentDisplayVersion}</small></nav>
    <main ref={main} className="large-main" aria-label="内容区">
      {route.kind !== 'player' && <div className="large-topbar"><button className="large-icon" aria-label="返回上一页" disabled={route.kind === 'home' && !history.current.length} onClick={() => back()}><ArrowLeft/></button><button className={attention ? 'large-sync attention' : 'large-sync'} onClick={() => navigate({ kind: 'settings' })}>{attention ? <AlertCircle/> : <Cloud/>}<span>{attention ? '同步待处理' : '账号与同步'}</span></button></div>}
      {route.kind === 'home' && <LargeHome navigate={navigate} onMore={showMenu}/>}
      {route.kind === 'library' && <LargeLibrary filterState={filterState} tab={tab} setTab={setTab} navigate={navigate}/>}
      {route.kind === 'folder' && <LargeLibrary filterState={filterState} key={route.id} tab={tab} setTab={setTab} navigate={navigate} folder={route}/>}
      {route.kind === 'playlist' && <LargePlaylist filterState={filterState} key={route.playlist.id} playlist={route.playlist} onMore={(track,replaceVideo)=>showMenu(track,undefined,replaceVideo)} navigate={navigate}/>}
      {route.kind === 'collection' && <LargeCollection filterState={filterState} key={route.item.bvid} item={route.item} onMore={showMenu} navigate={navigate}/>}
      {route.kind === 'creator' && <LargeCreator route={route} navigate={navigate} replace={setRoute}/>}
      {route.kind === 'search' && <LargeSearch kind={searchKind} setKind={setSearchKind} query={query} setQuery={setQuery} navigate={navigate}/>}
      {route.kind === 'offline' && <LargeOffline/>}
      {route.kind === 'settings' && <LargeSettings/>}
      {route.kind === 'player' && <LargePlayer onSleep={() => setSleep(true)} onBack={() => back()} onQueue={() => setQueueOpen(true)} onFavorite={favoriteCurrent} onMore={showMenu} navigate={navigate}/>}
    </main>
    {route.kind !== 'player' && <footer className="large-dock"><button className="large-dock-song" data-focus="dock-song" disabled={!current} onClick={() => navigate({ kind: 'player' })}><Artwork adaptAspect src={current?.coverUrl}/><span><strong>{current?.displayTitle || current?.title || '让音乐开始'}</strong><small>{current?.artist || current?.source.uploaderName || '选择一首喜欢的歌'}</small></span></button><LargeControls/><div className="large-dock-actions"><button aria-label="定时暂停" onClick={() => setSleep(true)} disabled={!current}>定时</button><button onClick={() => setQueueOpen(true)} aria-label={`播放队列，${queue.length}首`}><ListMusic/><span>队列</span><small>{queue.length}</small></button></div></footer>}
    {queueOpen && <LargeQueue onClose={() => setQueueOpen(false)} onMore={track => setMenu({ track, queue: true })}/>}
    {menu && <LargeTrackActions key={menu.track.id} track={menu.track} visibilityScope={menu.visibilityScope} replaceVideo={menu.replaceVideo} queue={menu.queue} onClose={() => setMenu(undefined)} onFavorite={favorite}/>}
    <LargeDownloadDialogHost/>
    <LargeKeyboardBar/>
    <LargeSleep open={sleep} onClose={() => setSleep(false)}/>
    {route.kind !== 'player' && playbackError ? <div className="large-toast large-playback-error" role="alert">
      <PlaybackErrorText issue={playbackError}/>
      <div className="playback-issue-actions">
        {current && playbackFailed && <button type="button" onClick={() => void usePlayerStore.getState().toggle()}>重试</button>}
        <CopyPlaybackDiagnostics issue={playbackError} track={current}/>
        <button type="button" onClick={() => usePlayerStore.setState({ error: null })}>关闭</button>
      </div>
    </div> : (actionError || message) && <button className="large-toast" role="status" onClick={() => { setActionError(''); setMessage('') }}>{actionError || message}</button>}
  </div>
}
function LargeHome({ navigate, onMore }: { navigate: (r: Route) => void; onMore: (t: Track) => void }) {
  const recent = useQuery({ queryKey: accountQueryKey('home-recent'), queryFn: listRecentTracks }), playlists = useQuery({ queryKey: accountQueryKey('playlists'), queryFn: listPlaylists }), client = useQueryClient()
  useEffect(() => { void hydrateVisibleTracks(recent.data, client).catch(() => undefined) }, [recent.data, client])
  return <div className="large-home"><div className="large-home-top"><ResumeCard navigate={navigate}/><div className="large-home-shortcuts"><button onClick={() => { const liked = playlists.data?.find(p => p.isSystem); if (liked) navigate({ kind: 'playlist', playlist: liked }); else navigate({ kind: 'library' }) }}><Heart/><span><strong>我喜欢</strong></span></button><button onClick={() => navigate({ kind: 'offline' })}><Download/><span><strong>离线音乐</strong></span></button></div></div>{Boolean(playlists.data?.length) && <><div className="large-section-heading"><h2>歌单</h2><button onClick={() => navigate({ kind: 'library' })}>查看全部</button></div><div className="large-grid large-home-playlists">{playlists.data?.slice(0, 4).map(p => <Card playlist key={p.id} id={`home-playlist-${p.id}`} title={p.name} subtitle={`${p.trackCount} 首`} linked={Boolean(p.biliFolderId)} cover={p.coverUrl} onClick={() => navigate({ kind: 'playlist', playlist: p })}/>)}</div></>}{Boolean(recent.data?.length) && <><div className="large-section-heading"><h2>最近播放</h2></div><TrackRows tracks={recent.data!.slice(0, 12)} onMore={onMore}/></>}<Failure error={recent.error || playlists.error} retry={() => { void recent.refetch(); void playlists.refetch() }}/></div>
}
function ResumeCard({ navigate }: { navigate: (r: Route) => void }) {
  const current = usePlayerStore(s => s.current), progress = usePlayerStore(s => s.progressSeconds), status = usePlayerStore(s => s.status)
  return <section className="large-resume large-surface"><Artwork adaptAspect src={current?.coverUrl}/><div><small>{current ? `上次听到 ${Math.floor(progress / 60)}:${String(Math.floor(progress % 60)).padStart(2, '0')}` : '你的音乐世界'}</small><h2>{current?.displayTitle || current?.title || '从喜欢的歌开始'}</h2><p>{current?.artist || current?.source.uploaderName || '搜索、收藏，或同步已有音乐库'}</p></div><button className="large-primary" data-focus="resume" data-primary-focus onClick={() => { if (current) { navigate({ kind: 'player' }); if (status !== 'playing' && status !== 'buffering' && status !== 'resolving') void usePlayerStore.getState().toggle() } else navigate({ kind: 'search' }) }}><Play fill="currentColor"/>{current ? status === 'playing' ? '正在播放' : '继续播放' : '寻找音乐'}</button></section>
}
function LargeQueue({ onClose, onMore }: { onClose: () => void; onMore: (t: Track) => void }) {
  const queue = usePlayerStore(s => s.queue), source = usePlayerStore(s => s.queueSource), [confirm, setConfirm] = useState(false)
  return <LargeDialog title={`播放队列 · ${queue.length}`} onClose={onClose} drawer><div className="large-queue-tools"><span>{source?.title || '当前队列'}</span><button disabled={!queue.length} onClick={() => setConfirm(true)}><Trash2/>清空</button></div><TrackRows tracks={queue} source={source} onMore={onMore}/>{!queue.length && <p className="large-empty">还没有歌曲</p>}{confirm && <LargeDialog title="清空播放队列？" onClose={() => setConfirm(false)}><div className="large-options"><button onClick={() => setConfirm(false)}>取消</button><button onClick={() => { usePlayerStore.getState().clearQueue(); setConfirm(false) }}>清空队列</button></div></LargeDialog>}</LargeDialog>
}
