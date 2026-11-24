import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import { webcrypto } from 'node:crypto'
import {importEntryCommand} from './fixtures/import-entry-store.mjs'

globalThis.window=new EventTarget()
globalThis.__entryCommand=importEntryCommand
globalThis.__importTest={epoch:0,commits:[],search:async()=>[],details:async()=>null,scope:'profile-A',archives:new Map()}
const {outputFiles}=await build({entryPoints:['src/services/playlistImport.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
  name:'isolated-import-adapters',setup(build){
    build.onResolve({filter:/desktopApi$|accountScope$|^@tauri-apps\/api\/core$/},args=>({path:args.path,namespace:'import-test'}))
    build.onLoad({filter:/.*/,namespace:'import-test'},args=>({contents:args.path.endsWith('desktopApi')?`
      export const inDesktopShell=true;
      export const commandErrorMessage=e=>e.message||String(e);
      export const listPlaylistTracks=async()=>globalThis.__importTest.tracks||[];
      export const searchBilibili=async keyword=>({items:await globalThis.__importTest.search(keyword)});
      export const getVideoParts=bvid=>globalThis.__importTest.details(bvid);
    `:args.path.endsWith('accountScope')?`export const accountEpoch=()=>globalThis.__importTest.epoch;`:`
      export const invoke=async(command,args)=>{
        const state=globalThis.__importTest;
        if(command==='playlist_import_scope')return state.scope;
        if(command==='playlist_import_archive'){const key=state.scope+':'+args.playlistId;if(args.document){state.archives.set(key,args.document);return null}return state.archives.get(key)||null;}
        if(command==='playlist_import_bind'){
          if(state.commitWait){state.commitStarted?.();await state.commitWait;}
          return globalThis.__entryCommand(state,command,args);
        }
        const entriesResult=globalThis.__entryCommand(state,command,args);if(entriesResult!==undefined)return entriesResult;
        if(command==='playlist_import_commit'){
          if(state.commitWait){state.commitStarted?.();await state.commitWait;}
          if(args.expectedScope!==state.scope)throw new Error('wrong profile');
          state.commits.push(args);return {id:args.playlistId,trackCount:state.commits.flatMap(x=>x.entries).length};
        }
        throw new Error('unexpected command');
      };
    `,loader:'js'}))
  },
}]})
const api=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const source={sourceId:'1',title:'晴天',artists:['周杰伦'],durationSeconds:269}
const hit={bvid:'BV1GJ411x7h7',title:'周杰伦《晴天》',durationSeconds:269,uploaderName:'UP',description:'',playCount:100_000}
const detail={...hit,aid:1,coverUrl:'',uploaderId:7,parts:[{cid:123,page:1,title:'晴天',durationSeconds:269,coverUrl:''}]}
const reset=async()=>{
  api.clearPlaylistImport();window.dispatchEvent(new Event('bilimusic-account-changing'));api.usePlaylistImport.setState({job:null,scope:''})
  Object.assign(globalThis.__importTest,{epoch:0,commits:[],scope:'profile-A',commitWait:undefined,commitStarted:undefined,tracks:[],search:async()=>[hit],details:async()=>({...detail,parts:detail.parts.map(p=>({...p,cid:p.cid+(globalThis.__importTest.detailSeq++||0)}))}),detailSeq:0})
  await api.bootPlaylistImport()
}
test('一键匹配与保存，无需人工确认，且保存真实CID与来源歌手',async()=>{
  await reset();api.newPlaylistImport({source:'text',name:'歌单',songs:[source]},'歌单')
  await api.runPlaylistImport()
  const job=api.usePlaylistImport.getState().job
  assert.equal(job.state,'done');assert.equal(job.rows[0].status,'saved')
  const entry=globalThis.__importTest.commits[0].entries[0]
  assert.equal(entry.track.cid,123);assert.equal(entry.metadata,undefined,'origin metadata belongs to the entry, not the Track');assert.equal(entry.track.uploaderName,'UP')
})
test('a playlist import can start without crypto.randomUUID', async () => {
  await reset()
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: bytes => webcrypto.getRandomValues(bytes) } })
  try {
    api.newPlaylistImport({ source: 'text', name: '歌单', songs: [source] }, '歌单')
    const job = api.usePlaylistImport.getState().job
    assert.match(job.id, /^[0-9a-f-]{36}$/)
    assert.equal(job.playlistId, `import:${job.id}`)
    assert.equal(job.state, 'ready')
  } finally { Object.defineProperty(globalThis, 'crypto', original) }
})
test('暂停后旧请求不会覆盖新任务或写入歌单',async()=>{
  await reset()
  let finish,start
  const started=new Promise(resolve=>{start=resolve})
  globalThis.__importTest.search=()=>{start();return new Promise(resolve=>{finish=resolve})}
  api.newPlaylistImport({source:'text',name:'旧歌单',songs:[source]},'旧歌单')
  const run=api.runPlaylistImport();await started
  api.pausePlaylistImport();api.newPlaylistImport({source:'text',name:'新歌单',songs:[source]},'新歌单')
  finish([hit]);await run
  assert.equal(api.usePlaylistImport.getState().job.name,'新歌单')
  assert.equal(api.usePlaylistImport.getState().job.state,'ready')
  assert.equal(globalThis.__importTest.commits.length,0)
})
test('切换账号后丢弃旧的匹配结果，不写入新账号',async()=>{
  await reset()
  let finish,start
  const started=new Promise(resolve=>{start=resolve})
  globalThis.__importTest.search=()=>{start();return new Promise(resolve=>{finish=resolve})}
  api.newPlaylistImport({source:'text',name:'歌单',songs:[source]},'歌单')
  const run=api.runPlaylistImport();await started
  globalThis.__importTest.epoch++;globalThis.__importTest.scope='profile-B'
  window.dispatchEvent(new Event('bilimusic-account-changing'))
  finish([hit]);await run
  assert.equal(api.usePlaylistImport.getState().job,null)
  assert.equal(globalThis.__importTest.commits.length,0)
})
test('持续限流保留待处理歌曲，不把整份歌单标成未找到',async()=>{
  await reset()
  globalThis.__importTest.search=async()=>{throw {message:'HTTP 412'}}
  api.newPlaylistImport({source:'text',name:'歌单',songs:[source]},'歌单')
  api.usePlaylistImport.getState().job.retries=2
  await api.runPlaylistImport()
  assert.equal(api.usePlaylistImport.getState().job.state,'paused')
  assert.equal(api.usePlaylistImport.getState().job.rows[0].status,'pending')
  assert.equal(globalThis.__importTest.commits.length,0)
})
test('暂停续导从待处理项继续，不重新匹配已经保存的歌曲',async()=>{
  await reset()
  let finish,start,calls=0
  const started=new Promise(resolve=>{start=resolve})
  globalThis.__importTest.search=()=>{
    calls++
    if(calls===2){start();return new Promise(resolve=>{finish=resolve})}
    return Promise.resolve([hit])
  }
  api.newPlaylistImport({source:'text',name:'歌单',songs:[source,{...source,sourceId:'2',title:'晴天别名',aliases:['晴天']}]},'歌单')
  const run=api.runPlaylistImport();await started
  assert.equal(api.usePlaylistImport.getState().job.rows[0].status,'saved')
  api.pausePlaylistImport();finish([hit]);await run
  assert.equal(api.usePlaylistImport.getState().job.rows[1].status,'pending')
  await api.runPlaylistImport()
  assert.equal(calls,3)
  assert.deepEqual(api.usePlaylistImport.getState().job.rows.map(row=>row.status),['saved','saved'])
})
test('未匹配歌曲选中候选后立即保存，不要求再点一次开始或继续',async()=>{
  await reset();api.newPlaylistImport({source:'text',name:'歌单',songs:[source]},'歌单')
  const job=api.usePlaylistImport.getState().job;job.state='done';job.rows[0].status='missing'
  const track={id:'bilibili:BV1GJ411x7h7:123',source:{provider:'bilibili',bvid:'BV1GJ411x7h7',cid:123,page:1},title:'晴天',durationSeconds:269,liked:false}
  await api.acceptImportCandidate(0,{track,evidence:{}})
  assert.equal(api.usePlaylistImport.getState().job.rows[0].status,'saved')
  assert.equal(globalThis.__importTest.commits.length,1)
})
test('结束导入保留已保存歌曲，未完成的请求不能重新开启任务',async()=>{
  await reset()
  let finish,start,calls=0
  const started=new Promise(resolve=>{start=resolve})
  globalThis.__importTest.search=()=>{
    if(++calls===2){start();return new Promise(resolve=>{finish=resolve})}
    return Promise.resolve([hit])
  }
  api.newPlaylistImport({source:'text',name:'歌单',songs:[source,{...source,sourceId:'2',title:'晴天别名',aliases:['晴天']}]},'歌单')
  const run=api.runPlaylistImport();await started
  assert.equal(globalThis.__importTest.commits.length,1)
  api.clearPlaylistImport();finish([hit]);await run
  assert.equal(api.usePlaylistImport.getState().job,null)
  assert.equal(globalThis.__importTest.commits.length,1)
})
test('重新匹配从已保存歌单恢复，不搜索全歌单，不保留候选，只替换指定条目',async()=>{
  await reset()
  globalThis.__importTest.search=async()=>{throw new Error('打开页面不应触发搜索')}
  const playlist={id:'import:old',name:'已导入的歌单',isSystem:false}
  const track={id:'bilibili:BV1GJ411x7h7:123',source:{provider:'bilibili',bvid:'BV1GJ411x7h7',cid:123,page:1},title:'晴天',artist:'周杰伦',album:'叶惠美',coverUrl:'https://example.com/cover.jpg',durationSeconds:269,liked:false}
  globalThis.__entryCommand(globalThis.__importTest,'playlist_import_seed',{expectedSession:'profile-A',playlistId:playlist.id,rows:[{order:0,song:source}]})
  globalThis.__importTest.imports.get('profile-A:'+playlist.id)[0].trackId=track.id
  const job=await api.loadPlaylistReview(playlist,[track],'profile-A')
  assert.equal(job.rows[0].song.title,'晴天')
  assert.deepEqual(job.rows[0].candidates,[])
  assert.equal(api.usePlaylistImport.getState().job,null)
  const replacement={...track,id:'bilibili:BV1GJ411x7h7:456',source:{...track.source,cid:456},title:'B站标题'}
  globalThis.__entryCommand(globalThis.__importTest,'playlist_import_seed',{expectedSession:'profile-A',playlistId:playlist.id,rows:[{order:0,song:source}]})
  const originalEntry=globalThis.__importTest.imports.get('profile-A:'+playlist.id)[0];originalEntry.trackId=track.id
  await api.replaceImportedPlaylistEntry(playlist,track,{track:replacement,evidence:{}},'profile-A')
  const write=globalThis.__importTest.commits[0]
  assert.equal(write.playlistId,playlist.id)
  assert.equal(write.entries[0].replaceTrackId,track.id)
  assert.equal(write.entries[0].metadata,undefined)
  assert.equal(api.usePlaylistImport.getState().job,null)
  assert.deepEqual((await api.loadPlaylistReview({...playlist,id:'playlist:normal'},[track],'profile-A')).rows,[],'a plain playlist has no inferred matching provenance')
})
test('两首流水并行且搜索统一错开，先完成后曲也不会打乱原顺序',async()=>{
  await reset()
  const resolvers=[],times=[],waiters=[]
  let active=0,peak=0
  const waitFor=n=>resolvers.length>=n?Promise.resolve():new Promise(resolve=>waiters.push({n,resolve}))
  globalThis.__importTest.search=()=>new Promise(resolve=>{
    peak=Math.max(peak,++active)
    resolvers.push(items=>{active--;resolve(items)});times.push(Date.now());waiters.filter(w=>resolvers.length>=w.n).forEach(w=>w.resolve())
  })
  const bvids=['BV1GJ411x7h7','BV1GJ411x7h8','BV1GJ411x7h9']
  globalThis.__importTest.details=async bvid=>({...detail,bvid,parts:[{...detail.parts[0],cid:123+bvids.indexOf(bvid)}]})
  api.newPlaylistImport({source:'text',name:'流水顺序',songs:[source,{...source,sourceId:'2',title:'晴天别名',aliases:['晴天']},{...source,sourceId:'3',title:'《晴天》'}]},'流水顺序')
  const run=api.runPlaylistImport();await waitFor(2)
  assert.equal(peak,2);assert.equal(resolvers.length,2)
  resolvers[1]([{...hit,bvid:bvids[1]}]);await waitFor(3)
  assert.equal(peak,2);assert.equal(globalThis.__importTest.commits.length,0)
  resolvers[2]([{...hit,bvid:bvids[2]}]);resolvers[0]([{...hit,bvid:bvids[0]}]);await run
  assert.ok(times[1]-times[0]>=2900);assert.ok(times[2]-times[1]>=2900)
  assert.equal(api.usePlaylistImport.getState().job.state,'done')
  assert.deepEqual(globalThis.__importTest.commits.flatMap(write=>write.entries.map(entry=>entry.track.cid)),[123,124,125])
})
test('手动查找逐个读取候选详情，保留可选版本',async()=>{
  await reset()
  const bvids=['BV1GJ411x7h7','BV1GJ411x7h8','BV1GJ411x7h9']
  globalThis.__importTest.search=async()=>bvids.map(bvid=>({...hit,bvid}))
  let active=0,peak=0
  const resolvers=[],waiters=[]
  const waitFor=n=>resolvers.length>=n?Promise.resolve():new Promise(resolve=>waiters.push({n,resolve}))
  globalThis.__importTest.details=bvid=>new Promise(resolve=>{
    peak=Math.max(peak,++active)
    resolvers.push(()=>{active--;resolve({...detail,bvid,parts:[{...detail.parts[0],cid:123+bvids.indexOf(bvid)}]})})
    waiters.filter(w=>resolvers.length>=w.n).forEach(w=>w.resolve())
  })
  const result=api.findImportCandidates(source,new AbortController().signal,'晴天 周杰伦')
  for(let i=0;i<3;i++){await waitFor(i+1);assert.equal(peak,1);resolvers[i]()}
  assert.deepEqual((await result).map(choice=>choice.track.source.cid),[123,124,125])
})
test('续导时批量保存超过100首的已匹配项，不漏掉剩余批次',async()=>{
  await reset()
  api.newPlaylistImport({source:'text',name:'大歌单',songs:Array.from({length:250},(_,i)=>({...source,sourceId:String(i)}))},'大歌单')
  const job=api.usePlaylistImport.getState().job
  job.rows.forEach((row,index)=>{
    const cid=index+1
    row.status='matched'
    row.chosen={track:{id:`bilibili:BV1GJ411x7h7:${cid}`,source:{provider:'bilibili',bvid:'BV1GJ411x7h7',cid,page:1},title:'晴天',durationSeconds:269,liked:false},evidence:{}}
  })
  globalThis.__importTest.search=async()=>{throw new Error('已经匹配的歌曲不应重搜')}
  await api.runPlaylistImport()
  assert.deepEqual(globalThis.__importTest.commits.map(write=>write.entries.length),[100,100,50])
  assert.ok(api.usePlaylistImport.getState().job.rows.every(row=>row.status==='saved'))
})

