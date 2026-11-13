import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
const built=await build({entryPoints:['src/features/comments/commentEditorModel.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const {commentPieces,replaceCommentSelection,deleteCommentSelection,commentNodeText}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const emotes={'[笑哭]':'https://i0.hdslb.com/emote.png','[不安全]':'javascript:alert(1)'}
test('only known safe emote tokens become images, preserving the exact outgoing comment',()=>{
 const text='你好😀[笑哭]\n[未知][不安全]'
 const parts=commentPieces(text,emotes)
 assert.equal(parts.map(p=>p.text).join(''),text)
 assert.deepEqual(parts.filter(p=>p.url).map(({text,start,end})=>({text,start,end})),[{text:'[笑哭]',start:4,end:8}])
 assert.equal(commentPieces('[toString]',{}).some(p=>p.url),false)
})
test('emotes insert at a saved selection and delete as one token in either direction',()=>{
 const inserted=replaceCommentSelection('甲乙丙',{start:1,end:2},'[笑哭]')
 assert.deepEqual(inserted,{text:'甲[笑哭]丙',start:5,end:5})
 assert.deepEqual(deleteCommentSelection(inserted.text,{start:5,end:5},true,emotes),{text:'甲丙',start:1,end:1})
 assert.deepEqual(deleteCommentSelection(inserted.text,{start:1,end:1},false,emotes),{text:'甲丙',start:1,end:1})
 assert.equal(deleteCommentSelection('😀甲',{start:2,end:2},true,emotes).text,'甲')
 assert.equal(deleteCommentSelection('甲😀',{start:1,end:1},false,emotes).text,'甲')
})
test('the outgoing Bili comment length counts Unicode and token text, not image nodes',()=>{
 assert.ok(replaceCommentSelection('😀'.repeat(996),{start:1992,end:1992},'[笑哭]'))
 assert.equal(replaceCommentSelection('😀'.repeat(997),{start:1994,end:1994},'[笑哭]'),undefined)
 assert.equal(replaceCommentSelection('旧内容',{start:0,end:3},'新的内容',4).text,'新的内容')
})

// WebKit emits block nodes during composition; the trailing BR is only a caret
// anchor, so neither a copied draft nor the outgoing comment may include it.
const textNode=text=>({nodeType:3,nodeName:'#text',nodeValue:text,childNodes:[]})
const element=(name,children=[],attributes={})=>({nodeType:1,nodeName:name,childNodes:children,getAttribute:key=>attributes[key]??null,hasAttribute:key=>Object.hasOwn(attributes,key)})
test('DOM serialization preserves composed lines and image tokens without phantom trailing newlines',()=>{
 assert.equal(commentNodeText(element('DIV',[element('BR')])),'')
 assert.equal(commentNodeText(element('DIV',[textNode('第一句\n'),element('BR',[],{'data-comment-tail':'true'})])),'第一句\n')
 assert.equal(commentNodeText(element('DIV',[textNode('甲'),element('IMG',[],{'data-emote':'[笑哭]'}),textNode('😀')])),'甲[笑哭]😀')
 assert.equal(commentNodeText(element('DIV',[element('DIV',[textNode('第一句')]),element('DIV',[textNode('第二句')])])),'第一句\n第二句')
})
test('WebKit caret anchors never leak invisible characters into a comment draft',()=>{
 const anchor=element('SPAN',[textNode('\u200b')],{'data-comment-anchor':'true'});anchor.textContent='\u200b'
 const typed=element('SPAN',[textNode('\u200b继续')],{'data-comment-anchor':'true'});typed.textContent='\u200b继续'
 assert.equal(commentNodeText(element('DIV',[anchor,element('IMG',[],{'data-emote':'[笑哭]'}),typed])),'[笑哭]继续')
})
