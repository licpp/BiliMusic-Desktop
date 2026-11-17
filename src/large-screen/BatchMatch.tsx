import { useState } from 'react'
import { Check, Sparkles } from 'lucide-react'
import type { Track } from '../domain/track'
import { LargeDialog } from './LargeDialog'
import { BatchMatchButton } from '../features/library/BatchMatchButton'

export function LargeBatchMatch({tracks,onClose}:{tracks:Track[];onClose:()=>void}) {
  const [selected,setSelected]=useState<Set<string>>(()=>new Set(tracks.map(t=>t.id)))
  return <LargeDialog title="匹配歌曲信息与歌词" onClose={onClose}><div className="large-toolbar"><button onClick={()=>setSelected(selected.size===tracks.length?new Set():new Set(tracks.map(t=>t.id)))}>{selected.size===tracks.length?'取消全选':'全选'}</button><BatchMatchButton tracks={tracks.filter(t=>selected.has(t.id))}/></div><div className="large-action-list">{tracks.map(track=><button key={track.id} role="checkbox" aria-checked={selected.has(track.id)} onClick={()=>setSelected(old=>{const next=new Set(old);if(next.has(track.id))next.delete(track.id);else next.add(track.id);return next})}>{selected.has(track.id)?<Check/>:<Sparkles/>}<span>{track.displayTitle||track.title}</span></button>)}</div></LargeDialog>
}
