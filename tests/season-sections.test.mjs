import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const output=await build({stdin:{contents:"export * from './src/domain/seasonSections';export * from './src/services/listOrdering';export {SeasonSections} from './src/shared/SeasonSections'",resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',external:['react','react/jsx-runtime'],loader:{'.css':'empty'},jsx:'automatic'})
const module={exports:{}}
new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
const {filterSeasonSection,selectedSeasonSection,sortTracks,SeasonSections}=module.exports
const {renderToStaticMarkup}=await import('react-dom/server')
const {createElement}=await import('react')
const sections=[{id:'90',title:'西汉',bvids:['B','A']},{id:'10',title:'汉末三国',bvids:['C']}]
const row=(id,bvid,page=1)=>({id,title:id,source:{bvid,page}})
const tracks=[row('A1','A'),row('B1','B'),row('B2','B',2),row('C1','C'),row('X1','X')]
test('selection uses original section order and keeps every part of a video',()=>{
 assert.deepEqual(filterSeasonSection(tracks,sections,'90').map(t=>t.id),['B1','B2','A1'])
 assert.deepEqual(filterSeasonSection(tracks,sections,'10').map(t=>t.id),['C1'])
 assert.deepEqual(tracks.map(t=>t.id),['A1','B1','B2','C1','X1'])
 assert.deepEqual(sections[0].bvids,['B','A'])
})
test('all/unknown sections and old catalogs keep all tracks without data loss',()=>{
 for(const [data,id] of [[sections,undefined],[sections,'removed'],[undefined,'90'],[[],undefined],[sections.slice(0,1),'90']])assert.equal(filterSeasonSection(tracks,data,id),tracks)
 assert.equal(selectedSeasonSection(sections,'removed'),undefined)
 const empty=[...sections,{id:'empty',title:'空分类',bvids:['removed']}]
 assert.deepEqual(filterSeasonSection(tracks,empty,'empty'),[])
 assert.deepEqual(filterSeasonSection(tracks,[{...sections[0],bvids:['B','B','removed']},sections[1]],'90').map(t=>t.id),['B1','B2'])
})
test('sorting and searching operate inside the selected category without losing default order',()=>{
 const selected=filterSeasonSection(tracks,sections,'90')
 assert.equal(sortTracks(selected,'source:asc',{}),selected)
 assert.deepEqual(sortTracks(selected,'source:desc',{}).map(t=>t.id),['A1','B1','B2'])
 assert.deepEqual(sortTracks(selected,'name:asc',{}).map(t=>t.id),['A1','B1','B2'])
 assert.deepEqual(selected.filter(t=>t.title.includes('B')).map(t=>t.id),['B1','B2'])
})
test('picker hides a lone default category and exposes selection with native focusable buttons',()=>{
 const render=(data,selected)=>renderToStaticMarkup(createElement(SeasonSections,{sections:data,selected,onChange(){}}))
 assert.equal(render(undefined),'')
 assert.equal(render([]),'')
 assert.equal(render([{id:'1',title:'正片',bvids:['A']}]),'')
 const html=render(sections,'90')
 assert.ok(html.indexOf('全部')<html.indexOf('西汉')&&html.indexOf('西汉')<html.indexOf('汉末三国'))
 assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1)
 assert.match(html,/aria-pressed="true" title="西汉"/)
 assert.match(render(sections,'removed'),/aria-pressed="true" title="全部"/)
})

test('resume selects the target category even when another category was open',()=>{
 const {seasonResumeSelection}=module.exports
 const selected=seasonResumeSelection(tracks,'C1',sections,'90')
 assert.equal(selected.sectionId,'10')
 assert.deepEqual(selected.tracks.map(t=>t.id),['C1'])
 assert.equal(seasonResumeSelection(tracks,'B2',sections).sectionId,'90')
})
test('resume preserves sort order and resolved parts, including duplicate category membership',()=>{
 const {seasonResumeSelection}=module.exports
 const ordered=[tracks[2],tracks[1],tracks[0],tracks[3]]
 const duplicate=[...sections,{id:'also',title:'另一个分类',bvids:['B','A']}]
 const selected=seasonResumeSelection(ordered,'B2',duplicate,'also')
 assert.equal(selected.sectionId,'also')
 assert.deepEqual(selected.tracks.map(t=>t.id),['B2','B1','A1'])
 assert.deepEqual(ordered.map(t=>t.id),['B2','B1','A1','C1'])
})
test('uncategorized targets and lone default categories keep the complete resume queue',()=>{
 const {seasonResumeSelection}=module.exports
 for(const [data,id] of [[sections,'X1'],[undefined,'C1'],[sections.slice(0,1),'B2'],[sections,'missing']]){
  const selected=seasonResumeSelection(tracks,id,data,'90')
  assert.equal(selected.sectionId,undefined)
  assert.equal(selected.tracks,tracks)
 }
})
test('category follows the actual playable fallback rather than a hidden or removed checkpoint',()=>{
 const {seasonResumeSelection}=module.exports
 const afterHiddenCheckpoint=tracks.filter(t=>t.source.bvid!=='B')
 const selected=seasonResumeSelection(afterHiddenCheckpoint,'C1',sections,'90')
 assert.equal(selected.sectionId,'10')
 assert.deepEqual(selected.tracks.map(t=>t.id),['C1'])
})
