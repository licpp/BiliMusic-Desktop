// A window receives sparse media samples; rendering can still follow each frame.
// Only interpolate after real clock movement, and never run past a stale sample.
export type LyricClockSample = { id:string; position:number; playing:boolean; rate:number; revision?:number; capturedAt?:number }
export function createLyricClock() {
 let sample:LyricClockSample|null=null,at=0,anchor=0,running=false,last=0
 const value=(now:number)=>anchor+(running?Math.min(.65,Math.max(0,now-at)/1000)*Math.max(.1,sample?.rate||1):0)
 return {
  update(next:LyricClockSample,now:number,wallTime=Date.now()) {
   const previous=sample,elapsed=(now-at)/1000,delta=next.position-(previous?.position||0)
   const continuous=previous?.id===next.id&&previous.revision===next.revision&&elapsed>0&&elapsed<1.5
   const advancing=continuous&&delta>.001&&delta<elapsed*Math.max(1,next.rate)+.35
   const delay=Number.isFinite(next.capturedAt)?Math.min(.15,Math.max(0,(wallTime-next.capturedAt!)/1000)):0
   const actual=Math.max(0,next.position)+(advancing&&next.playing?delay*next.rate:0)
   const predicted=value(now),smallCorrection=continuous&&next.playing&&previous.playing&&Math.abs(actual-predicted)<.12
   anchor=smallCorrection?Math.max(actual,Math.min(predicted,actual+.08)):actual
   running=next.playing&&advancing;sample=next;at=now;last=anchor
  },
  position(now:number) { const next=value(now);last=Math.max(last,next);return last },
 }
}
