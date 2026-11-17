// Deterministic in-memory IPC adapter. Exercises the real TS workflows without
// network/cloud traffic; Rust tests cover the persistence and CRDT themselves.
export function importEntryCommand(state,command,args={}) {
  const stores=state.imports ||= new Map()
  const key=`${state.scope||'account:1'}:${args.playlistId}`
  const session=state.scope||'account:1'
  const snapshot=()=>({session,entries:structuredClone(stores.get(key)||[])})
  if(command==='account_session')return session
  if(command==='playlist_import_entries')return snapshot()
  if(command==='playlist_import_seed') {
    if(args.expectedSession!==session)throw Error('ACCOUNT_SESSION_EXPIRED')
    if(!stores.has(key))stores.set(key,args.rows.map(row=>({...row,playlistId:args.playlistId,entryId:`${args.playlistId}:${row.order}`,revision:'0'})))
    return snapshot()
  }
  if(command==='playlist_import_bind') {
    if(args.expectedSession!==session)throw Error('ACCOUNT_SESSION_EXPIRED')
    const before=stores.get(key)||[],next=structuredClone(before),entries=[]
    for(const change of args.changes) {
      const row=next.find(e=>e.entryId===change.entryId)
      if(!row||row.revision!==change.expectedRevision||change.mode==='automatic'&&row.trackId)throw Error('stale_bind')
      if(next.some(e=>e.entryId!==row.entryId&&e.trackId===change.track.id))throw Error('该视频已在歌单中')
      entries.push({track:change.track,originalPosition:row.order,replaceTrackId:row.trackId})
      row.trackId=change.track.id;row.revision=String(Number(row.revision)+1);row.mode=change.mode
    }
    stores.set(key,next)
    state.commits?.push({...args,entries})
    return snapshot()
  }
  return undefined
}
