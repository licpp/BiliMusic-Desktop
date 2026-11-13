import {forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useRef} from 'react'
import {commentNodeText,commentPieces,commentPoint,deleteCommentSelection,replaceCommentSelection,type CommentSelection} from './commentEditorModel'
export type CommentEditorHandle={focus:()=>void;blur:()=>void;insert:(token:string)=>boolean}
type Snapshot={text:string;selection:CommentSelection}
export const CommentEditor=forwardRef<CommentEditorHandle,{value:string;emotes:Record<string,string>;disabled:boolean;label:string;placeholder:string;onChange:(value:string)=>void;onFocus:()=>void}>(function CommentEditor({value,emotes,disabled,label,placeholder,onChange,onFocus},ref){
  const root=useRef<HTMLDivElement>(null),composing=useRef(false)
  const selection=useRef<CommentSelection>({start:value.length,end:value.length})
  const last=useRef(value),committed=useRef(value),past=useRef<Snapshot[]>([]),future=useRef<Snapshot[]>([])
  const historySelection=useRef(selection.current)
  const handlers=useRef({beforeInput:(_event:InputEvent)=>{}})
  const remember=()=>{
    const element=root.current,range=window.getSelection()
    if(!element||!range?.rangeCount)return selection.current
    const current=range.getRangeAt(0)
    if(!element.contains(current.startContainer)||!element.contains(current.endContainer))return selection.current
    const prefix=document.createRange();prefix.selectNodeContents(element);prefix.setEnd(current.startContainer,current.startOffset)
    const suffix=document.createRange();suffix.selectNodeContents(element);suffix.setEnd(current.endContainer,current.endOffset)
    selection.current={start:commentNodeText(prefix.cloneContents()).length,end:commentNodeText(suffix.cloneContents()).length}
    return selection.current
  }
  const restore=()=>{
    if(!root.current)return
    const start=commentPoint(root.current,selection.current.start),end=commentPoint(root.current,selection.current.end)
    const range=document.createRange();range.setStart(start.node,start.offset);range.setEnd(end.node,end.offset)
    const current=window.getSelection();current?.removeAllRanges();current?.addRange(range)
  }
  const paint=()=>{
    const element=root.current;if(!element||composing.current)return
    const fragment=document.createDocumentFragment()
    const caretAnchor=()=>{const anchor=document.createElement('span');anchor.dataset.commentAnchor='true';anchor.append(document.createTextNode('\u200b'));return anchor}
    for(const part of commentPieces(last.current,emotes)){
      if(part.url){const image=document.createElement('img');image.src=part.url;image.alt=part.text;image.title=part.text;image.dataset.emote=part.text;image.contentEditable='false';image.draggable=false;image.referrerPolicy='no-referrer';fragment.append(caretAnchor(),image,caretAnchor())}
      else fragment.append(document.createTextNode(part.text))
    }
    // A trailing newline needs a non-text caret anchor in WebKit/Chromium.
    // Otherwise the next insertion lands before the newline visually.
    if(last.current.endsWith('\n')){const tail=document.createElement('br');tail.dataset.commentTail='true';fragment.append(tail)}
    const focused=document.activeElement===element
    const current=window.getSelection()
    const ownedSelection=current?.anchorNode&&element.contains(current.anchorNode)
    element.replaceChildren(fragment)
    if(focused)restore()
    else if(ownedSelection)current?.removeAllRanges()
  }
  const commit=(next:string,cursor:CommentSelection,history=true)=>{
    if(history&&next!==last.current){past.current.push({text:last.current,selection:{...historySelection.current}});if(past.current.length>100)past.current.shift();future.current=[]}
    selection.current=cursor;historySelection.current={...cursor};last.current=next;committed.current=next;onChange(next);paint()
  }
  const insert=(text:string)=>{
    if(disabled)return false
    historySelection.current={...remember()}
    const next=replaceCommentSelection(last.current,selection.current,text)
    if(!next)return false
    commit(next.text,{start:next.start,end:next.end});return true
  }
  const undo=(redo=false)=>{
    const from=redo?future.current:past.current,to=redo?past.current:future.current,next=from.pop()
    if(next){to.push({text:last.current,selection:remember()});commit(next.text,next.selection,false)}
  }
  const input=()=>{
    if(composing.current||!root.current)return
    const next=commentNodeText(root.current),cursor=remember()
    if(Array.from(next).length>1000){paint();return}
    commit(next,cursor)
  }
  handlers.current.beforeInput=event=>{
    if(composing.current||event.isComposing||disabled)return
    historySelection.current={...remember()}
    if(event.inputType==='historyUndo'||event.inputType==='historyRedo'){event.preventDefault();undo(event.inputType==='historyRedo')}
    else if(event.inputType==='insertParagraph'||event.inputType==='insertLineBreak'){event.preventDefault();insert('\n')}
    else if(event.inputType==='deleteContentBackward'||event.inputType==='deleteContentForward'){
      event.preventDefault();const next=deleteCommentSelection(last.current,remember(),event.inputType==='deleteContentBackward',emotes);commit(next.text,{start:next.start,end:next.end})
    }
  }
  useEffect(()=>{const element=root.current;if(!element)return;const before=(event:InputEvent)=>handlers.current.beforeInput(event);element.addEventListener('beforeinput',before);return()=>element.removeEventListener('beforeinput',before)},[])
  useLayoutEffect(()=>{
    if(composing.current)return
    if(value!==committed.current){selection.current={start:value.length,end:value.length};past.current=[];future.current=[]}
    last.current=value;committed.current=value;paint()
  },[value,emotes])
  useImperativeHandle(ref,()=>({focus:()=>{root.current?.focus({preventScroll:true});restore()},blur:()=>root.current?.blur(),insert}))
  return <div ref={root} className="comment-editor" role="textbox" aria-multiline="true" aria-label={label} aria-disabled={disabled} contentEditable={!disabled} suppressContentEditableWarning tabIndex={disabled?-1:0} data-placeholder={placeholder} data-empty={!value||undefined} spellCheck
    onFocus={()=>{const current=window.getSelection();if(!current?.anchorNode||!root.current?.contains(current.anchorNode))restore();onFocus()}} onBlur={remember} onSelect={remember} onPointerUp={()=>{const current=window.getSelection();if(current?.anchorNode&&root.current?.contains(current.anchorNode))remember();else if(document.activeElement===root.current)restore()}} onKeyUp={remember}
    onCompositionStart={()=>{historySelection.current={...remember()};composing.current=true}} onCompositionEnd={()=>{composing.current=false;input()}} onInput={input}
    onKeyDown={event=>{
      if(disabled||event.nativeEvent.isComposing||event.keyCode===229)return
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();undo(event.shiftKey)}
      else if(event.ctrlKey&&!event.metaKey&&event.key.toLowerCase()==='y'){event.preventDefault();undo(true)}
      else if(event.key==='Enter'){event.preventDefault();insert('\n')}
    }}
    onPaste={event=>{event.preventDefault();insert(event.clipboardData.getData('text/plain'))}}
    onCopy={event=>{const range=remember();if(range.start!==range.end){event.preventDefault();event.clipboardData.setData('text/plain',last.current.slice(range.start,range.end))}}}
    onCut={event=>{const range=remember();if(range.start!==range.end){event.preventDefault();event.clipboardData.setData('text/plain',last.current.slice(range.start,range.end));if(!disabled)insert('')}}}
    onDrop={event=>event.preventDefault()}/>
})
