import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

globalThis.window=new EventTarget()
globalThis.__importTest={epoch:0,commits:[],search:async()=>[],details:async()=>null,scope:'profile-A'}
const {outputFiles}=await build({entryPoints:['src/services/playlistImport.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
  name:'isolated-import-adapters',setup(build){
    build.onResolve({filter:/desktopApi$|accountScope$|^@tauri-apps\/api\/core$/},args=>({path:args.path,namespace:'import-test'}))
    build.onLoad({filter:/.*/,namespace:'import-test'},args=>({contents:args.path.endsWith('desktopApi')?`
      export const inDesktopShell=true;
      export const commandErrorMessage=e=>e.message||String(e);
      export const searchBilibili=async keyword=>({items:await globalThis.__importTest.search(keyword)});
      export const getVideoParts=bvid=>globalThis.__importTest.details(bvid);
    `:args.path.endsWith('accountScope')?`export const accountEpoch=()=>globalThis.__importTest.epoch;`:`
      export const invoke=async(command,args)=>{
        const state=globalThis.__importTest;
        if(command==='playlist_import_scope')return state.scope;
        if(command==='playlist_import_commit'){
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
const hit={bvid:'BV1GJ411x7h7',title:'周杰伦《晴天》',durationSeconds:269,uploaderName:'UP',description:''}
const detail={...hit,aid:1,coverUrl:'',uploaderId:7,parts:[{cid:123,page:1,title:'晴天',durationSeconds:269,coverUrl:''}]}
const reset=async()=>{
  api.clearPlaylistImport();api.usePlaylistImport.setState({job:null,scope:''})
  Object.assign(globalThis.__importTest,{epoch:0,commits:[],scope:'profile-A',search:async()=>[hit],details:async()=>detail})
  await api.bootPlaylistImport()
}
test('一键匹配与保存，无需人工确认，且保存真实CID与来源歌手',async()=>{
  await reset();api.newPlaylistImport({source:'text',name:'歌单',songs:[source]},'歌单')
  await api.runPlaylistImport()
  const job=api.usePlaylistImport.getState().job
  assert.equal(job.state,'done');assert.equal(job.rows[0].status,'saved')
  const entry=globalThis.__importTest.commits[0].entries[0]
  assert.equal(entry.track.cid,123);assert.equal(entry.metadata.artist,'周杰伦');assert.equal(entry.track.uploaderName,'UP')
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
  api.newPlaylistImport({source:'text',name:'歌单',songs:[source,{...source,sourceId:'2'}]},'歌单')
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
  api.newPlaylistImport({source:'text',name:'歌单',songs:[source,{...source,sourceId:'2'}]},'歌单')
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
  const job=api.makePlaylistReview(playlist,[track],'profile-A')
  assert.equal(job.rows[0].song.title,'晴天')
  assert.deepEqual(job.rows[0].candidates,[])
  assert.equal(api.usePlaylistImport.getState().job,null)
  const replacement={...track,id:'bilibili:BV1GJ411x7h7:456',source:{...track.source,cid:456},title:'B站标题'}
  await api.replaceImportedPlaylistEntry(playlist,track,{track:replacement,evidence:{}},'profile-A')
  const write=globalThis.__importTest.commits[0]
  assert.equal(write.playlistId,playlist.id)
  assert.equal(write.entries[0].replaceTrackId,track.id)
  assert.deepEqual(write.entries[0].metadata,{title:track.title,artist:track.artist,album:track.album,coverUrl:track.coverUrl})
  assert.equal(api.usePlaylistImport.getState().job,null)
  assert.throws(()=>api.makePlaylistReview({...playlist,id:'playlist:normal'},[track],'profile-A'))
})
test('三首并发且搜索发起错开，后完成的首曲不会让歌单顺序错乱',async()=>{
  await reset()
  const resolvers=[],times=[]
  let third
  const thirdStarted=new Promise(resolve=>{third=resolve})
  globalThis.__importTest.search=()=>new Promise(resolve=>{
    resolvers.push(resolve);times.push(Date.now());if(resolvers.length===3)third()
  })
  const bvids=['BV1GJ411x7h7','BV1GJ411x7h8','BV1GJ411x7h9']
  globalThis.__importTest.details=async bvid=>({...detail,bvid,parts:[{...detail.parts[0],cid:123+bvids.indexOf(bvid)}]})
  api.newPlaylistImport({source:'text',name:'并发顺序',songs:[source,{...source,sourceId:'2'},{...source,sourceId:'3'}]},'并发顺序')
  const run=api.runPlaylistImport();await thirdStarted
  assert.equal(resolvers.length,3)
  assert.ok(times[1]-times[0]>=1100);assert.ok(times[2]-times[1]>=1100)
  const laterCompleted=new Promise(resolve=>{
    const unsubscribe=api.usePlaylistImport.subscribe(state=>{
      if(state.job.rows[1].status==='matched'&&state.job.rows[2].status==='matched'){unsubscribe();resolve()}
    })
  })
  resolvers[2]([{...hit,bvid:bvids[2]}]);resolvers[1]([{...hit,bvid:bvids[1]}]);await laterCompleted
  assert.equal(globalThis.__importTest.commits.length,0)
  resolvers[0]([{...hit,bvid:bvids[0]}]);await run
  assert.equal(api.usePlaylistImport.getState().job.state,'done')
  assert.deepEqual(globalThis.__importTest.commits.flatMap(write=>write.entries.map(entry=>entry.track.cid)),[123,124,125])
})
test('同一首的候选详情并行解析，并发上限为三，结果不受响应顺序影响',async()=>{
  await reset()
  const bvids=['BV1GJ411x7h7','BV1GJ411x7h8','BV1GJ411x7h9']
  globalThis.__importTest.search=async()=>bvids.map(bvid=>({...hit,bvid}))
  let third,active=0,peak=0
  const resolvers=[],started=new Promise(resolve=>{third=resolve})
  globalThis.__importTest.details=bvid=>new Promise(resolve=>{
    peak=Math.max(peak,++active)
    resolvers.push(()=>{active--;resolve({...detail,bvid,parts:[{...detail.parts[0],cid:123+bvids.indexOf(bvid)}]})})
    if(resolvers.length===3)third()
  })
  const result=api.findImportCandidates(source,new AbortController().signal)
  await started;assert.equal(peak,3)
  resolvers.reverse().forEach(resolve=>resolve())
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
