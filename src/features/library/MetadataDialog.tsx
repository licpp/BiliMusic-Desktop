import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { useMutation } from '@tanstack/react-query'
import { Check,ChevronDown,Image as ImageIcon,LoaderCircle,RefreshCw,RotateCcw,Sparkles,X } from 'lucide-react'
import { useEffect,useRef,useState,type FormEvent } from 'react'
import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { originalBilibiliMetadata } from '../../services/bilibiliMetadata'
import { commandErrorMessage, getVideoParts, searchMetadataCatalog, updateStoredMetadata } from '../../services/desktopApi'
import type { CatalogCandidate, CatalogSource } from '../../domain/library'
import { isMobile } from '../../services/platform'
import { ActionMenu } from '../../shared/ActionMenu'
import { Artwork } from '../../shared/Artwork'
import { MobilePage } from '../../shared/MobilePage'
import { useCompactLayout } from '../../shared/useCompactLayout'
export function MetadataDialog({ track, onClose, onSaved }: { track: Track; onClose: () => void; onSaved: (track: Track) => void }) {
  const [title, setTitle] = useState(track.title)
  const [artist, setArtist] = useState(track.artist || '')
  const [album, setAlbum] = useState(track.album || '')
  const [coverUrl, setCoverUrl] = useState(track.coverUrl || '')
  const catalogRequest = useRef(0)
  const sourceRequest = useRef(0)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState('')
  useEffect(() => () => { ++catalogRequest.current; ++sourceRequest.current }, [])
  const [catalog, setCatalog] = useState<CatalogCandidate[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const compact = useCompactLayout()
  const dialog = useRef<HTMLDivElement>(null)
  useOverlayDismiss(dialog, !isMobile, onClose)
  const [catalogSource, setCatalogSource] = useState<CatalogSource>('auto')
  const editEpoch = useRef(accountEpoch()).current
  const mutation = useMutation({ mutationFn: () => {
    if (editEpoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
    return updateStoredMetadata(track.id, { title, artist, album, coverUrl })
  }, onSuccess: saved => { if (editEpoch === accountEpoch()) onSaved(saved) } })
  const submit = (event: FormEvent) => { event.preventDefault(); if (title.trim() && !restoring) mutation.mutate() }
  const restore = async () => {
    const request = ++sourceRequest.current, epoch = accountEpoch()
    ++catalogRequest.current; setCatalogLoading(false); setRestoring(true); setRestoreError('')
    try {
      const detail = await getVideoParts(track.source.bvid, true)
      if (request !== sourceRequest.current || epoch !== accountEpoch()) return
      const original = originalBilibiliMetadata(track, detail)
      setTitle(original.title); setArtist(original.artist || ''); setAlbum(original.album || ''); setCoverUrl(original.coverUrl || '')
      setCatalogOpen(false); setCatalog([]); setSelectedCatalogId(null)
    } catch (error) { if (request === sourceRequest.current && epoch === accountEpoch()) setRestoreError(commandErrorMessage(error)) }
    finally { if (request === sourceRequest.current) setRestoring(false) }
  }
  const enrich = async (lookupTitle = title, lookupArtist = artist, source = catalogSource) => {
    if (editEpoch !== accountEpoch()) return
    const request = ++catalogRequest.current
    setCatalogOpen(true)
    if (!lookupTitle.trim()) { setCatalogLoading(false); setCatalogError('请填写用于搜索的歌曲名'); return }
    setCatalogLoading(true); setCatalogError(''); setCatalog([]); setSelectedCatalogId(null)
    try { const results = await searchMetadataCatalog(lookupTitle.trim(), lookupArtist.trim(), source, track.source); if (request !== catalogRequest.current || editEpoch !== accountEpoch()) return; setCatalog(results); if (!results.length) setCatalogError('没有匹配结果，可以调整搜索信息或切换来源') }
    catch (cause) { if (request === catalogRequest.current && editEpoch === accountEpoch()) setCatalogError(commandErrorMessage(cause)) }
    finally { if (request === catalogRequest.current && editEpoch === accountEpoch()) setCatalogLoading(false) }
  }
  const pickCatalog = (item: CatalogCandidate) => {
    ++catalogRequest.current; setCatalogLoading(false)
    setTitle(item.trackName); setArtist(item.artistName)
    if (item.collectionName) setAlbum(item.collectionName)
    if (item.artworkUrl) setCoverUrl(item.artworkUrl)
    setSelectedCatalogId(item.trackId)
  }
  const sources: {value:CatalogSource;label:string}[] = [{value:'auto',label:'全部来源'},{value:'netease',label:'网易云音乐'},{value:'qq',label:'QQ 音乐'},{value:'itunes',label:'iTunes'},{value:'musicbrainz',label:'MusicBrainz'}]
  const editor = <div className="metadata-editor-content">
    <div className="metadata-track-preview"><Artwork src={coverUrl} adaptAspect/><div><strong>{title || '歌曲名'}</strong><small>{artist || '歌手未知'}</small>{album&&<small>{album}</small>}</div></div>
    <div className="metadata-restore-row"><button className="metadata-restore-button" type="button" disabled={restoring || mutation.isPending} onClick={() => void restore()}>{restoring?<LoaderCircle size={15} className="spin"/>:<RotateCcw size={15}/>}<span>{restoring?'正在读取…':'恢复 B 站信息'}</span></button>{restoreError&&<p className="inline-error" role="alert">{restoreError}</p>}</div>
    <div className="metadata-fields"><label className="metadata-title-field">歌曲名<input aria-label="歌曲名" value={title} onChange={event=>setTitle(event.target.value)} required/></label><label>歌手<input aria-label="歌手" value={artist} onChange={event=>setArtist(event.target.value)} placeholder="歌手未知"/></label><label>专辑<input aria-label="专辑" value={album} onChange={event=>setAlbum(event.target.value)} placeholder="可选"/></label></div>
    <details className="metadata-cover-address"><summary><ImageIcon size={15}/><span>封面地址</span><ChevronDown size={14}/></summary><input aria-label="封面地址" value={coverUrl} onChange={event=>setCoverUrl(event.target.value)} placeholder="https://"/></details>
    <div className="metadata-match-toolbar"><div className="metadata-source-picker"><ActionMenu label="歌曲信息来源" sheet touchSheet={compact} panelClassName="metadata-source-menu" icon={<><span>{sources.find(item=>item.value===catalogSource)?.label}</span><ChevronDown size={14}/></>}>
      {close=><>{sources.map(item=><button type="button" role="menuitemradio" aria-checked={item.value===catalogSource} key={item.value} onClick={()=>{close();setCatalogSource(item.value);if(catalogOpen)void enrich(title,artist,item.value)}}><span>{item.label}</span>{item.value===catalogSource&&<Check size={16}/>}</button>)}</>}
    </ActionMenu></div><button className="metadata-match-button" type="button" disabled={catalogLoading||restoring||!title.trim()} onClick={()=>{(document.activeElement as HTMLElement|null)?.blur();void enrich()}}>{catalogLoading?<LoaderCircle size={16} className="spin"/>:catalogOpen?<RefreshCw size={16}/>:<Sparkles size={16}/>}<span>{catalogLoading?'正在匹配':catalogOpen?'重新匹配':'匹配歌曲信息'}</span></button></div>
    {catalogOpen&&<section className="metadata-match-results" aria-label="歌曲信息匹配结果" aria-busy={catalogLoading}>
      <header><strong>匹配结果</strong><small>{catalogLoading?'正在查找…':`${catalog.length} 个结果`}</small></header>
      {catalogError&&<p className="inline-error" role="alert">{catalogError}</p>}
      {catalog.map(item=><button type="button" key={item.trackId} className="metadata-match-result" aria-pressed={selectedCatalogId===item.trackId} onClick={()=>pickCatalog(item)}><Artwork src={item.artworkUrl}/><span><strong>{item.trackName}</strong><small>{item.artistName} · {item.collectionName||'专辑未知'}</small><span className="catalog-source-label">{item.source}</span></span>{selectedCatalogId===item.trackId&&<Check className="catalog-selected" size={18}/>}</button>)}
    </section>}
    {mutation.isError&&<p role="alert" className="inline-error">{commandErrorMessage(mutation.error)}</p>}
  </div>
  if(isMobile)return <MobilePage title="歌曲信息" onBack={onClose} className="mobile-metadata-page" actions={<button className="mobile-page-primary" type="submit" form="mobile-metadata-form" disabled={mutation.isPending||restoring||!title.trim()}>{mutation.isPending?'保存中':'保存'}</button>}><form id="mobile-metadata-form" className="metadata-editor-form" onSubmit={submit}>{editor}</form></MobilePage>
  return <div ref={dialog} className="dialog-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}><form className="metadata-dialog metadata-editor-form" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="metadata-title"><header><h3 id="metadata-title">编辑歌曲信息</h3><button type="button" onClick={onClose} aria-label="关闭"><X size={19}/></button></header>{editor}<footer><button type="button" onClick={onClose}>取消</button><button className="save-button" disabled={mutation.isPending||restoring||!title.trim()}>{mutation.isPending&&<LoaderCircle className="spin" size={15}/>}保存修改</button></footer></form></div>
}
