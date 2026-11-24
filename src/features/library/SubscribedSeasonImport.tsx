import { useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, BookmarkPlus, Check, Layers, LoaderCircle } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { getSubscribedSeasons, importSubscribedSeasons, listCollections } from '../../services/collections'
import { commandErrorMessage, getAccountProfile } from '../../services/desktopApi'
import { importAccountSession } from '../../services/importedEntries'
import { accountKeyAt } from '../../services/queryKeys'
import { Artwork } from '../../shared/Artwork'
import { LoadMore } from '../../shared/LoadMore'

type PageRequest = { page: number; session?: string }

export function SubscribedSeasonImport({ busy, onBusyChange, onViewCollections }: {
  busy: boolean
  onBusyChange: (busy: boolean) => void
  onViewCollections: () => void
}) {
  const client = useQueryClient()
  const epoch = accountEpoch()
  const collectionsKey = accountKeyAt(epoch, 'collections')
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [completed, setCompleted] = useState<Set<string>>(() => new Set())
  const [result, setResult] = useState<number>()
  const [error, setError] = useState('')
  const saving = useRef(false)
  const account = useQuery({ queryKey: accountKeyAt(epoch, 'account'), queryFn: getAccountProfile })
  const collections = useQuery({ queryKey: collectionsKey, queryFn: listCollections, enabled: Boolean(account.data?.loggedIn) })
  const seasons = useInfiniteQuery({
    queryKey: accountKeyAt(epoch, 'bili-subscribed-seasons'),
    enabled: Boolean(account.data?.loggedIn),
    initialPageParam: { page: 1 } as PageRequest,
    queryFn: async ({ pageParam }) => {
      const session = pageParam.session ?? await importAccountSession()
      if (accountEpoch() !== epoch) throw new Error('ACCOUNT_SESSION_EXPIRED')
      const page = await getSubscribedSeasons(pageParam.page, session)
      if (accountEpoch() !== epoch) throw new Error('ACCOUNT_SESSION_EXPIRED')
      return { ...page, session }
    },
    getNextPageParam: last => last.nextPage === null ? undefined : { page: last.nextPage, session: last.session },
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
  const rows = [...new Map(seasons.data?.pages.flatMap(page => page.items.map(item => [item.reference, item] as const))).values()]
  const imported = new Set(collections.data?.items.map(item => item.bvid))
  completed.forEach(reference => imported.add(reference))
  const available = rows.filter(item => !imported.has(item.reference))
  const selected = available.filter(item => selection.has(item.reference))
  const allSelected = available.length > 0 && selected.length === available.length
  const selectable = Boolean(collections.data && account.data?.loggedIn)
  const session = seasons.data?.pages[0]?.session

  const save = async () => {
    if (!session || !selectable || selected.length === 0 || saving.current || accountEpoch() !== epoch) return
    saving.current = true
    onBusyChange(true)
    setError('')
    try {
      const count = await importSubscribedSeasons(selected, session)
      if (accountEpoch() !== epoch) return
      setCompleted(previous => new Set([...previous, ...selected.map(item => item.reference)]))
      setSelection(new Set())
      setResult(count)
      void client.invalidateQueries({ queryKey: collectionsKey })
    } catch (cause) {
      if (accountEpoch() === epoch) setError(commandErrorMessage(cause))
    } finally {
      saving.current = false
      if (accountEpoch() === epoch) onBusyChange(false)
    }
  }

  return <>
    <div className="import-body">
      {account.isPending ? <p className="import-inline-status" role="status"><LoaderCircle className="spin" size={17}/>正在检查登录状态…</p>
        : account.isError ? <button type="button" className="import-secondary" onClick={() => void account.refetch()}>登录状态读取失败，重试</button>
        : !account.data?.loggedIn ? <div className="import-empty"><Layers size={28}/><p>请先登录 B 站账号，再导入订阅合集。</p></div>
        : <>
          {rows.length > 0 && <div className="import-folder-toolbar">
            <span>选择合集</span>
            {available.length > 0 && <button type="button" disabled={busy || !selectable}
              onClick={() => setSelection(new Set(allSelected ? [] : available.map(item => item.reference)))}>
              {allSelected ? '取消全选' : seasons.hasNextPage ? '全选已加载' : '全选'}
            </button>}
          </div>}
          {seasons.isPending && <p className="import-inline-status" role="status"><LoaderCircle className="spin" size={17}/>正在读取订阅合集…</p>}
          {seasons.isError && !seasons.isFetchNextPageError && <div>
            <p className="import-error" role="alert">{commandErrorMessage(seasons.error)}</p>
            <button type="button" className="import-secondary" onClick={() => void seasons.refetch()}>重试</button>
          </div>}
          {collections.isError && <button type="button" className="import-secondary" onClick={() => void collections.refetch()}>本地收藏读取失败，重试</button>}
          <div className="import-folders import-season-list">
            {rows.map(item => {
              const saved = imported.has(item.reference)
              const checked = selection.has(item.reference) && !saved
              return <button key={item.reference} type="button" disabled={busy || saved || !selectable} aria-pressed={checked}
                data-imported={saved || undefined} onClick={() => setSelection(previous => {
                  const next = new Set(previous)
                  if (next.has(item.reference)) next.delete(item.reference)
                  else next.add(item.reference)
                  return next
                })}>
                <Artwork src={item.coverUrl} className="import-season-artwork" fallback={<Layers size={20}/>}/>
                <span><strong>{item.title || '未命名合集'}</strong>
                  <small className="import-season-meta">
                    {item.uploaderName && <span>{item.uploaderName}</span>}
                    {item.videoCount !== null && <span>{item.uploaderName && '· '}{item.videoCount} 个视频</span>}
                  </small>
                </span>
                {saved ? <small className="import-season-saved"><Check size={14} aria-hidden="true"/>已导入</small>
                  : <span className="import-selection" aria-hidden="true">{checked && <Check size={15}/>}</span>}
              </button>
            })}
          </div>
          {seasons.hasNextPage && <LoadMore key={seasons.data?.pages.length} busy={busy || seasons.isFetchingNextPage}
            automatic={!seasons.isFetchNextPageError} onLoad={() => void seasons.fetchNextPage()}
            label={seasons.isFetchNextPageError ? '重试加载更多' : '加载更多合集'}/>}
          {seasons.isSuccess && !seasons.hasNextPage && !rows.length && <p className="import-hint">还没有可导入的订阅合集。</p>}
        </>}
      {error && <p className="import-error" role="alert">{error}</p>}
    </div>
    <footer className="import-footer">
      <small role="status">{selected.length ? `已选 ${selected.length} 个合集`
        : result === undefined ? '导入到收藏' : result > 0 ? `已导入 ${result} 个合集` : '所选合集已在收藏中'}</small>
      {result !== undefined && <button type="button" className={selected.length ? 'import-secondary' : 'import-primary'}
        disabled={busy} onClick={onViewCollections}>查看收藏<ArrowRight size={16}/></button>}
      {(result === undefined || selected.length > 0) && <button type="button" className="import-primary"
        disabled={busy || !selectable || !selected.length} onClick={() => void save()}>
        {busy ? <LoaderCircle className="spin" size={17}/> : <BookmarkPlus size={17}/>}
        {busy ? '正在导入…' : '导入合集'}
      </button>}
    </footer>
  </>
}
