import { invoke } from '@tauri-apps/api/core'
import type { Track } from '../domain/track'
import type { CatalogCandidate, MetadataPatch } from '../domain/library'
import type { LyricCandidate } from '../domain/lyrics'
import { candidateLines } from '../domain/lrc'
import { songTitleIdentity, songTextIdentity } from '../domain/songIdentity'
import { accountEpoch } from './accountScope'
import { getStoredLyrics, searchLyrics, searchMetadataCatalog } from './desktopApi'
import { chooseAutomaticLyrics } from '../domain/automaticLyrics'

export type BatchMatchProgress = { done:number; total:number; matched:number; skipped:number; failed:number; protected:number; unmatched:number; conflicts:number }
/** Metadata is derived from the selected lyric's identity. Catalog results may
 * enrich that identity, but never replace it with an independently ranked song. */
export function matchingMetadata(lyric:LyricCandidate, catalog:CatalogCandidate[] = []):MetadataPatch {
  const same=catalog.filter(c=>songTitleIdentity(c.trackName)===songTitleIdentity(lyric.trackName)
    && songTextIdentity(c.artistName)===songTextIdentity(lyric.artistName)
    && (!lyric.albumName || songTextIdentity(c.collectionName || '')===songTextIdentity(lyric.albumName)))
  const best=catalog.find(c=>c.trackId===`${lyric.provider}:${lyric.id}`)
    || (lyric.provider==='lrclib' && new Set(same.map(c=>songTextIdentity(c.collectionName || ''))).size===1 ? same[0] : undefined)
  return {title:lyric.trackName,artist:lyric.artistName.trim()||undefined,album:lyric.albumName.trim()||best?.collectionName||undefined,coverUrl:lyric.artworkUrl||best?.artworkUrl}
}
export async function metadataForLyric(lyric: LyricCandidate): Promise<MetadataPatch> {
  if (lyric.artworkUrl || !lyric.artistName.trim()) return matchingMetadata(lyric)
  const source = lyric.provider === 'qq' || lyric.provider === 'netease' ? lyric.provider : 'auto'
  const catalog = await searchMetadataCatalog(lyric.trackName, lyric.artistName, source).catch(() => [])
  return matchingMetadata(lyric, catalog)
}
export async function matchTracksAutomatically(tracks:Track[],signal:AbortSignal,progress:(p:BatchMatchProgress)=>void,onSaved?:(track:Track)=>void) {
  const epoch=accountEpoch(), unique=[...new Map(tracks.map(t=>[t.id,t])).values()]
  const state:BatchMatchProgress={done:0,total:unique.length,matched:0,skipped:0,failed:0,protected:0,unmatched:0,conflicts:0}
  const check=()=>{if(signal.aborted||epoch!==accountEpoch())throw new DOMException('已停止匹配','AbortError')}
  progress({...state})
  try { for(const track of unique){
    check()
    try{
      const before=await invoke<{session:string;lyricToken:string|null;protected:boolean}>('batch_match_snapshot',{trackId:track.id});check()
      if(before.protected){state.skipped++;state.protected++;continue}
      const result=await searchLyrics(track.title,track.artist,false,track.source);check()
      const lyric=chooseAutomaticLyrics(track,result.candidates)
      if(!lyric){if(result.warning)state.failed++;else{state.skipped++;state.unmatched++}continue}
      const metadata=await metadataForLyric(lyric);check()
      const saved=await invoke<boolean>('batch_match_commit',{trackId:track.id,expectedSession:before.session,expectedLyricToken:before.lyricToken,metadata,lyrics:{provider:lyric.provider,providerLyricId:String(lyric.id),rawText:lyric.syncedLyrics||lyric.plainLyrics||'',parsedJson:JSON.stringify(candidateLines(lyric))}})
      if(saved && epoch===accountEpoch())state.matched++
      check()
      if(!saved){state.skipped++;state.conflicts++;continue}
      onSaved?.({...track,...metadata,coverUrl:metadata.coverUrl||track.coverUrl,titleOverridden:true,displayTitle:metadata.title})
      try {const stored=await getStoredLyrics(track.id);check();if(stored)window.dispatchEvent(new CustomEvent('bilimusic-lyrics-updated',{detail:stored}))}catch{check()}
    }catch(error){check();state.failed++}
    finally{state.done++;if(!signal.aborted&&epoch===accountEpoch())progress({...state})}
  }
  check()
  return state
  } finally { if(state.matched && epoch===accountEpoch())window.dispatchEvent(new Event('bilimusic-data-changed')) }
}
