import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { isTauri } from '@tauri-apps/api/core'
import { accountEpoch } from '../../services/accountScope'
import { accountKeyAt } from '../../services/queryKeys'
import { listOfficialChapters, readSavedChapters, savedChaptersQuery, writeSavedChapters, type SavedChapter } from '../../services/playbackChapters'
import { chaptersWithinDuration, type PlaybackChapter } from '../../domain/playbackChapters'
import { logicalPlaybackIdentity, usePlayerStore } from '../player/playerStore'
import { useOfflinePlayback } from '../player/offlinePlayback'

function subscribeAccount(listener: () => void) {
  window.addEventListener('bilimusic-account-changing', listener)
  return () => window.removeEventListener('bilimusic-account-changing', listener)
}

export const emptyChapters: readonly PlaybackChapter[] = []

export function usePlaybackChapters(enabled: boolean) {
  const client = useQueryClient()
  const current = usePlayerStore(state => state.current)
  const identity = usePlayerStore(() => logicalPlaybackIdentity())
  const duration = usePlayerStore(state => state.durationSeconds)
  const offline = useOfflinePlayback(state => state.offline)
  const epoch = useSyncExternalStore(subscribeAccount, accountEpoch)
  const bvid = current?.source.provider === 'bilibili' ? current.source.bvid : ''
  const cid = current?.source.cid || 0
  const available = enabled && isTauri() && Boolean(bvid && cid > 0)
  const savedKey = accountKeyAt(epoch, savedChaptersQuery, bvid, cid)
  const officialKey = accountKeyAt(epoch, 'official-playback-chapters', bvid, cid)
  const official = useQuery({
    queryKey: officialKey,
    queryFn: () => listOfficialChapters({ bvid, cid }),
    enabled: available && !offline, staleTime: 5 * 60_000, retry: false,
  })
  const saved = useQuery({
    queryKey: savedKey, queryFn: () => readSavedChapters({ bvid, cid }),
    enabled: available, staleTime: 30_000, retry: false, networkMode: 'always',
  })
  useEffect(() => {
    if (!available) return
    const refresh = () => void client.invalidateQueries({ queryKey: accountKeyAt(epoch, savedChaptersQuery, bvid, cid) })
    window.addEventListener('bilimusic-library-synced', refresh)
    return () => window.removeEventListener('bilimusic-library-synced', refresh)
  }, [available, bvid, cid, client, epoch])

  const native = official.data
  const base = saved.data
  const origin = native?.length ? 'official' : base?.chapters?.length ? 'comment' : undefined
  const items = useMemo(() => chaptersWithinDuration(native?.length ? native : base?.chapters ?? emptyChapters, duration), [native, base?.chapters, duration])

  const isCurrent = useCallback(() => {
    const track = usePlayerStore.getState().current
    return epoch === accountEpoch() && identity === logicalPlaybackIdentity() && track?.source.bvid === bvid && track.source.cid === cid
  }, [bvid, cid, epoch, identity])

  const save = async (chapters: SavedChapter[] | null) => {
    if (!base || !isCurrent()) throw new Error('播放内容已切换，请重新打开章节')
    if (client.getQueryData<PlaybackChapter[]>(officialKey)?.length) throw new Error('当前视频已提供 B 站自带章节')
    if (chapters && (duration <= 0 || chapters.some(chapter => chapter.startMs >= duration * 1000))) {
      throw new Error('章节时间超出当前分 P 的时长')
    }
    const result = await writeSavedChapters({ bvid, cid }, base, chapters)
    if (epoch === accountEpoch()) {
      client.setQueryData<SavedChapterSnapshotForQuery>(savedKey, previous => !previous || previous.revision === base.revision ? result : previous)
      void client.invalidateQueries({ queryKey: savedKey })
      window.dispatchEvent(new Event('bilimusic-data-changed'))
    }
  }

  const [opener, setOpener] = useState<{ origin: HTMLElement; valid: () => boolean }>()
  const directoryOpen = Boolean(enabled && items.length && opener?.valid())
  useEffect(() => {
    if (opener && !directoryOpen) setOpener(undefined)
  }, [directoryOpen, opener])
  const close = () => {
    const restoreOpener = () => {
      if (opener?.origin.isConnected && !opener.origin.closest('[inert]')) opener.origin.focus({ preventScroll: true })
    }
    if (document.activeElement?.closest('.chapter-directory, .large-chapter-directory')) restoreOpener()
    setOpener(undefined)
    requestAnimationFrame(() => {
      const focused = document.activeElement
      if (!focused || focused === document.body || focused.closest('[inert]')) restoreOpener()
    })
  }
  const toggle = (originElement: HTMLElement) => {
    if (directoryOpen) close()
    else if (available && items.length) setOpener({ origin: originElement, valid: isCurrent })
  }
  const seek = (seconds: number) => { if (isCurrent()) usePlayerStore.getState().seek(seconds) }

  return {
    items, origin, duration, isCurrent, save, directoryOpen, close, toggle, seek,
    existingChapters: base?.chapters ?? undefined,
    canImport: available && !offline && official.isSuccess && native?.length === 0 && saved.isSuccess && duration > 0,
    canEdit: origin === 'comment' && Boolean(base && duration > 0),
  }
}

type SavedChapterSnapshotForQuery = Awaited<ReturnType<typeof readSavedChapters>>
export type PlaybackChapters = ReturnType<typeof usePlaybackChapters>
