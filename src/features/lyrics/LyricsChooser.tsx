import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { useMatchMetadataPreference } from './useMatchMetadataPreference'
import { Check, ChevronRight, ClipboardPaste, LoaderCircle, Music2, Search, UserRound, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ActionMenu } from '../../shared/ActionMenu'
import { ListFilter } from 'lucide-react'
import { isMobile } from '../../services/platform'
import { lyricsWereCleared, type LyricCandidate, type StoredLyrics } from '../../domain/lyrics'
import { hasTimedLyrics } from '../../domain/lrc'
import { MobilePage } from '../../shared/MobilePage'
import { LyricMatchActions } from './LyricMatchActions'

type Props = {
  title: string; artist: string; onTitle: (value: string) => void; onArtist: (value: string) => void
  loading: boolean; searched: boolean; error: string; warning: string
  candidates: LyricCandidate[]; stored: StoredLyrics | null
  onSearch: () => Promise<void>; onChoose: (candidate: LyricCandidate, updateMetadata: boolean) => Promise<void>; onClose: () => void
  saving: boolean
  onClear: () => void
  manualOpen: boolean; onManualOpen: (value: boolean) => void; manualText: string; onManualText: (value: string) => void; onImport: () => Promise<void>
}
export function LyricsChooser(p: Props) {
  const [platform, setPlatform] = useState('all')
  const [updateMetadata, setUpdateMetadata] = useMatchMetadataPreference()
  const dialog = useRef<HTMLDivElement>(null)
  useOverlayDismiss(dialog, !isMobile, p.onClose)
  const manualInput = useRef<HTMLTextAreaElement>(null)
  const toggleManual = () => {
    if (p.manualOpen) { p.onManualOpen(false); return }
    flushSync(() => p.onManualOpen(true))
    manualInput.current?.focus({ preventScroll: true })
  }
  const matchActions = <LyricMatchActions key={p.stored?.writeToken} stored={p.stored} busy={p.saving} onClear={p.onClear}>
    <label className="lyric-match-option" title="同时更新歌名、歌手、专辑和封面"><input type="checkbox" aria-label="同时更新歌名、歌手、专辑和封面" checked={updateMetadata} disabled={p.saving} onChange={e => setUpdateMetadata(e.target.checked)}/><span>同时匹配歌曲信息</span></label>
  </LyricMatchActions>
  const candidates = p.candidates.filter(candidate => platform === 'all' || candidate.provider === platform)
  const tools = <div className="lyrics-lookup-tools"><ActionMenu label="筛选歌词平台" icon={<><ListFilter size={16}/><span>{platform === 'all' ? '全部平台' : platform === 'netease' ? '网易云' : platform === 'qq' ? 'QQ 音乐' : 'LRCLIB'}</span></>} sheet>
    {close => ['all', 'netease', 'qq', 'lrclib'].map(value => <button key={value} role="menuitemradio" aria-checked={platform === value} onClick={() => { setPlatform(value); close() }}>{value === 'all' ? '全部平台' : value === 'netease' ? '网易云' : value === 'qq' ? 'QQ 音乐' : 'LRCLIB'}{platform === value && <Check size={16}/>}</button>)}
  </ActionMenu><button type="button" className="lyrics-paste-action" aria-expanded={p.manualOpen} onClick={toggleManual}><ClipboardPaste size={16}/>{p.manualOpen ? '收起粘贴' : '粘贴歌词'}</button></div>
  const search = <form className={isMobile ? 'mobile-editor mobile-lookup-fields' : 'lyric-search-form manual-search-fields'} onSubmit={event => { event.preventDefault(); if (p.title.trim()) void p.onSearch() }}>
    <div className={isMobile ? 'mobile-field-group lyric-query-fields' : 'lyric-search-fields lyric-query-fields'}>
      <label className="lyric-query-field"><span className="query-field-icon"><Music2 size={17}/></span><span className="query-field-copy"><input aria-label="歌词搜索歌曲名" value={p.title} onChange={event => p.onTitle(event.target.value)} placeholder="歌曲名"/></span></label>
      <label className="lyric-query-field"><span className="query-field-icon"><UserRound size={17}/></span><span className="query-field-copy"><input aria-label="歌词搜索歌手" value={p.artist} onChange={event => p.onArtist(event.target.value)} placeholder="歌手（可选）"/></span></label>
    </div>
    <button className={`lyrics-search-submit${isMobile ? ' mobile-page-primary' : ''}`} disabled={p.loading || p.saving || !p.title.trim()}>{p.loading ? <LoaderCircle size={16} className="spin"/> : <Search size={16}/>}<span>{p.loading ? '搜索中' : '搜索歌词'}</span></button>
  </form>
  const results = <>
    {p.error && <p className="inline-error" role="alert">{p.error}</p>}
    {p.warning && <p className="lyrics-warning">{p.warning}</p>}
    {p.saving && <div className="chooser-status" role="status"><LoaderCircle className="spin"/>正在保存</div>}
    {p.loading ? <div className="chooser-status"><LoaderCircle className="spin"/>搜索中</div> : candidates.length ? <div className="candidate-list">{candidates.map(candidate => <button disabled={p.saving} key={`${candidate.provider}:${candidate.id}`} onClick={() => void p.onChoose(candidate, updateMetadata)}>
      <span><strong>{candidate.trackName}</strong><small>{candidate.artistName || '歌手未知'} · {candidate.albumName || '专辑未知'}</small></span>
      <span className="candidate-features"><small>{candidate.provider === 'netease' ? '网易云' : candidate.provider === 'qq' ? 'QQ 音乐' : 'LRCLIB'} · {hasTimedLyrics(candidate.syncedLyrics) ? '逐行' : '文本'}</small><span className="lyric-language-tags">{candidate.romanizedLyrics && <span className="lyric-language-tag romanization" title="含音译">音</span>}{candidate.translatedLyrics && <span className="lyric-language-tag translation" title="含翻译">译</span>}</span></span>
      {p.stored?.provider === candidate.provider && p.stored?.providerLyricId === String(candidate.id) ? <Check className="candidate-selected" size={17}/> : <ChevronRight className="candidate-arrow" size={17}/>}
    </button>)}</div> : !p.error && <div className="chooser-status">{p.searched ? '没有搜索到可用歌词，可以更换关键词或导入歌词。' : '确认歌曲名和歌手后搜索。'}</div>}
  </>
  const manual = <form id="manual-lyrics-form" className={isMobile ? 'mobile-editor mobile-manual-lyrics' : 'lyrics-manual-form'} onSubmit={event => { event.preventDefault(); void p.onImport() }}>
    <textarea ref={manualInput} aria-label="粘贴歌词内容" maxLength={400000} value={p.manualText} onChange={event => p.onManualText(event.target.value)} placeholder="粘贴带时间标签的 LRC，或普通文本歌词"/>
    {!isMobile && <button disabled={!p.manualText.trim()}>保存到这首歌</button>}
  </form>
  if (isMobile) return <>
    <MobilePage title={p.stored && !lyricsWereCleared(p.stored) ? '更换歌词' : '匹配歌词'} onBack={p.onClose} className="mobile-lyrics-chooser">
      {search}
      {tools}
      {matchActions}
      {results}
    </MobilePage>
    {p.manualOpen && <MobilePage title="导入歌词" onBack={() => p.onManualOpen(false)} className="mobile-manual-page" actions={<button className="mobile-page-primary" form="manual-lyrics-form" type="submit" disabled={!p.manualText.trim()}>保存</button>}>{manual}{p.error && <p className="inline-error" role="alert">{p.error}</p>}</MobilePage>}
  </>
  return <div ref={dialog} className="lyric-chooser-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) p.onClose() }}><div className="lyric-chooser">
    <header><div><span className="eyebrow">LYRICS</span><h3>选择歌词版本</h3></div><button onClick={p.onClose} aria-label="关闭"><X/></button></header>
    {search}{tools}{matchActions}{p.manualOpen && manual}{results}
  </div></div>
}
