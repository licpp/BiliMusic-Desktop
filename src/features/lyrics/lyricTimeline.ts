import type { LyricLine, StoredLyrics } from '../../services/desktopApi'
import { parseLrc } from './lrc'
export function storedLyricLines(stored: StoredLyrics): LyricLine[] {
  try {
    const parsed: unknown = JSON.parse(stored.parsedJson)
    if (!Array.isArray(parsed)) return []
    const source = parseLrc(stored.rawText)
    return parsed.filter(line => Number.isFinite(line?.timeMs) && typeof line?.text === 'string').map((line: LyricLine) => {
      const original = source.find(item => item.timeMs === line.timeMs && item.text === line.text)
      const words = original?.words ?? line.words
      const valid = words?.length && words.map(word => word.text).join('') === line.text && words.every((word,index) => Number.isFinite(word.startTimeMs) && Number.isFinite(word.endTimeMs) && word.endTimeMs > word.startTimeMs && word.startTimeMs >= line.timeMs && (!index || word.startTimeMs >= words[index-1].endTimeMs))
      return { ...line, words: valid ? words : undefined, ...(original?.endTimeMs !== undefined ? { endTimeMs:original.endTimeMs } : {}) }
    }).sort((a,b)=>a.timeMs-b.timeMs)
  } catch { return [] }
}
export function lyricAt(lines: LyricLine[], timeMs: number, holdUntilNext = true) {
  let low = 0, high = lines.length
  while (low < high) { const mid = (low + high) >>> 1; if (lines[mid].timeMs <= timeMs) low = mid + 1; else high = mid }
  const index = low - 1
  return index >= 0 && (holdUntilNext || lines[index].endTimeMs === undefined || timeMs < lines[index].endTimeMs!) ? index : -1
}
export function floatingTimeline(lines: LyricLine[], biasMs: number, scope: string, captions: {scope:string;active:boolean;lines?:LyricLine[]}) {
  const subtitles = Boolean(scope && captions.active && captions.scope === scope && captions.lines !== undefined)
  return {lines:subtitles?captions.lines!:lines,biasMs:subtitles?0:biasMs,subtitles}
}
export function floatingLinePair(lines: LyricLine[], timeMs: number, subtitles = false) {
  const active=lyricAt(lines,timeMs,!subtitles)
  const upcoming=active<0?lines.findIndex(line=>line.timeMs>timeMs):-1
  const index=active>=0?active:subtitles?-1:upcoming>=0?upcoming:lines.length-1
  return {active,line:lines[index],next:lines[index>=0?index+1:upcoming]}
}
export function systemLrc(lines: LyricLine[], biasMs: number) {
  return lines.map(line => {
    const ms = Math.max(0,Math.round(line.timeMs + biasMs))
    return `[${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}]${line.text.replace(/[\r\n]/g,' ')}`
  }).join('\n')
}

// Keep a sentence in its physical row while it changes from upcoming to active.
// Only the expired row is replaced, so successive sentences alternate rows.
export function floatingLineSlots(lines: LyricLine[], timeMs: number, subtitles = false) {
  const index=lyricAt(lines,timeMs),active=lyricAt(lines,timeMs,!subtitles)
  const current=Math.max(0,index),other=current+1<lines.length?current+1:current-1
  return [0,1].map(slot=>{
    const at=current%2===slot?current:other
    return {line:at>=0?lines[at]:undefined,index:at,active:at===active&&at>=0}
  })
}

// Text position follows the same media clock as highlighting, including pauses,
// seeks and gaps between timed words. Untimed lines interpolate until the next.
export function lyricScrollProgress(line: LyricLine, timeMs: number, nextTimeMs?: number) {
  const clamp=(value:number)=>Math.max(0,Math.min(1,value))
  const words=line.words
  if(words?.length) {
    const total=words.reduce((size,word)=>size+Array.from(word.text).length,0)
    if(!total)return 0
    let completed=0
    for(const word of words) {
      const length=Array.from(word.text).length
      if(timeMs<word.startTimeMs)return completed/total
      if(timeMs<word.endTimeMs)return (completed+length*clamp((timeMs-word.startTimeMs)/(word.endTimeMs-word.startTimeMs)))/total
      completed+=length
    }
    return 1
  }
  const end=line.endTimeMs??nextTimeMs??(line.timeMs+Math.max(3000,Array.from(line.text).length*250))
  return clamp((timeMs-line.timeMs)/Math.max(1,end-line.timeMs))
}

// Reserve reading time at both edges. A wider visible portion needs less
// movement and can spend longer at rest; short lines scale the holds down.
export function lyricScrollPosition(line: LyricLine, timeMs: number, nextTimeMs: number|undefined, viewportWidth: number, textWidth: number) {
  if(textWidth<=viewportWidth||viewportWidth<=0)return 0
  const words=line.words
  const last=words?.[words.length-1]
  const naturalEnd=line.endTimeMs??nextTimeMs??last?.endTimeMs??(line.timeMs+Math.max(3000,Array.from(line.text).length*250))
  const end=nextTimeMs===undefined?naturalEnd:Math.min(naturalEnd,nextTimeMs)
  const duration=Math.max(1,end-line.timeMs)
  const visibleDuration=duration*Math.min(1,viewportWidth/textWidth)
  const firstWord=words?.[0]
  const firstDuration=firstWord?Math.max(0,firstWord.endTimeMs-firstWord.startTimeMs):0
  const lastDuration=last?Math.max(0,last.endTimeMs-last.startTimeMs):0
  const lead=Math.min(duration*.18,Math.max(180,Math.min(650,Math.max(visibleDuration*.12,firstDuration*.35))))
  const tail=Math.min(duration*.22,Math.max(240,Math.min(850,Math.max(visibleDuration*.16,lastDuration*.45))))
  const startAt=line.timeMs+lead,endAt=end-tail
  if(timeMs<=startAt)return 0
  if(timeMs>=endAt)return 1
  const from=lyricScrollProgress(line,startAt,end),to=lyricScrollProgress(line,endAt,end)
  // A long silent gap can put both anchors at the same word boundary. In
  // that case interpolate across the available interval instead of jumping.
  const progress=to-from>1e-6?(lyricScrollProgress(line,timeMs,end)-from)/(to-from):(timeMs-startAt)/(endAt-startAt)
  return Math.max(0,Math.min(1,progress))
}
