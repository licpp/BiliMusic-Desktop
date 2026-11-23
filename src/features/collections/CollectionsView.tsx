import { useListRows } from '../../shared/useListRows'
import { useListDataDuringNavigation, useListReveal } from '../../shared/useListMotion'
import { ListSkeleton } from '../../shared/ListSkeleton'
import { focusSearch } from '../../shared/focusSearch'
import { accountQueryKey } from '../../services/queryKeys'
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query'
import { ChevronDown,ChevronRight,Folder,ListFilter,Search,X } from 'lucide-react'
import { useRef, useState } from 'react'
import { accountEpoch } from '../../services/accountScope'
import { changeCollection,listCollections,type Collection } from '../../services/collections'
import { commandErrorMessage } from '../../services/desktopApi'
import type { Playlist } from '../../domain/library'
import { rankList,sortList } from '../../services/listOrdering'
import { useListPreferences } from '../../services/listPreferences'
import { parseSeasonReference } from '../../services/mediaSources'
import { isMobile } from '../../services/platform'
import { ListSort,useListSort } from '../../shared/ListSort'
import { useCompactLayout } from '../../shared/useCompactLayout'
import { useOrganizer } from '../../shared/useOrganizer'
import { LibraryArtworkEntry } from '../library/LibraryArtworkEntry'
import { PlaylistEntry } from '../library/PlaylistEntry'
import { HubToolbar } from '../library/HubToolbar'
import { FolderEditor,FolderMenu } from './CollectionFolderControls'
import { CollectionMenu } from './CollectionMenu'

const useCollections = () => useQuery({ queryKey: accountQueryKey('collections'), queryFn: listCollections })
type CollectionInfo = Omit<Collection, 'folderId'>