test('关闭活动导入后，歌单重新匹配仍包含原始未匹配项及原序号',async()=>{
 await reset()
 const songs=[source,{...source,sourceId:'missing',title:'未匹配歌曲'},{...source,sourceId:'third',title:'第三首'}]
 api.newPlaylistImport({source:'text',name:'保留原始清单',songs},'保留原始清单')
 const job=api.usePlaylistImport.getState().job
 const one={id:'bilibili:BV1GJ411x7h7:1',title:'第一首',source:{provider:'bilibili',bvid:'BV1GJ411x7h7',cid:1,page:1},durationSeconds:269,liked:false}
 const three={...one,id:'bilibili:BV1GJ411x7h7:3',title:'第三首',source:{...one.source,cid:3}}
 job.rows[0].status='saved';job.rows[0].chosen={track:one,evidence:{bvid:one.source.bvid,cid:1,title:one.title}}
 job.rows[1].status='missing';job.rows[2].status='saved';job.rows[2].chosen={track:three,evidence:{bvid:three.source.bvid,cid:3,title:three.title}}
 job.state='matching';api.pausePlaylistImport();await new Promise(setImmediate)
 api.clearPlaylistImport();await new Promise(setImmediate)
 const playlist={id:job.playlistId,name:job.name,isSystem:false}
 globalThis.__importTest.imports ||= new Map()
 globalThis.__importTest.imports.set('profile-A:'+playlist.id,job.rows.map((row,order)=>({entryId:`${playlist.id}:${order}`,playlistId:playlist.id,order,song:row.song,trackId:row.chosen?.track.id,revision:'0'})))
 const restored=await api.loadPlaylistReview(playlist,[one,three],job.scope)
 assert.equal(restored.rows.length,3);assert.equal(restored.rows[1].status,'missing');assert.equal(restored.rows[1].order,1)
 const choice={track:{...one,id:'bilibili:BV1GJ411x7h7:2',source:{...one.source,cid:2}},evidence:{bvid:one.source.bvid,cid:2,title:'补齐'}}
 const next=await api.acceptReviewCandidate(restored,1,choice)
 assert.equal(next.rows[1].status,'saved');assert.equal(globalThis.__importTest.commits.at(-1).entries[0].originalPosition,1)
})

