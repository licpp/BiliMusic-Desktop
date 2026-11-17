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
