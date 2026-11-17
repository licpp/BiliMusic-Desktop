/** Portable shuffle policy. Also compiled as ArkTS by scripts/ohos.py. */
export interface ShuffleItem { id:string; artist:string; bvid:string }
export interface ShuffleState { version:number; remaining:string[]; played:string[]; history:string[]; cursor:number }
export class ShuffleDeck {
  private remaining:string[]=[]
  private played:Set<string>=new Set<string>()
  private history:string[]=[]
  private cursor:number=-1
  private items:ShuffleItem[]=[]
  private random:()=>number
  constructor(random:()=>number=Math.random, saved?:ShuffleState) {
    this.random=random
    if(saved && saved.version===1 && [saved.remaining,saved.played,saved.history].every(rows=>Array.isArray(rows)&&rows.length<=10000&&rows.every(id=>typeof id==='string')) && Number.isInteger(saved.cursor) && saved.cursor>=-1 && saved.cursor<saved.history.length) {
      this.remaining=Array.from(new Set(saved.remaining));this.played=new Set(saved.played)
      this.history=saved.history.slice(-200);this.cursor=Math.max(-1,saved.cursor-(saved.history.length-this.history.length))
    }
  }
  reset():void { this.remaining=[];this.played.clear();this.history=[];this.cursor=-1;this.items=[] }
  snapshot():ShuffleState { return {version:1,remaining:[...this.remaining],played:Array.from(this.played),history:[...this.history],cursor:this.cursor} }
  private unit():number { const n=this.random();return Number.isFinite(n)?Math.max(0,Math.min(.9999999999999999,n)):0 }
  private artist(item:ShuffleItem|undefined):string { const value=(item?.artist ?? '').trim().toLowerCase();return /^(?:歌手未知|未知歌手|unknown(?: artist)?)$/.test(value)?'':value }
  private order(ids:string[],current:string):string[] {
    if(ids.length<2)return [...ids]
    const byId=new Map<string,ShuffleItem>(this.items.map(item=>[item.id,item]))
    const recent=new Map<string,number>()
    this.history.slice(Math.max(0,this.cursor-49),this.cursor+1).forEach((id,i)=>recent.set(id,i+1))
    let best:string[]=[],bestScore=Infinity
    // Several unbiased Fisher–Yates permutations, then prefer the fresher prefix.
    // Diversity is a soft score: nothing is excluded or starved from the round.
    for(let candidate=0;candidate<4;candidate++) {
      const rows=[...ids]
      for(let i=rows.length-1;i>0;i--){const j=Math.floor(this.unit()*(i+1));const old=rows[i];rows[i]=rows[j];rows[j]=old}
      if(rows[0]===current){const i=rows.findIndex(id=>id!==current);if(i>0){rows[0]=rows[i];rows[i]=current}}
      let score=0,previous=byId.get(current)
      const prefix=Math.min(rows.length,128)
      for(let i=0;i<prefix;i++) {
        const item=byId.get(rows[i]),weight=prefix-i
        score+=weight*(recent.get(rows[i]) ?? 0)*4
        if(item?.bvid && item.bvid===previous?.bvid)score+=weight*240
        const artist=this.artist(item)
        if(artist && artist===this.artist(previous))score+=weight*100
        previous=item
      }
      if(score<bestScore){best=rows;bestScore=score}
    }
    return best
  }
  observe(items:ShuffleItem[],current:string):void {
    const byId=new Map<string,ShuffleItem>()
    for(const item of items) if(item.id && !byId.has(item.id)) byId.set(item.id,item)
    this.items=Array.from(byId.values())
    const valid=new Set(this.items.map(item=>item.id))
    const before=this.history.slice(0,this.cursor+1).filter(id=>valid.has(id)).length
    this.history=this.history.filter(id=>valid.has(id));this.cursor=before-1
    this.played=new Set(Array.from(this.played).filter(id=>valid.has(id)))
    this.remaining=this.remaining.filter(id=>valid.has(id)&&!this.played.has(id))
    const pending=new Set(this.remaining)
    const added=this.items.filter(item=>!this.played.has(item.id)&&!pending.has(item.id)).map(item=>item.id)
    const ordered=this.order(added,current)
    if(!this.remaining.length)this.remaining=ordered
    else for(const id of ordered)this.remaining.splice(Math.floor(this.unit()*(this.remaining.length+1)),0,id)
    if(valid.has(current) && this.history[this.cursor]!==current) {
      this.history=this.history.slice(0,this.cursor+1);this.history.push(current);this.cursor=this.history.length-1
      this.played.add(current);this.remaining=this.remaining.filter(id=>id!==current)
      this.trimHistory()
    }
  }
  private trimHistory():void { if(this.history.length>200){const extra=this.history.length-200;this.history=this.history.slice(extra);this.cursor-=extra} }
  target(items:ShuffleItem[],current:string,direction:number):string|undefined {
    this.observe(items,current)
    if(!this.items.length)return undefined
    if(direction<0)return this.history[this.cursor=Math.max(0,this.cursor-1)] ?? current
    if(this.cursor+1<this.history.length)return this.history[++this.cursor]
    if(!this.remaining.length){this.played.clear();this.remaining=this.order(this.items.map(item=>item.id),current)}
    const next=this.remaining.shift()
    if(next===undefined)return undefined
    this.played.add(next);this.history=this.history.slice(0,this.cursor+1);this.history.push(next);this.cursor=this.history.length-1;this.trimHistory()
    return next
  }
}
