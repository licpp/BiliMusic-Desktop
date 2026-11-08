import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getSubtitles } from '../../services/mediaSources'
import { commandErrorMessage } from '../../services/desktopApi'
import type { TrackSource } from '../../domain/track'
import { Check, ChevronLeft, LoaderCircle, X } from 'lucide-react'
import { isMobile } from '../../services/platform'
import type { LyricCandidate, StoredLyrics } from '../../services/desktopApi'
import { MobilePage } from '../../shared/MobilePage'

type Props = {
  source:TrackSource; onSubtitle:(language:string)=>Promise<void>
  title: string; artist: string; onTitle: (value: string) => void; onArtist: (value: string) => void
  loading: boolean; searched: boolean; error: string; warning: string
  candidates: LyricCandidate[]; stored: StoredLyrics | null
  onSearch: () => Promise<void>; onChoose: (candidate: LyricCandidate) => Promise<void>; onClose: () => void
  manualOpen: boolean; onManualOpen: (value: boolean) => void; manualText: string; onManualText: (value: string) => void; onImport: () => Promise<void>
}
export function LyricsChooser(p: Props) {
  const [tab,setTab]=useState<'lyrics'|'subtitles'>('lyrics')
  const subtitles=useQuery({queryKey:['bili-subtitles',p.source.bvid,p.source.cid],queryFn:()=>getSubtitles(p.source.bvid,p.source.cid),enabled:tab==='subtitles'&&p.source.provider==='bilibili',staleTime:60000})
  const tabs=p.source.provider==='bilibili'&&<div className="lyrics-source-tabs" role="tablist" aria-label="文字来源"><button role="tab" aria-selected={tab==='lyrics'} onClick={()=>setTab('lyrics')}>歌词</button><button role="tab" aria-selected={tab==='subtitles'} onClick={()=>setTab('subtitles')}>B 站字幕</button></div>
  const subtitleContent=<div className="subtitle-choices">{subtitles.isLoading?<div className="chooser-status"><LoaderCircle className="spin"/>读取字幕</div>:<>{(subtitles.error||p.error)&&<p className="inline-error">{p.error||commandErrorMessage(subtitles.error)}</p>}{subtitles.data?.map(s=><button disabled={p.loading} key={s.language} onClick={()=>void p.onSubtitle(s.language)}><span><strong>{s.label}</strong><small>{s.ai?'AI 字幕':'B 站字幕'}</small></span>{p.stored?.provider==='bilibili'&&p.stored.providerLyricId===s.language?<Check size={18}/>:<ChevronLeft className="candidate-arrow" size={18}/>}</button>)}{!subtitles.data?.length&&!subtitles.isLoading&&<p>没有可用字幕，可登录 B 站后刷新。</p>}<button disabled={subtitles.isFetching} onClick={()=>void subtitles.refetch()}>刷新字幕列表</button></>}</div>

  const search = <form className={isMobile ? 'mobile-editor mobile-lookup-fields' : 'lyric-search-form manual-search-fields'} onSubmit={event => { event.preventDefault(); if (p.title.trim()) void p.onSearch() }}>
    <div className={isMobile ? 'mobile-field-group' : 'lyric-search-fields'}><label>歌曲名<input aria-label="歌词搜索歌曲名" value={p.title} onChange={event => p.onTitle(event.target.value)} placeholder="填写正确的歌曲名"/></label><label>歌手<input aria-label="歌词搜索歌手" value={p.artist} onChange={event => p.onArtist(event.target.value)} placeholder="可选"/></label></div>
    <button className={isMobile ? 'mobile-page-primary' : undefined} disabled={p.loading || !p.title.trim()}>{p.loading ? '搜索中' : '搜索歌词'}</button>
  </form>
  const results = <>
    {p.error && <p className="inline-error" role="alert">{p.error}</p>}
    {p.warning && <p className="lyrics-warning">{p.warning}</p>}
    {p.loading ? <div className="chooser-status"><LoaderCircle className="spin"/>搜索中</div> : p.candidates.length ? <div className="candidate-list">{p.candidates.map(candidate => <button key={`${candidate.provider}:${candidate.id}`} onClick={() => void p.onChoose(candidate)}>
      <span><strong>{candidate.trackName}</strong><small>{candidate.artistName || '歌手未知'} · {candidate.albumName || '专辑未知'}</small></span>
      <span>{candidate.provider === 'netease' ? '网易云 · ' : ''}{candidate.syncedLyrics ? '逐行' : '文本'}</span>
      {p.stored?.provider === candidate.provider && p.stored?.providerLyricId === String(candidate.id) ? <Check size={17}/> : <ChevronLeft className="candidate-arrow" size={17}/>}
    </button>)}</div> : !p.error && <div className="chooser-status">{p.searched ? '没有搜索到可用歌词，可以更换关键词或导入歌词。' : '确认歌曲名和歌手后搜索。'}</div>}
  </>
  const manual = <form id="manual-lyrics-form" className={isMobile ? 'mobile-editor mobile-manual-lyrics' : 'lyrics-manual-form'} onSubmit={event => { event.preventDefault(); void p.onImport() }}>
    <textarea aria-label="粘贴歌词内容" maxLength={400000} value={p.manualText} onChange={event => p.onManualText(event.target.value)} placeholder="粘贴带时间标签的 LRC，或普通文本歌词"/>
    {!isMobile && <button disabled={!p.manualText.trim()}>保存到这首歌</button>}
  </form>
  if (isMobile) return <>
    <MobilePage title="匹配歌词" onBack={p.onClose} className="mobile-lyrics-chooser">
      {tabs}{tab==='subtitles'?subtitleContent:<>{search}
      <button type="button" className="mobile-row-action" onClick={() => p.onManualOpen(true)}><span>导入 LRC / 文本歌词</span><span aria-hidden="true">›</span></button>
      {results}</>}
    </MobilePage>
    {p.manualOpen && <MobilePage title="导入歌词" onBack={() => p.onManualOpen(false)} className="mobile-manual-page" actions={<button className="mobile-page-primary" form="manual-lyrics-form" type="submit" disabled={!p.manualText.trim()}>保存</button>}>{manual}{p.error && <p className="inline-error" role="alert">{p.error}</p>}</MobilePage>}
  </>
  return <div className="lyric-chooser-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) p.onClose() }}><div className="lyric-chooser">
    <header><div><span className="eyebrow">LYRICS</span><h3>选择歌词版本</h3></div><button onClick={p.onClose} aria-label="关闭"><X/></button></header>
    {tabs}{tab==='subtitles'?subtitleContent:<>{search}<div className="lyrics-manual-tools"><button onClick={() => p.onManualOpen(!p.manualOpen)}>{p.manualOpen ? '收起导入' : '粘贴 LRC / 文本歌词'}</button></div>{p.manualOpen && manual}{results}</>}
  </div></div>
}