test('复核同一活动歌单时先暂停，替换结果也更新续导档案',async()=>{
 await reset();api.newPlaylistImport({source:'text',name:'活动歌单',songs:[source]},'活动歌单')
 const job=api.usePlaylistImport.getState().job
 const track={id:'bilibili:BV1GJ411x7h7:1',title:'原视频',source:{provider:'bilibili',bvid:'BV1GJ411x7h7',cid:1,page:1},durationSeconds:269,liked:false}
 job.rows[0].status='saved';job.rows[0].chosen={track,evidence:{}}
 job.state='matching'
 globalThis.__importTest.imports ||= new Map()
 globalThis.__importTest.imports.set('profile-A:'+job.playlistId,[{entryId:`${job.playlistId}:0`,playlistId:job.playlistId,order:0,song:source,trackId:track.id,revision:'0'}])
 const review=await api.loadPlaylistReview({id:job.playlistId,name:job.name,isSystem:false},[track],job.scope)
 assert.equal(api.usePlaylistImport.getState().job.state,'paused')
 const replacement={...track,id:'bilibili:BV1GJ411x7h7:2',source:{...track.source,cid:2}}
 await api.acceptReviewCandidate(review,0,{track:replacement,evidence:{}})
 assert.equal(api.usePlaylistImport.getState().job.rows[0].chosen.track.id,replacement.id)
 assert.equal(api.usePlaylistImport.getState().job.state,'paused')
})

