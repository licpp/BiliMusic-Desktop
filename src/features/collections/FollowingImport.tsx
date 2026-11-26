import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Folder, LoaderCircle, Search, UserRound, UserRoundPlus } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { changeCollection, getFollowedCreators, listCollections } from '../../services/collections'
import { commandErrorMessage, getAccountProfile } from '../../services/desktopApi'
import { importAccountSession } from '../../services/importedEntries'
import { accountKeyAt } from '../../services/queryKeys'
import { Artwork } from '../../shared/Artwork'
import { LoadMore } from '../../shared/LoadMore'
import { TouchOptions } from '../../shared/TouchOptions'

type PageRequest = { page: number; session?: string }

export function FollowingImport({ busy, onBusyChange, onDone, onLogin, manualPagination = false }: {
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onDone: (count: number) => void
  onLogin?: () => void
  manualPagination?: boolean
}) {
  const client = useQueryClient()
  const epoch = accountEpoch()
  const collectionsKey = accountKeyAt(epoch, 'collections')
  const [chosen, setChosen] = useState(new Set<number>())
  const [destination, setDestination] = useState('')
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const saving = useRef(false)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const account = useQuery({ queryKey: accountKeyAt(epoch, 'account'), queryFn: getAccountProfile })
  const enabled = Boolean(account.data?.loggedIn)
  const collections = useQuery({ queryKey: collectionsKey, queryFn: listCollections, enabled })
  const query = useInfiniteQuery({
    queryKey: accountKeyAt(epoch, 'bili-following'),
    enabled,
    initialPageParam: { page: 1 } as PageRequest,
    queryFn: async ({ pageParam }) => {
      const session = pageParam.session ?? await importAccountSession()
      if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
      const page = await getFollowedCreators(pageParam.page, session)
      if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
      return { ...page, session }
    },
    getNextPageParam: last => last.data.list?.length && last.page * 50 < last.data.total
      ? { page: last.page + 1, session: last.session } : undefined,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const rows = [...new Map(query.data?.pages.flatMap(page => (page.data.list || []).map(up => [up.mid, up] as const))).values()]
  const imported = new Set(collections.data?.items.map(item => item.bvid))
  const folders = (collections.data?.folders || []).filter(folder => folder.scope === 'creators')
  const group = folders.some(folder => folder.id === destination) ? destination : ''
  const visible = rows.filter(up => up.uname.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const available = visible.filter(up => !imported.has(`up:${up.mid}`))
  const selected = rows.filter(up => chosen.has(up.mid) && !imported.has(`up:${up.mid}`))
  const allChosen = available.length > 0 && available.every(up => chosen.has(up.mid))
  const selectable = enabled && Boolean(collections.data)
  const session = query.data?.pages[0]?.session
  const save = async () => {
    if (saving.current || !session || !selectable || !selected.length || epoch !== accountEpoch()) return
    saving.current = true
    onBusyChange(true)
    setError('')
    let count = 0
    const current = () => alive.current && epoch === accountEpoch()
    try {
      for (const up of selected) {
        if (!current()) return
        await changeCollection('importCreator', '', '', {
          bvid: `up:${up.mid}`, folderId: group, title: up.uname, coverUrl: up.face, uploaderName: up.uname,
        }, session)
        if (!current()) return
        count++
        setChosen(previous => {
          const next = new Set(previous)
          next.delete(up.mid)
          return next
        })
      }
      if (current()) onDone(count)
    } catch (cause) {
      if (current()) setError(`${count ? `已导入 ${count} 位。 ` : ''}${commandErrorMessage(cause)}`)
    } finally {
      saving.current = false
      if (current()) onBusyChange(false)
      if (epoch === accountEpoch()) {
        void client.invalidateQueries({ queryKey: collectionsKey })
      }
    }
  }

  return <>
    <div className="import-body">
      {account.isPending ? <p className="import-inline-status" role="status">正在检查登录状态…</p>
        : account.isError ? <button type="button" className="import-secondary" onClick={() => void account.refetch()}>登录状态读取失败，重试</button>
        : !enabled ? <div className="import-empty"><UserRound size={28}/><p>请先登录 B 站账号，再导入关注。</p>{onLogin && <button type="button" className="import-secondary" onClick={onLogin}>前往设置</button>}</div>
        : <>
          <div className="import-folder-toolbar import-following-toolbar">
            {folders.length > 0 && <TouchOptions label="导入分组" icon={<Folder size={16}/>} selected={group}
              options={[{ value: '', label: '未分组' }, ...folders.map(folder => ({ value: folder.id, label: folder.name }))]}
              disabled={busy} onChange={setDestination}/>}
            {available.length > 0 && <button type="button" disabled={busy || !selectable} onClick={() => setChosen(previous => {
              const next = new Set(previous)
              available.forEach(up => { if (allChosen) next.delete(up.mid); else next.add(up.mid) })
              return next
            })}>{allChosen ? '取消全选' : query.hasNextPage || filter ? '全选当前结果' : '全选'}</button>}
          </div>
          {rows.length > 0 && <label className="import-review-search import-following-search">
            <span className="import-search-icon"><Search size={17}/></span>
            <input type="search" aria-label="查找已关注的 UP 主" placeholder="查找 UP 主" value={filter} onChange={event => setFilter(event.target.value)}/>
          </label>}
          {query.isPending && <p className="import-inline-status" role="status">正在读取关注…</p>}
          {query.isError && !query.isFetchNextPageError && <div>
            <p className="import-error" role="alert">{commandErrorMessage(query.error)}</p>
            <button type="button" className="import-secondary" onClick={() => void query.refetch()}>重试</button>
          </div>}
          {collections.isError && <button type="button" className="import-secondary" onClick={() => void collections.refetch()}>本地关注读取失败，重试</button>}
          <div className="import-folders import-season-list import-following-list">
            {visible.map(up => {
              const saved = imported.has(`up:${up.mid}`)
              const checked = !saved && chosen.has(up.mid)
              return <button key={up.mid} type="button" aria-pressed={checked} disabled={busy || saved || !selectable} data-imported={saved || undefined}
                onClick={() => setChosen(previous => {
                  const next = new Set(previous)
                  if (next.has(up.mid)) next.delete(up.mid)
                  else next.add(up.mid)
                  return next
                })}>
                <Artwork src={up.face} className="import-following-artwork" fallback={<UserRound size={20}/>}/>
                <span><strong>{up.uname}</strong>{up.sign && <small className="import-following-sign">{up.sign}</small>}</span>
                {saved ? <small className="import-season-saved"><Check size={14} aria-hidden="true"/>已关注</small>
                  : <span className="import-selection" aria-hidden="true">{checked && <Check size={15}/>}</span>}
              </button>
            })}
          </div>
          {query.hasNextPage && <LoadMore key={query.data?.pages.length} busy={busy || query.isFetchingNextPage}
            automatic={!manualPagination && !query.isFetchNextPageError} onLoad={() => void query.fetchNextPage()}
            label={query.isFetchNextPageError ? '重试加载更多' : '加载更多关注'}/>}
          {query.isSuccess && !visible.length && <p className="import-hint">{filter ? '没有找到匹配的 UP 主。' : '还没有可导入的关注。'}</p>}
        </>}
      {error && <p className="import-error" role="alert">{error}</p>}
    </div>
    <footer className="import-footer">
      <small role="status">{selected.length ? `已选择 ${selected.length} 位 UP 主` : '导入到关注'}</small>
      <button type="button" className="import-primary" disabled={busy || !selectable || !selected.length} onClick={() => void save()}>
        {busy ? <LoaderCircle className="spin" size={16}/> : <UserRoundPlus size={16}/>}
        {busy ? '正在导入…' : '导入关注'}
      </button>
    </footer>
  </>
}
