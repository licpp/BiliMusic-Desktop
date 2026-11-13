import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import type { TrackSource } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage, getStoredLyrics, inDesktopShell, type LyricLine, type StoredLyrics } from '../../services/desktopApi'
import { getSubtitles, getSubtitleLines } from '../../services/mediaSources'
import { usePlayerStore } from '../player/playerStore'
import { storedLyricLines } from './lyricTimeline'

type SubtitleChoice = { language:string; label:string; ai:boolean }
type SubtitleState = {
  scope:string; active:boolean; preferred:boolean; busy:boolean; choice?:SubtitleChoice;
  choices:SubtitleChoice[]; lines?:LyricLine[]; message:string;
  select:(language:string)=>void; toggle:()=>void;
}
export function subtitleScope(source: TrackSource | undefined, epoch = accountEpoch()) {
  return source?.provider === 'bilibili' ? `${epoch}:${source.bvid}:${source.cid}` : ''
}
export const useSubtitleState = create<SubtitleState>(()=>({scope:'',active:false,preferred:false,busy:false,choices:[],message:'',select:()=>{},toggle:()=>{}}))
// One session survives closing the lyric page, and feeds the page and overlays.
export function useBiliSubtitles() {
  const state = useSubtitleState()
  const source = usePlayerStore(player=>player.current?.source)
  return state.scope === subtitleScope(source) ? state : {...state,active:false,busy:false,lines:undefined,choice:undefined,choices:[],message:''}
}

export function SubtitleController() {
  const current = usePlayerStore(player=>player.current)
  const [epoch,setEpoch] = useState(accountEpoch)
  const client = useQueryClient()
  const queryKey = ['subtitle-stored-lyrics',epoch,current?.id]
  const saved = useQuery({queryKey,queryFn:()=>getStoredLyrics(current!.id),enabled:inDesktopShell&&Boolean(current),retry:false})
  useEffect(()=>{
    const change = ()=>setEpoch(accountEpoch())
    const update = (event:Event)=>{
      const lyrics=(event as CustomEvent<StoredLyrics>).detail
      if(lyrics.trackId===current?.id&&epoch===accountEpoch()) {
        const key=['subtitle-stored-lyrics',epoch,current.id]
        void client.cancelQueries({queryKey:key,exact:true})
        client.setQueryData(key,lyrics)
      }
    }
    window.addEventListener('bilimusic-account-changing',change)
    window.addEventListener('bilimusic-lyrics-updated',update)
    return()=>{window.removeEventListener('bilimusic-account-changing',change);window.removeEventListener('bilimusic-lyrics-updated',update)}
  },[client,epoch,current?.id])
  const subtitles = useSubtitleSession(current?.source,Boolean(saved.data&&storedLyricLines(saved.data).length),saved.isLoading)
  useEffect(()=>{useSubtitleState.setState({...subtitles,scope:subtitleScope(current?.source,epoch)})},[subtitles,current?.source,epoch])
  return null
}

function useSubtitleSession(source: TrackSource | undefined, hasLyrics: boolean, lyricsLoading: boolean) {
  const [enabled, setEnabled] = useState(() => localStorage.getItem('lyrics-subtitles') === 'true')
  const scope = subtitleScope(source)
  const [override, setOverride] = useState<string>(() => sessionStorage.getItem('lyrics-subtitles-override') || '')
  const currentScope = scope && scope === override && sessionStorage.getItem('lyrics-subtitles-override') === scope
  const usable = Boolean(inDesktopShell && scope && source && source.cid > 0)
  const [notice, setNotice] = useState('')
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
  useEffect(() => {
    setNotice(message)
    if (!message) return
    const timer = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [key, message, list.dataUpdatedAt, captions.errorUpdatedAt])

  return {
    active,
    preferred: enabled,
    busy,
    choice,
    choices,
    lines: active ? captions.data : undefined,
    message: message && notice === message ? notice : '',
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
