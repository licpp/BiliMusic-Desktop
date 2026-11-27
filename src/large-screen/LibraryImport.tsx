import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FolderHeart, Layers, UserRoundPlus } from 'lucide-react'
import { FollowingImport } from '../features/collections/FollowingImport'
import { FavoriteFolderImport } from '../features/library/FavoriteFolderImport'
import { SubscribedSeasonImport } from '../features/library/SubscribedSeasonImport'
import { accountEpoch } from '../services/accountScope'
import { commandErrorMessage, listPlaylists } from '../services/desktopApi'
import { accountKeyAt } from '../services/queryKeys'
import { LargeDialog } from './LargeDialog'
import type { LibraryTab, Navigate } from './Library'

const entries = {
  playlists: { title: '导入 B 站收藏夹', Icon: FolderHeart },
  collections: { title: '导入 B 站订阅合集', Icon: Layers },
  creators: { title: '导入 B 站关注', Icon: UserRoundPlus },
}

export function LargeLibraryImport({ scope, navigate, onViewCollections, onImported }: {
  scope: LibraryTab
  navigate: Navigate
  onViewCollections: () => void
  onImported: (message: string) => void
}) {
  const client = useQueryClient()
  const { title, Icon } = entries[scope]
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const close = () => {
    revision.current++
    setOpen(false)
    setBusy(false)
    setError('')
  }
  useEffect(() => {
    const reset = () => { close(); onImported('') }
    window.addEventListener('bilimusic-account-changing', reset)
    return () => {
      revision.current++
      window.removeEventListener('bilimusic-account-changing', reset)
    }
  }, [onImported])
  const openPlaylist = async (id: string) => {
    const epoch = accountEpoch(), request = revision.current
    const current = () => epoch === accountEpoch() && request === revision.current
    setError('')
    try {
      const playlists = await client.fetchQuery({ queryKey: accountKeyAt(epoch, 'playlists'), queryFn: listPlaylists, staleTime: 0 })
      if (!current()) return
      const playlist = playlists.find(item => item.id === id)
      if (!playlist) throw new Error('暂时无法打开歌单，请返回列表查看。')
      close()
      navigate({ kind: 'playlist', playlist })
    } catch (cause) {
      if (current()) setError(commandErrorMessage(cause))
    }
  }
  const login = () => { close(); navigate({ kind: 'settings' }) }

  return <>
    <button type="button" className="large-library-import" data-focus={`library-import-${scope}`} onClick={() => {
      onImported('')
      setOpen(true)
    }}><Icon size={22}/><span>{title}</span></button>
    {open && <LargeDialog title={title} className="large-library-import-dialog" onClose={() => {
      if (!busy || scope === 'playlists') close()
    }}>
      {error && <p className="import-error" role="alert">{error}</p>}
      {scope === 'playlists' && <FavoriteFolderImport busy={busy} onBusyChange={setBusy} onStop={close} onLogin={login} onImported={id => void openPlaylist(id)}/>}
      {scope === 'collections' && <SubscribedSeasonImport busy={busy} onBusyChange={setBusy} onLogin={login} manualPagination
        onViewCollections={() => { onViewCollections(); close() }}/>}
      {scope === 'creators' && <FollowingImport busy={busy} onBusyChange={setBusy} onLogin={login} manualPagination
        onDone={count => { onImported(`已导入 ${count} 位 UP 主`); close() }}/>}
    </LargeDialog>}
  </>
}
