import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const out=await build({entryPoints:['src/features/settings/listeningCalendar.ts'],bundle:true,write:false,format:'esm'})
const {listeningCalendar}=await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
test('calendar includes every leap-year day once and pads complete Monday-first weeks',()=>{
 const cells=listeningCalendar(2024,[],'2026-11-12'),days=cells.filter(d=>!d.outside)
 assert.equal(cells.length%7,0);assert.equal(cells[0].date.getUTCDay(),1)
 assert.equal(days.length,366);assert.equal(new Set(days.map(d=>d.key)).size,366)
 assert.ok(days.some(d=>d.key==='2024-02-29'));assert.equal(days[0].key,'2024-01-01');assert.equal(days.at(-1).key,'2024-12-31')
})
test('calendar intensity uses actual durations and distinguishes future from empty past dates',()=>{
 const cells=listeningCalendar(2026,[{day:'2026-11-09',seconds:60},{day:'2026-11-10',seconds:900},{day:'2026-11-11',seconds:3600},{day:'2026-11-12',seconds:10800}],'2026-11-12')
 assert.deepEqual(cells.filter(d=>d.seconds>0).map(d=>d.level),[1,2,3,4])
 assert.equal(cells.find(d=>d.key==='2026-11-13').future,true)
 assert.equal(cells.find(d=>d.key==='2026-11-08').future,false)
 assert.equal(cells.find(d=>d.key==='2026-11-08').level,0)
})
