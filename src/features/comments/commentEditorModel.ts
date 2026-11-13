export type CommentSelection={start:number;end:number}
export function commentPieces(text:string,emotes:Record<string,string>) {
  let offset=0
  return text.split(/(\[[^\[\]\n]{1,80}\])/gu).filter(Boolean).map(value=>{
    const start=offset;offset+=value.length
    return {text:value,start,end:offset,url:Object.hasOwn(emotes,value)&&emotes[value].startsWith('https://')?emotes[value]:undefined}
  })
}
export function replaceCommentSelection(text:string,selection:CommentSelection,insert:string,limit=1000) {
  const start=Math.max(0,Math.min(text.length,selection.start)),end=Math.max(start,Math.min(text.length,selection.end))
  const next=text.slice(0,start)+insert+text.slice(end)
  return Array.from(next).length<=limit?{text:next,start:start+insert.length,end:start+insert.length}:undefined
}
export function deleteCommentSelection(text:string,selection:CommentSelection,backward:boolean,emotes:Record<string,string>) {
  let {start,end}=selection
  if(start===end){
    const piece=commentPieces(text,emotes).find(part=>part.url&&(backward?part.end===start:part.start===end))
    if(piece){start=piece.start;end=piece.end}
    else if(backward)start=Math.max(0,start-(Array.from(text.slice(0,start)).at(-1)?.length||0))
    else end=Math.min(text.length,end+(Array.from(text.slice(end))[0]?.length||0))
  }
  return replaceCommentSelection(text,{start,end},'')!
}
// WebKit may create DIV/BR nodes while dictating or inserting a line break.
// Read plain text and our own image tokens only; pasted markup is never trusted.
export function commentNodeText(node:Node):string {
  if(node.nodeType===3)return node.nodeValue||''
  const element=node as Element
  if(element.nodeType===1&&element.hasAttribute('data-comment-anchor'))return (element.textContent||'').replace('\u200b','')
  if(element.nodeName==='IMG')return element.getAttribute('data-emote')||''
  if(element.nodeName==='BR')return element.hasAttribute('data-comment-tail')?'':'\n'
  const children=Array.from(node.childNodes)
  if(children.length===1&&children[0].nodeName==='BR')return ''
  let result='',previousBlock=false
  children.forEach((child,index)=>{
    const block=['DIV','P'].includes(child.nodeName)
    if(index&&(block||previousBlock)&&!result.endsWith('\n'))result+='\n'
    result+=commentNodeText(child);previousBlock=block
  })
  return result
}
export function commentPoint(root:Node,offset:number):{node:Node;offset:number} {
  let remaining=Math.max(0,offset)
  for(const child of Array.from(root.childNodes)){
    const length=commentNodeText(child).length
    if(child.nodeType===1&&(child as Element).hasAttribute('data-comment-anchor')&&remaining<=length&&child.firstChild?.nodeType===3)return {node:child.firstChild,offset:Math.min((child.firstChild.nodeValue||'').length,remaining+1)}
    if(child.nodeType===3&&remaining<=length)return {node:child,offset:remaining}
    if(remaining<length)return {node:root,offset:Array.from(root.childNodes).indexOf(child)+(remaining>length/2?1:0)}
    remaining-=length
  }
  return {node:root,offset:root.childNodes.length}
}
