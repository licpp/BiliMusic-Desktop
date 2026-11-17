import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {readFile} from 'node:fs/promises'
const built=await build({entryPoints:['src/domain/contentVisibility.ts'],bundle:true,write:false,format:'esm'})
const {canManageVisibility,listVisibilityOrigins,entryAllowed,trackHidden,projectSeasonRows,visibilityChange}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const fixture=JSON.parse(await readFile('tests/fixtures/content-visibility.json','utf8'))
const row=(cid,extra={})=>({id:`bilibili:BV1Wr4218772:${cid}`,source:{bvid:'BV1Wr4218772',cid,page:cid},partCount:3,sourceTitleContext:{partCount:3},title:`P${cid}`,...extra})
test('arbitrary search results cannot manage hiding; bookmarked videos and seasons can',()=>{
 const scope='video:BV1Wr4218772',saved=[{bvid:'BV1Wr4218772'}]
 assert.equal(canManageVisibility(scope,[],[row(1)]),false)
 assert.equal(canManageVisibility(scope,saved,[row(1)]),true)
 assert.equal(canManageVisibility('video:another',saved,[row(1)]),false)
 assert.equal(canManageVisibility('season:7:9',[{bvid:'season:7:9'}]),true)
 assert.equal(canManageVisibility('season:7:9',saved,[row(1)]),false)
 assert.equal(canManageVisibility(undefined,saved),false)
})
test('only followed creators unlock hiding for their own content',()=>{
 const track={...row(1),source:{...row(1).source,uploaderId:7}}
 assert.equal(canManageVisibility('video:BV1Wr4218772',[{bvid:'up:7'}],[track]),true)
 assert.equal(canManageVisibility('video:BV1Wr4218772',[{bvid:'up:8'}],[track]),false)
 assert.equal(canManageVisibility('video:another',[{bvid:'up:7'}],[track]),false)
 assert.equal(canManageVisibility('season:7:9',[{bvid:'up:7'}]),true)
 assert.equal(canManageVisibility('season:8:9',[{bvid:'up:7'}]),false)
})
test('parts inherit their bookmarked season or followed parent, not an unrelated saved video',()=>{
 const scope='video:BV1Wr4218772',season={id:9,uploaderId:7}
 assert.equal(canManageVisibility(scope,[{bvid:'season:7:9'}],[row(1)],'season:7:9'),true)
 assert.equal(canManageVisibility(scope,[{bvid:'up:7'}],[row(1)],'up:7'),true)
 assert.equal(canManageVisibility(scope,[{bvid:'up:7'}],[row(1)],'season:7:9'),true)
 assert.equal(canManageVisibility(scope,[{bvid:'another'}],[row(1)],'another'),false)
 assert.equal(canManageVisibility(scope,[{bvid:'season:7:9'}],[row(1,{sourceTitleContext:{partCount:3,season}})]),true)
})
test('removing a bookmark or following and switching accounts removes eligibility without deleting rules',()=>{
 const scope='video:BV1Wr4218772',saved=[{bvid:'BV1Wr4218772'}],rules=[visibilityChange(row(2),scope,true)]
 assert.equal(canManageVisibility(scope,saved,[row(2)]),true)
 assert.equal(canManageVisibility(scope,[],[row(2)]),false)
 assert.equal(trackHidden(row(2),scope,rules),true)
 assert.deepEqual(saved,[{bvid:'BV1Wr4218772'}]);assert.equal(rules[0].hidden,true)
})
test('an unmanaged result plays completely despite old rules, while saved contexts still skip hidden parts',()=>{
 const track=row(2),rules=[visibilityChange(track,'video:BV1Wr4218772',true)]
 const source={collectionRef:'season:7:9',visibilityManaged:false}
 assert.deepEqual(listVisibilityOrigins(track,source),[''])
 assert.equal(entryAllowed(track,listVisibilityOrigins(track,source),rules),true)
 const persisted=JSON.parse(JSON.stringify(source))
 assert.equal(entryAllowed(track,listVisibilityOrigins(track,persisted),rules),true)
 assert.deepEqual(listVisibilityOrigins(track,{...source,visibilityManaged:true}),['season:7:9'])
 assert.equal(entryAllowed(track,listVisibilityOrigins(track,{...source,visibilityManaged:true}),rules),false)
 assert.deepEqual(listVisibilityOrigins(track,{collectionRef:track.source.bvid}),['video:BV1Wr4218772'])
 assert.deepEqual(listVisibilityOrigins(track),[''])
})
test('desktop and all mobile/native players share the portable visibility fixture',()=>{
 for(const item of fixture.cases)assert.equal(entryAllowed({source:{bvid:item.bvid,cid:item.cid}},item.scopes,fixture.rules),item.allowed,JSON.stringify(item))
})
test('one visible part collapses without changing CID, original page/count or source title context',()=>{
 const parts=[row(1),row(2),row(3)],overview=row(0,{resolveParts:true})
 const rules=[2,3].map(cid=>visibilityChange(row(cid),'video:BV1Wr4218772',true))
 const projected=projectSeasonRows([overview],parts,'season:1:2',rules)
 assert.deepEqual(projected,[parts[0]]);assert.equal(projected[0].partCount,3);assert.equal(projected[0].source.page,1);assert.equal(projected[0].sourceTitleContext.partCount,3)
 const allHidden=[...rules,visibilityChange(row(1),'video:BV1Wr4218772',true)]
 assert.deepEqual(projectSeasonRows([overview],parts,'season:1:2',allHidden),[])
 assert.deepEqual(projectSeasonRows([overview],parts,'season:1:2',allHidden.map(r=>({...r,hidden:false}))),[overview])
 assert.equal(parts.length,3)
})
test('unknown expansions stay lazy and hiding every current CID does not hide a new part',()=>{
 const overview=row(0,{resolveParts:true})
 const rules=[1,2,3].map(cid=>visibilityChange(row(cid),'video:BV1Wr4218772',true))
 assert.deepEqual(projectSeasonRows([overview],[overview],'season:1:2',rules),[overview])
 assert.equal(trackHidden(row(4),'season:1:2',rules),false)
 assert.equal(trackHidden(row(4),'season:1:2',[...rules,visibilityChange(row(4),'season:1:2',true)]),true)
 const partiallyCached=[row(1)],hiddenFirst=visibilityChange(row(1),'video:BV1Wr4218772',true)
 assert.deepEqual(projectSeasonRows([overview],partiallyCached,'season:1:2',[hiddenFirst]),[overview])
 assert.deepEqual(projectSeasonRows([overview],partiallyCached,'season:1:2',[]),[overview])
})
test('explicitly saved tracks override a hidden container origin without modifying business identity',()=>{
 const track=row(2)
 assert.equal(entryAllowed(track,['season:1:2'],fixture.rules),false)
 assert.equal(entryAllowed(track,['season:1:2',''],fixture.rules),true)
 assert.equal(track.id,'bilibili:BV1Wr4218772:2')
})
test('hiding the first CID does not hide the whole known BV overview',()=>{
 const parts=[row(1),row(2),row(3)],overview={...parts[0],title:'whole video'}
 const rule=visibilityChange(row(1),'video:BV1Wr4218772',true)
 assert.deepEqual(projectSeasonRows([overview],parts,'season:1:2',[rule]),[overview])
 assert.deepEqual(projectSeasonRows([overview],parts,'season:1:2',[rule,visibilityChange(row(2),'video:BV1Wr4218772',true)]),[parts[2]])
})
test('queue persistence stores only suppressed metadata and reconstructs original order',async()=>{
 const {packQueueBase,unpackQueueBase}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
 const base=[row(1),row(2),row(3)],queue=[base[0],base[2]],packed=packQueueBase(queue,base)
 assert.deepEqual(packed.hiddenQueueTracks,[base[1]])
 assert.deepEqual(unpackQueueBase(queue,packed.queueOrder,packed.hiddenQueueTracks),base)
 assert.deepEqual(unpackQueueBase(queue),queue)
 assert.equal(unpackQueueBase([{...base[0],title:'new title'}],packed.queueOrder,packed.hiddenQueueTracks)[0].title,'new title')
})
