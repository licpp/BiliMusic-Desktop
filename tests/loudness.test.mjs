import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
async function load(path,loader={}) {
  const built=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node',loader,resolveExtensions:['.ets','.ts','.js']})
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
}
const {safeGainDb,outputVolume,createOutputGain}=await load('src/features/player/outputGain.ts')
const {OutputGain}=await load('native/ohos-player/ohos/OutputGain.ets',{'.ets':'ts'})
const fixtures=JSON.parse(await readFile('tests/fixtures/loudness.json','utf8'))
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`)
test('desktop and Harmony output render all shared plans without changing volume or amplifying',()=>{
  for(const {gainDb} of fixtures) {
    const gain=new OutputGain();gain.configure(true,1);gain.plan(gainDb);gain.transition(0,false)
    for(const volume of [0,.2,.7,1]) {
      near(gain.level(volume,1,0),outputVolume(volume,gainDb))
      near(gain.level(volume,.2,0),outputVolume(volume,gainDb,.2))
      assert.ok(gain.level(volume,1,0)<=volume)
    }
  }
  for(const bad of [undefined,NaN,Infinity,-Infinity,6])assert.equal(safeGainDb(bad),0)
})
test('toggles ramp in dB, rapid toggles start at the current level, new tracks do not inherit old attenuation',()=>{
  let now=0
  const desktop=createOutputGain(()=>now),native=new OutputGain()
  native.configure(true,1);native.plan(-12);native.transition(now,true);desktop.set(-12,true)
  for(now=0;now<=300;now+=30)near(native.level(1,1,now),outputVolume(1,desktop.current()))
  now=300;near(desktop.current(),-12)
  native.configure(false,2);native.transition(now,true);desktop.set(0,true)
  now=400;near(native.current(now),desktop.current());near(desktop.current(),-8)
  assert.equal(native.configure(true,1),false) // delayed old play cannot re-enable normalization
  native.configure(true,3);native.transition(now,true);desktop.set(-12,true)
  now=700;near(native.current(now),-12);near(desktop.current(),-12)
  native.plan(0);native.transition(now,false);desktop.set(0)
  near(native.level(.7,1,now),.7);near(outputVolume(.7,desktop.current()),.7)
})
test('iOS output renders the same plans and rejects stale settings', {skip:process.platform!=='darwin'},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bilimusic-loudness-'))
  try {
    const source=await readFile('native/ios-player/ios/Sources/OutputGain.swift','utf8')
    const cases=fixtures.map(f=>`check(${f.gainDb},${Math.pow(10,f.gainDb/20)})`).join('\n')
    await writeFile(join(dir,'main.swift'),source+`
func near(_ a:Float,_ b:Float){precondition(abs(a-b)<0.000001)}
func check(_ db:Double,_ expected:Double){var g=OutputGain();precondition(g.configure(true,1));g.plan(db);g.transition(0,smooth:false);near(g.level(0.7,0),Float(expected)*0.7);near(g.level(0,0),0)}
${cases}
var g=OutputGain();precondition(g.configure(true,2));g.plan(-12);g.transition(0,smooth:true);near(g.level(1,150),Float(pow(10.0,-6.0/20)))
precondition(!g.configure(false,1));g.transition(300,smooth:false);near(g.level(1,300),Float(pow(10.0,-12.0/20)))
precondition(g.configure(false,3));g.transition(300,smooth:true);near(g.level(1,600),1)
g.plan(Double.nan);g.configure(true,4);g.transition(600,smooth:false);near(g.level(1,600),1)
`)
    const compile=spawnSync('swiftc',[join(dir,'main.swift'),'-o',join(dir,'check')],{encoding:'utf8'})
    assert.equal(compile.status,0,compile.stderr)
    const run=spawnSync(join(dir,'check'),[],{encoding:'utf8'})
    assert.equal(run.status,0,run.stderr)
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('loudness defaults off and persists as an independent device preference',async()=>{
  const saved=globalThis.localStorage,values=new Map()
  globalThis.localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)}
  try {
    const built=await build({entryPoints:['src/services/loudness.ts'],bundle:true,write:false,format:'cjs',platform:'node'})
    const create=()=>{const m={exports:{}};new Function('module','exports',built.outputFiles[0].text)(m,m.exports);return m.exports}
    const first=create()
    assert.equal(first.useLoudnessSettings.getState().enabled,false)
    first.setLoudnessPreference(true)
    const revision=first.useLoudnessSettings.getState().revision
    const restarted=create()
    assert.equal(restarted.useLoudnessSettings.getState().enabled,true)
    restarted.setLoudnessPreference(false)
    assert.ok(restarted.useLoudnessSettings.getState().revision>revision)
    assert.deepEqual([...values.keys()],['bilimusic-loudness-v1'])
  } finally {globalThis.localStorage=saved}
})