test('打开复核会等待在途保存并重读条目，不把刚保存的歌曲当作移除',async()=>{
 await reset();api.newPlaylistImport({source:'text',name:'正在保存',songs:[source]},'正在保存')
 let release,started
 globalThis.__importTest.commitWait=new Promise(resolve=>release=resolve)
 const entered=new Promise(resolve=>started=resolve);globalThis.__importTest.commitStarted=started
 const run=api.runPlaylistImport();await entered
 const job=api.usePlaylistImport.getState().job
 const chosen=job.rows[0].chosen.track
 globalThis.__importTest.tracks=[chosen]
 let completed=false
 const pending=api.loadPlaylistReview({id:job.playlistId,name:job.name,isSystem:false},[],job.scope).then(value=>{completed=true;return value})
 await new Promise(setImmediate);assert.equal(completed,false)
 release();const review=await pending;await run
 assert.equal(review.rows.length,1);assert.equal(review.rows[0].status,'saved');assert.equal(review.rows[0].chosen.track.id,chosen.id)
})

test('重复搜索复用成功结果，自动匹配比较有上限的候选详情',async()=>{
 await reset();let searches=0,details=0
 globalThis.__importTest.search=async()=>{searches++;return [hit,{...hit,bvid:'BV1GJ411x7h8'},{...hit,bvid:'BV1GJ411x7h9'}]}
 globalThis.__importTest.details=async()=>{details++;return detail}
 for(let i=0;i<2;i++){api.newPlaylistImport({source:'text',name:'复用搜索',songs:[source]},'复用搜索');await api.runPlaylistImport()}
 assert.equal(searches,1);assert.equal(details,6,'each match compares at most three candidates before accepting a result')
 assert.equal(globalThis.__importTest.commits.length,2)
})

