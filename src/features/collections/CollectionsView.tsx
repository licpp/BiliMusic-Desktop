import { accountQueryKey } from '../../services/queryKeys'
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query'
import { ChevronDown,ChevronRight,Folder,Search,X } from 'lucide-react'
import { useState } from 'react'
import { accountEpoch } from '../../services/accountScope'
import { changeCollection,listCollections,type Collection } from '../../services/collections'
import { commandErrorMessage } from '../../services/desktopApi'
import type { Playlist } from '../../domain/library'
import { rankList,sortList } from '../../services/listOrdering'
import { useListPreferences } from '../../services/listPreferences'
import { parseSeasonReference } from '../../services/mediaSources'
import { isMobile } from '../../services/platform'
import { Artwork } from '../../shared/Artwork'
import { ListSort,useListSort } from '../../shared/ListSort'
import { useCompactLayout } from '../../shared/useCompactLayout'
import { useOrganizer } from '../../shared/useOrganizer'
import { LibraryEntry } from '../library/LibraryEntry'
import { PlaylistEntry } from '../library/PlaylistEntry'
import { FolderEditor,FolderMenu } from './CollectionFolderControls'
import { CollectionMenu } from './CollectionMenu'

const useCollections = () => useQuery({ queryKey: accountQueryKey('collections'), queryFn: listCollections })
type CollectionInfo = Omit<Collection, 'folderId'>

