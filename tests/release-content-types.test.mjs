import {test} from 'node:test'
import assert from 'node:assert/strict'
import {releaseContentType,inspectDownloadHeaders} from '../scripts/release_content_types.mjs'
test('release uploads label Android packages explicitly while retaining other formats',()=>{
 assert.equal(releaseContentType('BiliMusic.APK'),'application/vnd.android.package-archive')
 assert.equal(releaseContentType('archive.zip'),'application/zip')
 assert.equal(releaseContentType('setup.exe'),'application/octet-stream')
})
test('public download checks accept correct APK filenames and generic binary responses',()=>{
 for(const type of ['application/vnd.android.package-archive','application/octet-stream','']){
  const headers=new Headers({'content-type':type,'content-disposition':'attachment; filename="BiliMusic.apk"'})
  assert.equal(inspectDownloadHeaders('BiliMusic.apk',headers).filename,'BiliMusic.apk')
 }
 const encoded=new Headers({'content-disposition':"attachment; filename=fallback.zip; filename*=UTF-8''BiliMusic.apk"})
 assert.equal(inspectDownloadHeaders('BiliMusic.apk',encoded).filename,'BiliMusic.apk')
 assert.equal(inspectDownloadHeaders('BiliMusic.apk',new Headers()).filename,null)
})
test('public download checks catch APK renamed or advertised as a ZIP even when bytes are identical',()=>{
 for(const name of ['BiliMusic.apk.zip','BiliMusic.zip','BiliMusic.apk.zip.exe'])assert.throws(()=>inspectDownloadHeaders('BiliMusic.apk',new Headers({'content-disposition':`attachment; filename="${name}"`})),/filename/)
 assert.throws(()=>inspectDownloadHeaders('BiliMusic.apk',new Headers({'content-disposition':"attachment; filename*=UTF-8''BiliMusic.apk.zip"})),/filename/)
 assert.throws(()=>inspectDownloadHeaders('BiliMusic.apk',new Headers({'content-type':'application/zip; charset=binary'})),/ZIP/)
 assert.doesNotThrow(()=>inspectDownloadHeaders('archive.zip',new Headers({'content-type':'application/zip'})))
})
