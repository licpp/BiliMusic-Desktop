import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

test('application runtime imports contain no cycles between feature modules',async()=>{
 const {metafile}=await build({entryPoints:['src/main.tsx','src/large-screen/main.tsx'],outdir:'artifacts/architecture-checks',bundle:true,write:false,metafile:true,loader:{'.css':'empty'},logLevel:'silent'})
 const graph=new Map(Object.entries(metafile.inputs).filter(([k])=>k.startsWith('src/')).map(([k,v])=>[k,v.imports.filter(i=>!i.external&&i.path.startsWith('src/')).map(i=>i.path)]))
 const visiting=new Set(),done=new Set()
 function visit(v,path=[]){
  assert.ok(!visiting.has(v),`Runtime import cycle: ${[...path,v].join(' -> ')}`)
  if(done.has(v))return
  visiting.add(v)
  for(const w of graph.get(v)||[])visit(w,[...path,v])
  visiting.delete(v);done.add(v)
 }
 for(const v of graph.keys())visit(v)
})

test('private cache reads cannot introduce unscoped literal query keys',async()=>{
 const {default:ts}=await import('typescript'),{readdir,readFile}=await import('node:fs/promises')
 const publicKeys=new Set(['video-detail','video-danmaku','creator-profile','creator-search','collection-parts','search-suggestions','playback-cache'])
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){const file=`${dir}/${e.name}`;if(e.isDirectory()){await walk(file);continue}if(!/\.tsx?$/.test(file))continue;const source=ts.createSourceFile(file,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true);function visit(n){if(ts.isPropertyAssignment(n)&&n.name.getText(source)==='queryKey'&&ts.isArrayLiteralExpression(n.initializer)){const first=n.initializer.elements[0];if(first&&ts.isStringLiteral(first))assert.ok(publicKeys.has(first.text),`${file}: private key ${first.text} must use accountQueryKey`)}ts.forEachChild(n,visit)}visit(source)}}
 await walk('src')
})