export function CollectionsView({ hideHeading = false, sidebar = false, actionsHost, folderId, linkedFolders = [], onOpenFolder, onOpenLinked, onLinkedRemoved, onSelect, onFolderRemoved }: {
  sidebar?: boolean
  hideHeading?: boolean
  actionsHost?: HTMLElement | null
  folderId?: string
  linkedFolders?: Playlist[]
  onOpenFolder: (id: string) => void
  onOpenLinked: (id: string) => void
  onLinkedRemoved: (id: string) => void
  onSelect: (item: Collection) => void
  onFolderRemoved?: (id: string) => void
}) {
  const query = useCollections()
  const visibleCollections = useListDataDuringNavigation(query.data, folderId, !sidebar)
  const loadingCollections = query.isLoading || Boolean(query.data && !visibleCollections)
  const entriesRef = useRef<HTMLDivElement>(null)
  const client = useQueryClient()
  const [expanded, setExpanded] = useState(() => localStorage.getItem('collection-expanded') !== 'false')
  const filterInput = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const refresh = () => void client.invalidateQueries({ queryKey: accountQueryKey('collections') })
  const root = folderId === undefined
  const compact = useCompactLayout()
  const preferences=useListPreferences()
  const listSort=useListSort(`collectionFolder:${folderId||''}`)
  const folders = rankList((visibleCollections?.folders || []).filter(f=>f.scope!=='creators'),preferences.data?.preferences||[],f=>`collectionFolder:${f.id}`)
  const move = useMutation({
    mutationFn: async ({ item, target }: { item: Collection; target: string }) => {
      const epoch = accountEpoch()
      await changeCollection('move', item.bvid, target)
      if (epoch === accountEpoch()) await client.invalidateQueries({ queryKey: accountQueryKey('collections') })
    },
  })
  const moveError = move.error && <button type="button" className="library-toast" role="alert" onClick={move.reset}>
    移动失败：{commandErrorMessage(move.error)}
  </button>
  const rawItems = visibleCollections?.items.filter(item => !item.bvid.startsWith('up:')) || []
  const items=root?rankList(rawItems,preferences.data?.preferences||[],i=>`collection:${i.bvid}`):sortList(rawItems,listSort.rule,i=>({id:i.bvid,name:i.title,date:listSort.dates[i.bvid],playCount:listSort.playCounts[i.bvid]}))
  const organizer=useOrganizer([...folders.map(f=>({id:`collectionFolder:${f.id}`,name:f.name,group:'folders',kind:'folder' as const})),...items.filter(i=>!i.folderId).map(i=>({id:`collection:${i.bvid}`,name:i.title||i.bvid,group:'items',coverUrl:i.coverUrl}))], '整理收藏')
  const needle = filter.trim().toLowerCase()
  const matches = (value: string) => value.toLowerCase().includes(needle)
  const visibleItems = items.filter(item => (root && needle ? true : item.folderId === (folderId || '')) && matches(item.title || item.bvid))
  const matchedFolders = root ? folders.filter(item => matches(item.name)) : []
  const matchedLinked = root ? linkedFolders.filter(item => matches(item.name)) : []
  const entriesInOrder = [
    ...matchedFolders.map(folder => ({ kind: 'folder' as const, folder })),
    ...matchedLinked.map(playlist => ({ kind: 'linked' as const, playlist })),
    ...visibleItems.map(item => ({ kind: 'item' as const, item })),
  ]
  const rendered = useListRows(entriesInOrder, `collections:${folderId ?? ''}`, { active: !sidebar || expanded })
  useListReveal(entriesRef, loadingCollections, entriesInOrder.length > 0)
  const folder = folders.find(item => item.id === folderId)
  const toggle = () => setExpanded(previous => {
    localStorage.setItem('collection-expanded', String(!previous))
    return !previous
  })
  const entries = <div ref={entriesRef} className={`collection-entries${sidebar ? '' : ' library-gallery'}`}>
    {rendered.rows.map(entry => {
      if (entry.kind === 'folder') {
        const { folder } = entry
        const contents = items.filter(item => item.folderId === folder.id)
        const onOpen = () => onOpenFolder(folder.id)
        return <LibraryArtworkEntry gallery={!sidebar} coverBadge="folder" key={`folder:${folder.id}`} title={folder.name} subtitle={`${contents.length} 个收藏`} sidebar={sidebar}
          seasonReference={contents[0]?.bvid} coverUrl={contents[0]?.coverUrl} artwork={{ fallback: <Folder aria-hidden="true"/> }}
          dropFolderId={folder.id} onOpen={onOpen}
          menu={position => <FolderMenu folder={folder} contextPosition={position} onOpen={onOpen}
            onChanged={refresh} onRemoved={() => onFolderRemoved?.(folder.id)}/>}/>
      }
      if (entry.kind === 'linked') {
        const { playlist } = entry
        return <PlaylistEntry key={`linked:${playlist.id}`} playlist={playlist} sidebar={sidebar} gallery={!sidebar}
          onOpen={() => onOpenLinked(playlist.id)} onRemoved={() => onLinkedRemoved(playlist.id)}/>
      }
      const { item } = entry
      const title = item.title || `合集 ${item.bvid}`
      const onOpen = () => onSelect(item)
      const canMove = (root || !compact) && !move.isPending && folders.some(folder => folder.id !== item.folderId)
      return <LibraryArtworkEntry gallery={!sidebar} key={item.bvid} title={title} subtitle={item.uploaderName || (parseSeasonReference(item.bvid) ? '打开查看视频' : '打开查看分 P')} sidebar={sidebar}
        seasonReference={item.bvid} coverUrl={item.coverUrl} onOpen={onOpen}
        drag={canMove && !isMobile ? { folderId: item.folderId, onMove: target => move.mutate({ item, target }) } : undefined}
        menu={position => <CollectionMenu item={item} contextPosition={position} onOpen={onOpen}/>}/>
    })}
    {rendered.more && <div ref={rendered.tail} className="list-render-tail" aria-hidden="true"/>}
  </div>
  if (sidebar) return <section className="collections-sidebar sidebar-section">
    <div className="collections-heading">
      <button type="button" className="collections-collapse" aria-expanded={expanded} onClick={toggle}>
        {expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
        <span>收藏</span>
        {entriesInOrder.length > 0 && <small className="sidebar-count">{entriesInOrder.length}</small>}
      </button>
      {expanded && <div className="collections-heading-actions sidebar-heading-actions library-action-rail">
        {organizer.editing ? organizer.controls : <>
          {organizer.canEdit && <button type="button" className="sidebar-icon-btn" title="整理收藏" aria-label="整理收藏" onClick={organizer.start}><ListFilter size={15}/></button>}
          <FolderEditor iconOnly plusIcon action="create" onDone={refresh}/>
        </>}
      </div>}
    </div>
    {expanded && (organizer.editing ? organizer.editor : entriesInOrder.length > 0 ? entries : !loadingCollections && <p className="sidebar-empty">暂无收藏</p>)}
    {moveError}
  </section>
  const actions = <div className={`collections-heading-actions hub-toolbar-actions${root ? ' library-action-rail' : ''}`}>
    {root && <>{organizer.controls}{!organizer.editing && <FolderEditor iconOnly action="create" onDone={refresh}/>}</>}
    <button type="button" className="collection-icon library-search-action" aria-label="搜索收藏合集" aria-expanded={searchOpen} onClick={() => { if (searchOpen) { setSearchOpen(false); setFilter('') } else focusSearch(() => setSearchOpen(true), filterInput) }}><Search size={18}/></button>
    {!root&&folder&&<ListSort entity={`collectionFolder:${folder.id}`}/>}
    {!root && folder && <FolderMenu folder={folder} onChanged={refresh} onRemoved={() => onFolderRemoved?.(folder.id)} />}
  </div>
  return <section className="collections-view collections-embedded">
    {hideHeading && root
      ? <HubToolbar className="collections-heading collections-tools-only" actions={actions} actionsHost={actionsHost}
        summary={visibleCollections && <>{items.length + linkedFolders.length} 项收藏{folders.length > 0 && <small> · {folders.length} 个文件夹</small>}</>}/>
      : <div className="collections-heading"><h3>{folder?.name || '收藏'}</h3>{actions}</div>}
    {searchOpen && <label className="collections-search detail-search"><Search size={16}/>
      <input ref={filterInput} aria-label="搜索收藏合集" placeholder="搜索合集或收藏夹" value={filter} onChange={event => setFilter(event.target.value)}/>
      <button type="button" aria-label="关闭合集搜索" onClick={() => { setFilter(''); setSearchOpen(false) }}><X size={16}/></button>
    </label>}
    {query.error && <p className="inline-error">{commandErrorMessage(query.error)} <button className="collection-flat-button" onClick={() => void query.refetch()}>重试</button></p>}
    {loadingCollections && <ListSkeleton wide label="正在读取收藏"/>}
    {!loadingCollections && !entriesInOrder.length &&
      <p className="collection-empty">{needle ? '没有匹配的收藏' : root ? '点击搜索结果中的书签，收藏喜欢的合集。' : '这个收藏夹还没有合集。'}</p>}
    {root&&organizer.editing?organizer.editor:entries}
    {moveError}
  </section>
}

export { CollectionBookmark } from './CollectionBookmark'
export { CollectionDetail } from './CollectionDetail'
export { CollectionMenu } from './CollectionMenu'
