import { useState, type FormEvent } from 'react'
import {
  Album,
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Clock3,
  Compass,
  Download,
  Heart,
  Home,
  Library,
  ListMusic,
  MoreHorizontal,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  Sparkles,
  Volume2,
  Waves,
} from 'lucide-react'
import { demoTracks } from '../features/library/demoTracks'
import { usePlayerStore } from '../features/player/playerStore'
import { SearchView } from '../features/search/SearchView'
import { formatDuration } from '../shared/time'

const navigation = [
  { label: '此刻', icon: Home },
  { label: '探索', icon: Compass },
  { label: '音乐库', icon: Library },
  { label: '最近播放', icon: Clock3 },
  { label: '下载', icon: Download },
  { label: '我喜欢', icon: Heart },
]

const collections = ['暮色公路', '夜航电台', '缓慢醒来', '无人售票']

export function App() {
  const [activeNav, setActiveNav] = useState('此刻')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
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

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    const normalized = query.trim()
    if (normalized) setSubmittedQuery(normalized)
  }

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
              onClick={() => setActiveNav(label)}
              title={label}
              aria-label={label}
            >
              <Icon size={20} />
            </button>
          ))}
        </nav>
        <button className="profile-button" aria-label="用户资料">山</button>
      </aside>

      <aside className="library-panel">
        <header>
          <span className="eyebrow">RESONANCE</span>
          <h1>把声音留在身边</h1>
        </header>
        <section>
          <div className="section-heading"><span>我的歌单</span><button aria-label="新建歌单">＋</button></div>
          <div className="collection-list">
            {collections.map((name, index) => (
              <button key={name} className="collection-item">
                <span className={`collection-cover tone-${index}`}><Album size={17} /></span>
                <span><strong>{name}</strong><small>{18 + index * 11} 首</small></span>
              </button>
            ))}
          </div>
        </section>
        <div className="library-footer"><Sparkles size={16} /> 独立音乐空间 · 0.1.0</div>
      </aside>

      <main className="content-stage">
        <form className="topbar" onSubmit={submitSearch}>
          <div className="history-buttons"><button type="button" onClick={() => setSubmittedQuery('')}><ArrowLeft size={18} /></button><button type="button"><ArrowRight size={18} /></button></div>
          <label className="search-field">
            <Search size={18} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索歌曲、歌手或专辑" />
          </label>
          <button type="button" className="avatar">山</button>
        </form>

        <div className="stage-scroll">
          {submittedQuery ? <SearchView query={submittedQuery} /> : <>
          <section className="hero">
            <div className="hero-orbit orbit-one" />
            <div className="hero-orbit orbit-two" />
            <div className="hero-copy">
              <span className="eyebrow coral">今日声场</span>
              <h2>让暮色慢一点</h2>
              <p>从熟悉的旋律出发，找到今晚的下一首歌。</p>
              <button className="primary-action" onClick={() => play(demoTracks[0])}><Play size={17} fill="currentColor" />开始聆听</button>
            </div>
            <div className="hero-art" aria-hidden="true"><span /><span /><span /><i /></div>
          </section>

          <section className="quick-actions">
            <button><span className="quick-icon coral-bg"><Sparkles /></span><span><strong>为你挑选</strong><small>每日更新的声音</small></span><ChevronRight /></button>
            <button><span className="quick-icon cyan-bg"><Waves /></span><span><strong>场景电台</strong><small>跟随此刻的氛围</small></span><ChevronRight /></button>
            <button><span className="quick-icon blue-bg"><ListMusic /></span><span><strong>最近加入</strong><small>回到你的收藏</small></span><ChevronRight /></button>
          </section>

          <section className="tracks-section">
            <header><div><span className="eyebrow">FOR YOU</span><h3>今天可以听这些</h3></div><button>查看全部 <ChevronRight size={16} /></button></header>
            <div className="track-table" role="table">
              <div className="track-row table-head" role="row"><span>#</span><span>歌曲</span><span>歌手</span><span>专辑</span><span>时长</span><span /></div>
              {demoTracks.map((track, index) => {
                const isCurrent = current?.id === track.id
                return (
                  <div className={isCurrent ? 'track-row current' : 'track-row'} role="row" key={track.id}>
                    <button className="row-play" onClick={() => play(track)} aria-label={`播放 ${track.title}`}>
                      {isCurrent && status === 'playing' ? <Waves size={17} /> : <><span>{index + 1}</span><Play className="hover-play" size={15} fill="currentColor" /></>}
                    </button>
                    <span className="track-title"><span className={`mini-cover tone-${index % 4}`} /> <strong>{track.title}</strong></span>
                    <span>{track.artist || '歌手未知'}</span><span>{track.album || '专辑未知'}</span><span>{formatDuration(track.durationSeconds)}</span>
                    <button className="more-button" aria-label="更多操作"><MoreHorizontal size={18} /></button>
                  </div>
                )
              })}
            </div>
          </section>
          </>}
        </div>
      </main>

      <aside className="queue-drawer" aria-hidden={!queueOpen}>
        <header><div><span className="eyebrow coral">正在播放</span><h3>接下来</h3></div><button onClick={toggleQueue} aria-label="收起队列">×</button></header>
        <div className="now-card">
          <div className="now-art"><div className="sun" /><div className="horizon" /></div>
          <div className="now-meta"><div><strong>{current?.title || '尚未播放'}</strong><small>{current?.artist || '选择一首歌开始'}</small></div><Heart size={19} className={current?.liked ? 'liked' : ''} fill={current?.liked ? 'currentColor' : 'none'} /></div>
        </div>
        <div className="queue-list">
          {queue.filter((track) => track.id !== current?.id).map((track, index) => (
            <button onClick={() => play(track)} key={track.id}><span>{index + 1}</span><span><strong>{track.title}</strong><small>{track.artist}</small></span><small>{formatDuration(track.durationSeconds)}</small></button>
          ))}
        </div>
      </aside>

      <footer className="player-dock">
        <div className="dock-track"><span className="dock-cover" /><span><strong>{current?.title || '尚未播放'}</strong><small>{current?.artist || '从音乐库选择歌曲'}</small></span></div>
        <div className="dock-center">
          <div className="dock-controls"><button onClick={previous}><SkipBack size={19} fill="currentColor" /></button><button className="play-toggle" onClick={toggle}>{status === 'playing' ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button><button onClick={next}><SkipForward size={19} fill="currentColor" /></button></div>
          <div className="progress"><small>{formatDuration(progressSeconds)}</small><input aria-label="播放进度" type="range" min="0" max={Math.max(1, durationSeconds)} value={Math.min(progressSeconds, durationSeconds || 0)} onChange={(event) => seek(Number(event.target.value))} /><small>{formatDuration(durationSeconds)}</small></div>
        </div>
        <div className="dock-tools"><Volume2 size={18} /><span className="volume"><i /></span><button className={queueOpen ? 'active' : ''} onClick={toggleQueue}><ListMusic size={19} /></button></div>
      </footer>
    </div>
  )
}