test('间歇性限流不会被单首成功清零；冷却期间继续操作也不会立即请求',async t=>{
 await reset();t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()})
 let calls=0
 globalThis.__importTest.search=async()=>{if(++calls!==2)throw {message:'B站提示限制搜索'};return [hit]}
 const flush=()=>new Promise(setImmediate)
 try{
  api.newPlaylistImport({source:'text',name:'限流续导',songs:[source,{...source,sourceId:'2',title:'晴天别名',aliases:['晴天']}]},'限流续导')
  const run=api.runPlaylistImport();await flush()
  assert.equal(calls,1);assert.equal(api.usePlaylistImport.getState().job.state,'waiting')
  assert.equal(api.usePlaylistImport.getState().job.retries,1)
  t.mock.timers.tick(120_000);await flush()
  assert.equal(calls,2);assert.equal(api.usePlaylistImport.getState().job.rows[0].status,'saved')
  assert.equal(api.usePlaylistImport.getState().job.retries,1,'one successful song cannot erase the limit history')
  t.mock.timers.tick(6000);await flush();assert.equal(calls,3)
  assert.equal(api.usePlaylistImport.getState().job.retries,2)
  t.mock.timers.tick(300_000);await flush();await run
  assert.equal(calls,4);assert.equal(api.usePlaylistImport.getState().job.state,'paused')
  const job=api.usePlaylistImport.getState().job
  assert.ok(job.retryAt>Date.now());assert.equal(job.rows[1].status,'pending')
  const resume=api.runPlaylistImport();await flush();assert.equal(calls,4)
  assert.equal(api.usePlaylistImport.getState().job.state,'waiting')
  api.pausePlaylistImport();await resume
  await assert.rejects(api.findImportCandidates({...source,title:'另一首'},new AbortController().signal,'另一首'),/限制了搜索/)
  assert.equal(calls,4)
 }finally{api.pausePlaylistImport();t.mock.timers.reset()}
})

test('来自原生层的限流保留 Retry-After，等待期间不会自动或手动发起请求', async t => {
  await reset()
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const retryAt = now + 2500
  let calls = 0
  globalThis.__importTest.search = async () => {
    if (++calls === 1) throw { code: 'bili_rate_limited', retryAt }
    return [hit]
  }
  try {
    api.newPlaylistImport({ source:'text', name:'测试原生限流', songs:[source] }, '测试原生限流')
    await api.runPlaylistImport()
    assert.equal(api.usePlaylistImport.getState().job.state, 'paused')
    assert.equal(api.usePlaylistImport.getState().job.retryAt, retryAt)
    await api.runPlaylistImport()
    assert.equal(calls, 1)
    t.mock.timers.tick(3000)
    await new Promise(setImmediate)
    assert.equal(calls, 1)
    await api.runPlaylistImport()
    assert.equal(calls, 2)
    assert.equal(api.usePlaylistImport.getState().job.state, 'done')
  } finally { api.pausePlaylistImport(); t.mock.timers.reset() }
})