export function CollectionsView({ hideHeading = false, sidebar = false, folderId, linkedFolders = [], onOpenFolder, onOpenLinked, onLinkedRemoved, onSelect, onFolderRemoved }: {
  sidebar?: boolean
  hideHeading?: boolean
  folderId?: string
  linkedFolders?: Playlist[]
  onOpenFolder: (id: string) => void
  onOpenLinked: (id: string) => void
  onLinkedRemoved: (id: string) => void
  onSelect: (item: Collection) => void
  onFolderRemoved?: (id: string) => void
}) {
  const query = useCollections()
  const client = useQueryClient()
  const [expanded, setExpanded] = useState(() => localStorage.getItem('collection-expanded') !== 'false')
  const [searchOpen, setSearchOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const refresh = () => void client.invalidateQueries({ queryKey: accountQueryKey('collections') })
  const root = folderId === undefined
  const compact = useCompactLayout()
  const preferences=useListPreferences()
  const listSort=useListSort(`collectionFolder:${folderId||''}`)
  const folders = rankList((query.data?.folders || []).filter(f=>f.scope!=='creators'),preferences.data?.preferences||[],f=>`collectionFolder:${f.id}`)
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
  const rawItems = query.data?.items.filter(item => !item.bvid.startsWith('up:')) || []
  const items=root?rankList(rawItems,preferences.data?.preferences||[],i=>`collection:${i.bvid}`):sortList(rawItems,listSort.rule,i=>({id:i.bvid,name:i.title,date:listSort.dates[i.bvid],playCount:listSort.playCounts[i.bvid]}))
  const organizer=useOrganizer([...folders.map(f=>({id:`collectionFolder:${f.id}`,name:f.name,group:'folders',kind:'folder' as const})),...items.filter(i=>!i.folderId).map(i=>({id:`collection:${i.bvid}`,name:i.title||i.bvid,group:'items',coverUrl:i.coverUrl}))], '整理收藏')
  const needle = filter.trim().toLowerCase()
  const matches = (value: string) => value.toLowerCase().includes(needle)
  const visibleItems = items.filter(item => (root && needle ? true : item.folderId === (folderId || '')) && matches(item.title || item.bvid))
  const folder = folders.find(item => item.id === folderId)
  const children = root ? <>
    {folders.filter(item => matches(item.name)).map(folder => {
      const contents = items.filter(item => item.folderId === folder.id)
      const onOpen = () => onOpenFolder(folder.id)
      return <LibraryEntry coverBadge="folder" key={folder.id} title={folder.name} subtitle={`${contents.length} 个收藏`} sidebar={sidebar}
        cover={<Artwork src={contents[0]?.coverUrl} adaptAspect fallback={<Folder aria-hidden="true"/>}/>}
        dropFolderId={folder.id} onOpen={onOpen}
        menu={position => <FolderMenu folder={folder} contextPosition={position} onOpen={onOpen}
          onChanged={refresh} onRemoved={() => onFolderRemoved?.(folder.id)}/>}/>
    })}
    {linkedFolders.filter(item => matches(item.name)).map(item => <PlaylistEntry
      key={item.id} playlist={item} sidebar={sidebar} onOpen={() => onOpenLinked(item.id)} onRemoved={() => onLinkedRemoved(item.id)}
    />)}
  </> : null
  const toggle = () => setExpanded(previous => {
    localStorage.setItem('collection-expanded', String(!previous))
    return !previous
  })
  const entries = <div className="collection-entries">
    {children}
    {visibleItems.map(item => {
      const title = item.title || `合集 ${item.bvid}`
      const onOpen = () => onSelect(item)
      const canMove = (root || !compact) && !move.isPending && folders.some(folder => folder.id !== item.folderId)
      return <LibraryEntry key={item.bvid} title={title} subtitle={item.uploaderName || (parseSeasonReference(item.bvid) ? '打开查看视频' : '打开查看分 P')} sidebar={sidebar}
        cover={<Artwork src={item.coverUrl} adaptAspect/>} onOpen={onOpen}
        drag={canMove && !isMobile ? { folderId: item.folderId, onMove: target => move.mutate({ item, target }) } : undefined}
        menu={position => <CollectionMenu item={item} contextPosition={position} onOpen={onOpen}/>}/>
    })}
  </div>
  if (sidebar) return <section className="collections-sidebar">
    <div className="collections-heading">
      <button type="button" className="collections-collapse" aria-expanded={expanded} onClick={toggle}>
        <span>收藏</span>{expanded ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
      </button>
      {expanded && <div className="collections-heading-actions sidebar-heading-actions library-action-rail">{organizer.controls}{!organizer.editing && <FolderEditor iconOnly action="create" onDone={refresh}/>}</div>}
    </div>
    {expanded && (organizer.editing ? organizer.editor : entries)}
    {moveError}
  </section>
  return <section className="collections-view collections-embedded">
    <div className={`collections-heading${root ? ' hub-list-toolbar' : ''}${hideHeading && root ? ' collections-tools-only' : ''}`}>
      {(!hideHeading || !root) && <h3>{folder?.name || '收藏'}</h3>}
      {hideHeading && root && <span className="hub-summary">{items.length + linkedFolders.length} 项收藏{folders.length > 0 && <small> · {folders.length} 个文件夹</small>}</span>}
      <div className={`collections-heading-actions hub-toolbar-actions${root ? ' library-action-rail' : ''}`}>
        {root && <>{organizer.controls}{!organizer.editing && <FolderEditor iconOnly action="create" onDone={refresh}/>}</>}
        <button type="button" className="collection-icon library-search-action" aria-label="搜索收藏合集" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setFilter('') }}><Search size={18}/></button>
        {!root&&folder&&<ListSort entity={`collectionFolder:${folder.id}`}/>}
        {!root && folder && <FolderMenu folder={folder} onChanged={refresh} onRemoved={() => onFolderRemoved?.(folder.id)} />}
      </div>
    </div>
    {searchOpen && <label className="collections-search detail-search"><Search size={16}/>
      <input autoFocus aria-label="搜索收藏合集" placeholder="搜索合集或收藏夹" value={filter} onChange={event => setFilter(event.target.value)}/>
      <button type="button" aria-label="关闭合集搜索" onClick={() => { setFilter(''); setSearchOpen(false) }}><X size={16}/></button>
    </label>}
    {query.error && <p className="inline-error">{commandErrorMessage(query.error)} <button className="collection-flat-button" onClick={() => void query.refetch()}>重试</button></p>}
    {!query.isLoading && !visibleItems.length && (!root || (!folders.some(item => matches(item.name)) && !linkedFolders.some(item => matches(item.name)))) &&
      <p className="collection-empty">{needle ? '没有匹配的收藏' : root ? '点击搜索结果中的书签，收藏喜欢的合集。' : '这个收藏夹还没有合集。'}</p>}
    {root&&organizer.editing?organizer.editor:entries}
    {moveError}
  </section>
}

export { CollectionBookmark } from './CollectionBookmark'
export { CollectionDetail } from './CollectionDetail'
export { CollectionMenu } from './CollectionMenu'
