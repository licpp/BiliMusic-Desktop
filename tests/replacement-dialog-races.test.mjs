import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
const compiled=await build({stdin:{contents:`export {ReplacementSearch} from './src/features/library/ReplacementDialog'`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},plugins:[{name:'controlled-panel-runtime',setup(b){
 const mods={
 react:`export const useState=(...a)=>globalThis.panelHooks.useState(...a);export const useRef=(...a)=>globalThis.panelHooks.useRef(...a);export const useEffect=(...a)=>globalThis.panelHooks.useEffect(...a);`,
 jsx:`export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='fragment'`,
 icons:`export const Check='check',ChevronDown='down',LoaderCircle='loader',Music2='music',Play='play',Search='search',X='x'`,
 playlistImport:`export const searchReplacementVideos=(...args)=>globalThis.panelApi.search(...args);export const resolveReplacementVideo=(...args)=>globalThis.panelApi.resolve(...args)`,
 importedEntries:`export const replaceImportedEntry=(...args)=>globalThis.panelApi.bind(...args);export const loadImportedEntries=(...args)=>globalThis.panelApi.load(...args)`,
 accountScope:`export const accountEpoch=()=>globalThis.panelEpoch||0`,
 desktopApi:`export const commandErrorMessage=e=>e.message||String(e)`,
 importedPlayback:`export const refreshImportedPlayback=()=>{}`,
 playerStore:`export const playbackIntent=()=>0;export const usePlayerStore={getState:()=>({play:(...args)=>globalThis.panelApi.play(...args)})}`,
 Artwork:`export const Artwork='artwork'`,CollectionDialog:`export const CollectionDialog='dialog'`,
 }
 b.onResolve({filter:/^react$/},()=>({path:'react',namespace:'panel'}))
 b.onResolve({filter:/^react\/jsx-runtime$/},()=>({path:'jsx',namespace:'panel'}))
 b.onResolve({filter:/^lucide-react$/},()=>({path:'icons',namespace:'panel'}))
 b.onResolve({filter:/\/(playlistImport|importedEntries|accountScope|desktopApi|playerStore|importedPlayback|Artwork|CollectionDialog)$/},a=>({path:a.path.split('/').at(-1),namespace:'panel'}))
 b.onLoad({filter:/.*/,namespace:'panel'},a=>({contents:mods[a.path],loader:'js'}))
}}]})
const m={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
const {ReplacementSearch}=m.exports
const item={bvid:'BV1GJ411x7h7',title:'ANOTHER_SONG_FROM_SEARCH',uploaderName:'UP',playCount:10000,durationSeconds:240,coverUrl:'cover'}
const entry={entryId:'one',playlistId:'import:test',order:0,song:{sourceId:'source1',title:'SOURCE_SONG',artists:['ARTIST']},revision:'1'}
const choice={track:{id:'bilibili:BV1GJ411x7h7:1',source:{bvid:item.bvid,cid:1},title:item.title,durationSeconds:240},evidence:{}}
function harness(props={}){
 const slots=[],effects=[];let index=0,root,currentProps={entry,session:'test',onClose(){},onSaved(){},...props}
 globalThis.panelEpoch=0
 globalThis.panelApi={search:async()=>({items:[item],page:1,pageSize:20,total:1}),resolve:async()=>[choice],bind:async()=>({session:'test',entries:[entry]}),load:async()=>({session:'test',entries:[entry]}),play:async()=>{}}
 globalThis.window=new EventTarget();globalThis.document={activeElement:null}
 globalThis.panelHooks={
  useState(initial){const i=index++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value}]},
  useRef(initial){const i=index++;if(!(i in slots))slots[i]={current:initial};return slots[i]},
  useEffect(callback,deps){const i=index++,prior=slots[i];if(!prior||!deps||deps.some((value,j)=>value!==prior.deps?.[j])){slots[i]={deps,cleanup:prior?.cleanup};effects.push(()=>{prior?.cleanup?.();slots[i].cleanup=callback()})}},
 }
 const render=next=>{if(next)currentProps={...currentProps,...next};index=0;root=ReplacementSearch(currentProps);while(effects.length)effects.shift()();return root}
 const all=(predicate,node=root)=>{if(!node||typeof node!=='object')return[];const result=predicate(node)?[node]:[];const children=node.props?.children;for(const child of Array.isArray(children)?children:[children]){if(Array.isArray(child))for(const n of child)if(n!=null)result.push(...all(predicate,n));else{}else if(child!=null)result.push(...all(predicate,child))}return result}
 const text=()=>{const walk=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':(Array.isArray(node)?node:node.props?.children?[node.props.children]:[]).flat(Infinity).map(walk).join(' ');return walk(root)}
 const get=label=>all(node=>node.props?.['aria-label']===label)[0]
 const form=()=>all(node=>node.type==='form')[0]
 return{render,get,all,text,search:()=>form().props.onSubmit({preventDefault(){}})}
}
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve()}
async function ready(props){const h=harness(props);h.render();await tick();h.render();return h}
test('manual results remain visible even when unrelated to the original song, and submitted text is sent unchanged',async()=>{
 const h=await ready();assert.ok(h.text().includes(item.title))
 let query;globalThis.panelApi.search=async(value)=>{query=value;return{items:[item],page:1,pageSize:20,total:1}}
 h.get('搜索替换视频').props.onChange({target:{value:'完全不同的搜索词'}});h.render();await h.search();h.render()
 assert.equal(query,'完全不同的搜索词');assert.ok(h.text().includes(item.title))
})
test('a stale binding refreshes its canonical revision before allowing another selection',async()=>{
 const versions=[];let attempt=0
 const h=await ready()
 globalThis.panelApi.bind=async(row)=>{versions.push(row.revision);if(++attempt===1)throw Error('导入条目已变化');return{session:'test',entries:[{...row,trackId:choice.track.id}]}}
 globalThis.panelApi.load=async()=>({session:'test',entries:[{...entry,revision:'2'}]})
 await h.get(`选择视频 ${item.title}`).props.onClick();await tick();h.render()
 assert.ok(h.text().includes('这首歌的选择已更新'))
 await h.get(`选择视频 ${item.title}`).props.onClick();await tick();h.render()
 assert.deepEqual(versions,['1','2'])
})
test('switching entry while a write is pending discards the old success callback',async()=>{
 let finish,saved=0
 const h=await ready({onSaved(){saved++}})
 globalThis.panelApi.bind=()=>new Promise(resolve=>{finish=resolve})
 const pending=h.get(`选择视频 ${item.title}`).props.onClick();await tick()
 assert.equal(typeof finish,'function')
 h.render({entry:{...entry,entryId:'two',song:{...entry.song,title:'NEXT_SONG'}}});await tick();h.render()
 finish({session:'test',entries:[entry]});await pending;await tick();h.render()
 assert.equal(saved,0);assert.ok(h.text().includes('NEXT_SONG'));assert.equal(h.text().includes('正在保存'),false)
})
test('late preview failures after a new search cannot overwrite the new panel state',async()=>{
 let fail
 const h=await ready()
 globalThis.panelApi.play=()=>new Promise((_,reject)=>{fail=reject})
 const pending=h.get(`试听 ${item.title}`).props.onClick();await tick()
 h.get('搜索替换视频').props.onChange({target:{value:'新查询'}});h.render();await h.search();h.render()
 fail(Error('OLD_PREVIEW_FAILURE'));await pending;await tick();h.render()
 assert.equal(h.text().includes('OLD_PREVIEW_FAILURE'),false)
})
test('account ABA invalidates late write failures and does not refresh canonical state for the new account',async()=>{
 let fail,loads=0
 const h=await ready()
 globalThis.panelApi.bind=()=>new Promise((_,reject)=>{fail=reject})
 globalThis.panelApi.load=async()=>{loads++;return{session:'test',entries:[entry]}}
 const pending=h.get(`选择视频 ${item.title}`).props.onClick();await tick()
 globalThis.panelEpoch=2
 fail(Error('OLD_ACCOUNT_WRITE'));await pending;await tick();h.render()
 assert.equal(loads,0);assert.equal(h.text().includes('OLD_ACCOUNT_WRITE'),false)
})
