import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Sparkles, Square } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { Track } from '../../domain/track'
import { matchTracksAutomatically, type BatchMatchProgress } from '../../services/batchMatching'
import { accountEpoch } from '../../services/accountScope'
import { accountQueryKey } from '../../services/queryKeys'
import { usePlayerStore } from '../player/playerStore'

export function BatchMatchButton({tracks}:{tracks:Track[]}) {
  const client=useQueryClient(), abort=useRef<AbortController|null>(null)
  const [busy,setBusy]=useState(false), [state,setState]=useState<BatchMatchProgress>()
  useEffect(()=>{const stop=()=>{abort.current?.abort();setBusy(false);setState(undefined)};window.addEventListener('bilimusic-account-changing',stop);return()=>{abort.current?.abort();window.removeEventListener('bilimusic-account-changing',stop)}},[])
  const run=async()=>{
    if(abort.current)return
    const controller=new AbortController(),epoch=accountEpoch();abort.current=controller;setBusy(true)
    try {await matchTracksAutomatically(tracks,controller.signal,setState,track=>{if(epoch===accountEpoch())usePlayerStore.getState().updateTrack(track)})}
    catch{/* A stopped operation retains its committed prefix and progress. */}
    finally{if(abort.current===controller){abort.current=null;if(epoch===accountEpoch()){setBusy(false);void client.invalidateQueries({queryKey:accountQueryKey('library')});void client.invalidateQueries({queryKey:accountQueryKey('playlists')})}}}
  }
  return <span className="batch-match-control"><button type="button" disabled={!busy&&!tracks.length} onClick={()=>busy?abort.current?.abort():void run()} title="同时匹配歌曲信息与歌词">{busy?<Square size={16}/>:<Sparkles size={16}/>}<span>{busy?'停止匹配':'自动匹配'}</span></button>{state&&<span className="batch-match-progress" role="status">{busy&&<LoaderCircle size={13} className="spin"/>}{busy?`${state.done}/${state.total}`:`已匹配 ${state.matched} · 跳过 ${state.skipped}${state.failed?` · 失败 ${state.failed}`:''}`}</span>}</span>
}
