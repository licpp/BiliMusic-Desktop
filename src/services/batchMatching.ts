import { invoke } from '@tauri-apps/api/core'
import type { Track } from '../domain/track'
import type { CatalogCandidate, MetadataPatch } from '../domain/library'
import type { LyricCandidate } from '../domain/lyrics'
import { candidateLines } from '../domain/lrc'
import { songTitleIdentity, songTextIdentity } from '../domain/songIdentity'
import { accountEpoch } from './accountScope'
import { getStoredLyrics, searchLyrics, searchMetadataCatalog } from './desktopApi'
import { chooseAutomaticLyrics } from '../domain/automaticLyrics'

export type BatchMatchProgress = { done:number; total:number; matched:number; skipped:number; failed:number }
/** Metadata is derived from the selected lyric's identity. Catalog results may
 * enrich that identity, but never replace it with an independently ranked song. */
export function matchingMetadata(lyric:LyricCandidate, catalog:CatalogCandidate[]):MetadataPatch {
  const same=catalog.filter(c=>songTitleIdentity(c.trackName)===songTitleIdentity(lyric.trackName)
    && songTextIdentity(c.artistName)===songTextIdentity(lyric.artistName))
  const provider=(source:string)=>/qq/i.test(source)?'qq':/netease|网易/i.test(source)?'netease':source
  const best=same.find(c=>provider(c.source)===lyric.provider)||same[0]
  return {title:lyric.trackName,artist:lyric.artistName,album:best?.collectionName||lyric.albumName||undefined,coverUrl:best?.artworkUrl}
}
export async function matchTracksAutomatically(tracks:Track[],signal:AbortSignal,progress:(p:BatchMatchProgress)=>void,onSaved?:(track:Track)=>void) {
  const epoch=accountEpoch(), unique=[...new Map(tracks.map(t=>[t.id,t])).values()]
  const state:BatchMatchProgress={done:0,total:unique.length,matched:0,skipped:0,failed:0}
  const check=()=>{if(signal.aborted||epoch!==accountEpoch())throw new DOMException('已停止匹配','AbortError')}
  progress({...state})
  try { for(const track of unique){
    check()
    try{
      const before=await invoke<{session:string;lyricToken:string|null;protected:boolean}>('batch_match_snapshot',{trackId:track.id});check()
      if(before.protected){state.skipped++;continue}
      const result=await searchLyrics(track.title,track.artist);check()
      const lyric=chooseAutomaticLyrics(track,result.candidates)
      if(!lyric){state.skipped++;continue}
      // A catalog outage must not attach unrelated metadata or half-save a pair.
      const catalog=await searchMetadataCatalog(lyric.trackName,lyric.artistName);check()
      const metadata=matchingMetadata(lyric,catalog)
      const saved=await invoke<boolean>('batch_match_commit',{trackId:track.id,expectedSession:before.session,expectedLyricToken:before.lyricToken,metadata,lyrics:{provider:lyric.provider,providerLyricId:String(lyric.id),rawText:lyric.syncedLyrics||lyric.plainLyrics||'',parsedJson:JSON.stringify(candidateLines(lyric))}})
      if(saved && epoch===accountEpoch())state.matched++
      check()
      if(!saved){state.skipped++;continue}
      onSaved?.({...track,...metadata,coverUrl:metadata.coverUrl||track.coverUrl,titleOverridden:true,displayTitle:metadata.title})
      try {const stored=await getStoredLyrics(track.id);check();if(stored)window.dispatchEvent(new CustomEvent('bilimusic-lyrics-updated',{detail:stored}))}catch{check()}
    }catch(error){check();state.failed++}
    finally{state.done++;if(!signal.aborted&&epoch===accountEpoch())progress({...state})}
  }
  check()
  return state
  } finally { if(state.matched && epoch===accountEpoch())window.dispatchEvent(new Event('bilimusic-data-changed')) }
}
