import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {transform,build} from 'esbuild'
const original=await readFile('src/features/library/TrackActions.tsx','utf8')
const states=[],effects=[];let index=0,resolveSave
const track={id:'bilibili:BV1oldAccount:42',source:{provider:'bilibili',bvid:'BV1oldAccount',cid:42,page:1},title:'旧账号歌曲'}
const scope={
  useState(initial){const slot=index++;states[slot]=initial;return[states[slot],value=>{states[slot]=typeof value==='function'?value(states[slot]):value}]},
  useRef(initial){return {current:initial}},useEffect(fn){effects.push(fn)},
  useVisibilityRules(){return []},
  useQueryClient(){return {invalidateQueries:async()=>{}}},
  useTrackActions:Object.assign(()=>({menu:{track,x:0,y:0},adding:null}),{setState(){}}),
  saveLibraryTrack(){return new Promise(resolve=>{resolveSave=resolve})},
  createPortal:value=>value,
  usePlayerStore:{getState:()=>({})},
  React:{createElement:(type,props,...children)=>({type,props:props||{},children}),Fragment:'fragment'},
  accountEpoch:()=>0,
  window:new EventTarget(),document:new EventTarget(),
}
const icons=['Download','FolderPlus','ListMusic','ListVideo','MoreHorizontal','Pencil','Play','Trash2']
const components=['DownloadDialogHost','MetadataDialog','PlaylistPicker']
for(const key of [...icons,...components])scope[key]=key
scope.document.body={};scope.commandErrorMessage=String
const source=original.replace(/^import .*$/gm,'').replace(/^export \{.*$/gm,'').replace(/export /g,'')+'\nreturn TrackActionsHost;'
const js=(await transform(source,{loader:'tsx',jsx:'transform'})).code
const component=new Function(...Object.keys(scope),js)(...Object.values(scope))
const tree=component();for(const effect of effects)effect()
function nodes(v){if(!v||typeof v!=='object')return[];if(Array.isArray(v))return v.flatMap(nodes);return[v,...(v.children||[]).flatMap(nodes)]}
const edit=nodes(tree).find(n=>n.type==='button'&&n.children.includes('编辑歌曲信息'))
assert(edit);edit.props.onClick()
scope.window.dispatchEvent(new Event('bilimusic-account-changing'))
assert.equal(states[0],null)
resolveSave(track);await new Promise(setImmediate)
assert.equal(states[0],null)

