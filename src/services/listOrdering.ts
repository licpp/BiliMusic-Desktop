export type SortRule = 'source:asc'|'source:desc'|'name:asc'|'name:desc'|'date:asc'|'date:desc'
export type ListPreference = { entity:string; displayRank?:string|null; sortRule?:SortRule|null }
export type ListPreferences = {preferences:ListPreference[];dates:Record<string,number>}
const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin',{numeric:true,sensitivity:'base'})
export function sortList<T>(items:T[],rule:SortRule,info:(item:T)=>{id:string;name:string;date?:number}) {
 const [mode,direction]=rule.split(':'),sign=direction==='desc'?-1:1
 if(mode==='source')return direction==='desc'?[...items].reverse():items
 return items.map((item,index)=>({item,index,...info(item)})).sort((a,b)=>{
  if(mode==='date'){
   const ad=a.date&&a.date>0?a.date:undefined,bd=b.date&&b.date>0?b.date:undefined
   if(!ad||!bd)return ad?-1:bd?1:a.id.localeCompare(b.id)
   return sign*(ad-bd)||a.id.localeCompare(b.id)
  }
  return sign*collator.compare(a.name,b.name)||a.id.localeCompare(b.id)
 }).map(row=>row.item)
}
export function rankList<T>(items:T[],preferences:ListPreference[],id:(item:T)=>string) {
 const ranks=new Map(preferences.map(p=>[p.entity,p.displayRank]))
 return items.map((item,index)=>({item,index,rank:ranks.get(id(item))})).sort((a,b)=>a.rank&&b.rank?a.rank.localeCompare(b.rank)||id(a.item).localeCompare(id(b.item)):a.rank?1:b.rank?-1:a.index-b.index).map(row=>row.item)
}
const MAX=18446744073709551615n
const rank=(n:bigint)=>n.toString().padStart(20,'0')
// Preserve a longest increasing subsequence; normally a drag updates just one rank.
export function rankChanges(ids:string[],preferences:ListPreference[]):ListPreference[] {
 if(new Set(ids).size!==ids.length)throw Error('排序项目重复')
 const old=new Map(preferences.filter(p=>p.displayRank&&/^\d{20}$/.test(p.displayRank)).map(p=>[p.entity,p.displayRank!]))
 const tails:number[]=[],previous=new Array<number>(ids.length).fill(-1)
 const values=ids.map(id=>old.has(id)?BigInt(old.get(id)!):undefined)
 for(let i=0;i<ids.length;i++){
  if(values[i]===undefined)continue
  let lo=0,hi=tails.length
  while(lo<hi){const mid=(lo+hi)>>1;if(values[tails[mid]]!<values[i]!)lo=mid+1;else hi=mid}
  if(lo)previous[i]=tails[lo-1];tails[lo]=i
 }
 const anchors=new Set<number>();let cursor=tails.at(-1)??-1
 while(cursor>=0){anchors.add(cursor);cursor=previous[cursor]}
 const next=new Map<string,string>();let left=-1,low=0n
 for(const right of [...anchors].sort((a,b)=>a-b).concat(ids.length)){
  const high=right===ids.length?MAX:values[right]!,count=right-left-1,step=(high-low)/BigInt(count+1)
  if(count&&step<1n)return ids.flatMap((id,i)=>{const value=rank(MAX/BigInt(ids.length+1)*BigInt(i+1));return value===old.get(id)?[]:[{entity:id,displayRank:value}]})
  for(let i=left+1;i<right;i++)next.set(ids[i],rank(low+step*BigInt(i-left)))
  if(right<ids.length)next.set(ids[right],old.get(ids[right])!)
  left=right;low=high
 }
 return ids.flatMap(id=>next.get(id)===old.get(id)?[]:[{entity:id,displayRank:next.get(id)!}])
}

export function sortTracks<T extends {id:string;title:string;videoTitle?:string;publishedAt?:number;source:{bvid:string;page:number}}>(items:T[],rule:SortRule,dates:Record<string,number>) {
 if(rule==='source:asc')return items
 const groups=new Map<string,T[]>()
 for(const item of items){const group=groups.get(item.source.bvid)||[];group.push(item);groups.set(item.source.bvid,group)}
 return sortList([...groups.values()],rule,group=>({id:group[0].source.bvid,name:group[0].videoTitle||group[0].title,date:group[0].publishedAt||dates[group[0].source.bvid]})).flatMap(group=>[...group].sort((a,b)=>a.source.page-b.source.page||a.id.localeCompare(b.id)))
}
