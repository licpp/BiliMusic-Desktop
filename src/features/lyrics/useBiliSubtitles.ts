import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TrackSource } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage } from '../../services/desktopApi'
import { getSubtitles, getSubtitleLines } from '../../services/mediaSources'

export function useBiliSubtitles(source: TrackSource | undefined, hasLyrics: boolean, lyricsLoading: boolean) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('lyrics-subtitles') === 'true')
  const scope = source?.provider === 'bilibili' ? `${accountEpoch()}:${source.bvid}:${source.cid}` : ''
  const [override, setOverride] = useState<string>(() => sessionStorage.getItem('lyrics-subtitles-override') || '')
  const currentScope = scope && scope === override && sessionStorage.getItem('lyrics-subtitles-override') === scope
  const usable = Boolean(scope && source && source.cid > 0)
  const [selected, setSelected] = useState<{ key: string; language: string }>()
  const active = usable && enabled && (Boolean(currentScope) || (!hasLyrics && !lyricsLoading))
  const bvid = active ? source!.bvid : ''
  const cid = active ? source!.cid : 0
  const epoch = accountEpoch()
  const key = `${epoch}:${bvid}:${cid}`
  const list = useQuery({
    queryKey: ['bili-subtitles', epoch, bvid, cid],
    queryFn: () => getSubtitles(bvid, cid),
    enabled: active,
    gcTime: 0,
    retry: false,
  })
  const choices = list.data?.filter(choice => choice.language) ?? []
  const selectedChoice = selected?.key === key
    ? choices.find(choice => choice.language === selected.language)
    : undefined
  const choice = selectedChoice ?? choices.find(choice => choice.ai) ?? choices[0]
  const captions = useQuery({
    queryKey: ['bili-subtitle-lines', epoch, bvid, cid, choice?.language],
    queryFn: () => getSubtitleLines(bvid, cid, choice.language),
    enabled: active && Boolean(choice),
    gcTime: 0,
    retry: false,
  })
  const busy = active && (list.isPending || captions.isLoading)
  const error = list.error || captions.error
  let message = ''
  if (active && error) message = commandErrorMessage(error)
  else if (active && list.isSuccess && !choice) message = '这段视频暂无字幕'

  return {
    active,
    preferred: enabled,
    busy,
    choice,
    choices,
    lines: active ? captions.data : undefined,
    message,
    select: (language: string) => setSelected({ key, language }),
    toggle: () => {
      const next = !active
      const choice = next ? scope : ''
      localStorage.setItem('lyrics-subtitles', String(next))
      sessionStorage.setItem('lyrics-subtitles-override', choice)
      setOverride(choice)
      setEnabled(next)
    },
  }
}
