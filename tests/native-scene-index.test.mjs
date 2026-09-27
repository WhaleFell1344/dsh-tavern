import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'
import {createConversationPageStore} from '../tavern-plugin/lib/domain/conversation-page-store.js'
import {sceneTarget} from '../tavern-plugin/lib/domain/scene-illustration.js'
async function fixture(t,count=256){
 const root=await mkdtemp(join(tmpdir(),'scene-index-'));t.after(()=>rm(root,{force:true,recursive:true}))
 const io=[],store=createChatJournalStore({dataRoot:root,newConversations:true,onNativeIO:e=>io.push(e)}),db=createChatPersistence({store})
 const chat=await db.write({id:'场景',sessionId:'s',mode:'story',messages:Array.from({length:count},(_,i)=>({role:'assistant',turn:i+1,text:'正文😀'+i,swipes:['正文😀'+i,'其他'],swipeId:0,variables:[{hp:i}]}))})
 return {root,db,io,chat}
}
test('cold scene lookup preserves legacy keys and bounds history I/O',async t=>{
 const {root,db,io,chat}=await fixture(t)
 const cold=createChatPersistence({store:createChatJournalStore({dataRoot:root,onNativeIO:e=>io.push(e)})})
 io.length=0
 const selected=await cold.readSceneImageState(chat.id,{turns:[255,256]})
 assert.deepEqual(sceneTarget(selected,256),sceneTarget(chat,256))
 assert.deepEqual(sceneTarget(selected,255),sceneTarget(chat,255))
 assert.equal(selected.messages.length,0)
 assert.ok(io.filter(e=>e.type==='page').length<=3,JSON.stringify(io.filter(e=>e.type==='page')))
 const bytes=io.filter(e=>e.kind==='read').reduce((n,e)=>n+e.bytes,0)
 assert.ok(bytes<256000,'bounded point bytes: '+bytes)
 await db.patch(chat.id,chat._storageRevision,[{op:'set',path:['messages',255,'variables',0,'hp'],value:999}])
 assert.equal(sceneTarget(await db.readSceneImageState(chat.id,{turns:[256]}),256).key,sceneTarget(chat,256).key)
})
test('append, old-body edits, swipe, truncation and reopening retain exact legacy identities',async t=>{
 const {db,chat}=await fixture(t,6)
 async function check(){const full=await db.read(chat.id),state=await db.readSceneImageState(chat.id,{turns:full.messages.map(row=>row.turn)})
  for(const row of full.messages)assert.deepEqual(sceneTarget(state,row.turn),sceneTarget(full,row.turn))
  return full
 }
 await db.update(chat.id,c=>{c.messages.push({role:'assistant',turn:7,text:'追加'});return c});await check()
 await db.update(chat.id,c=>{c.messages[1].text='改写';c.messages[1].swipes[0]='改写';return c});await check()
 await db.update(chat.id,c=>{c.messages[4].swipeId=1;return c});await check()
 await db.update(chat.id,c=>{c.messages[4].swipes=[];c.messages[4].swipeId=3;return c});await check()
 await db.update(chat.id,c=>{c.messages.length=3;return c});const old=await check()
 const missing=await db.readSceneImageState(chat.id,{turns:[7]});assert.throws(()=>sceneTarget(missing,7),/不存在/)
 await db.update(chat.id,c=>{c.messages.push({role:'assistant',turn:4,text:'分支'});return c});await check()
 assert.deepEqual(sceneTarget(await db.readSceneImageState(chat.id,{turns:[3],revision:old._storageRevision}),3),sceneTarget(old,3))
})
test('old native heads without the index use full compatibility reads and acquire it on write',async t=>{
 const {root,db,chat}=await fixture(t,4),pages=createConversationPageStore({root:join(root,'chats')})
 const head=await pages.readHead(chat.id),state={...head.state};delete state.sceneIndexRef
 await pages.commit(chat.id,{expectedRevision:head.revision,state})
 assert.deepEqual(sceneTarget(await db.readSceneImageState(chat.id,{turns:[4]}),4),sceneTarget(chat,4))
 await db.patch(chat.id,chat._storageRevision,[{op:'set',path:['messages',3,'variables',0,'hp'],value:42}])
 const selected=await db.readSceneImageState(chat.id,{turns:[4]})
 assert.equal(selected.messages.length,0);assert.deepEqual(sceneTarget(selected,4),sceneTarget(chat,4))
})

test('append resumes persisted prefix state without reading old bodies; variable patch keeps its root',async t=>{
 const {root,db,chat}=await fixture(t)
 const {createNativeConversationStorage}=await import('../tavern-plugin/lib/domain/native-conversation-storage.js')
 const io=[],native=createNativeConversationStorage({dataRoot:root,onIO:e=>io.push(e)})
 const before=await native.read(chat.id),next=structuredClone(before.chat)
 const added={role:'assistant',turn:257,text:'新的一轮'}
 next.messages.push(added);next._storageRevision++
 io.length=0
 const saved=await native.write(chat.id,before,next,[{op:'splice',path:['messages'],index:256,deleteCount:0,items:[added]},{op:'set',path:['_storageRevision'],value:next._storageRevision}])
 assert.ok(io.filter(e=>e.kind==='read'&&e.type==='page').length<=2)
 assert.deepEqual(sceneTarget(await native.readSceneImageState(chat.id,{turns:[257]}),257),sceneTarget(next,257))
 const pages=createConversationPageStore({root:join(root,'chats')}),indexed=(await pages.readHead(chat.id)).state.sceneIndexRef
 await db.patch(chat.id,saved.revision,[{op:'set',path:['messages',255,'variables',0,'hp'],value:99}])
 assert.equal((await pages.readHead(chat.id)).state.sceneIndexRef,indexed)
})

test('an index from an older writer revision cannot return stale picture identities',async t=>{
 const {root,db,chat}=await fixture(t,4),pages=createConversationPageStore({root:join(root,'chats')})
 const head=await pages.readHead(chat.id)
 await pages.commit(chat.id,{expectedRevision:head.revision,state:{...head.state,sceneIndexRevision:0}})
 const fallback=await db.readSceneImageState(chat.id,{turns:[4]})
 assert.equal(fallback.sceneTargets,undefined);assert.equal(fallback.messages.length,4)
 await db.patch(chat.id,chat._storageRevision,[{op:'set',path:['messages',3,'variables',0,'hp'],value:43}])
 assert.deepEqual(sceneTarget(await db.readSceneImageState(chat.id,{turns:[4]}),4),sceneTarget(chat,4))
})

test('display diagnostics share exact explicit-turn coordinates without scanning history',async t=>{
 const {root,db,chat,io}=await fixture(t,130)
 const {projectDisplayRuntimeState}=await import('../tavern-plugin/lib/domain/chat-session-state.js')
 async function check(turn,bounded=true){
  const full=await db.read(chat.id)
  const cold=createChatJournalStore({dataRoot:root,onNativeIO:e=>io.push(e)})
  io.length=0
  assert.deepEqual(await cold.readDisplayRuntimeState(chat.id,turn),projectDisplayRuntimeState(full,turn))
  if(bounded)assert.ok(io.filter(e=>e.type==='page').length<=1)
 }
 await check(130);await check(999)
 await db.update(chat.id,c=>{c.messages.push({role:'assistant',turn:131,text:'next',displayRuntime:{frames:[{dom:'new'}]}});return c})
 await check(131)
 // Duplicate/descending turns: the display API chooses the first matching row
 // and the maximum explicit turn, not simply the last row's turn.
 await db.update(chat.id,c=>{c.messages[1].turn=131;return c})
 await check(131)
 await db.update(chat.id,c=>{c.messages.length=3;return c})
 await check(3)
 // An inferred legacy turn collides with an explicit one: retain full semantics.
 await db.update(chat.id,c=>{c.messages=[{role:'user',text:'input'},{role:'assistant',text:'inferred',displayRuntime:{frames:[{dom:'first'}]}},{role:'assistant',turn:2,text:'explicit'}];return c})
 await check(2,false)
})

test('older scene indexes without display metadata retain display compatibility',async t=>{
 const {root,db,chat}=await fixture(t,3)
 const {createIncrementalJsonState}=await import('../tavern-plugin/lib/domain/incremental-json-state.js')
 const {projectDisplayRuntimeState}=await import('../tavern-plugin/lib/domain/chat-session-state.js')
 const pages=createConversationPageStore({root:join(root,'chats')})
 const head=await pages.readHead(chat.id)
 const tree=createIncrementalJsonState({read:ref=>pages.readRecord(chat.id,ref),write:value=>pages.writeRecord(chat.id,value)})
 const old=(await tree.apply(head.state.sceneIndexRef,[{op:'remove',path:'/display'}])).nextRoot
 await pages.commit(chat.id,{expectedRevision:head.revision,state:{...head.state,sceneIndexRef:old}})
 assert.deepEqual(await db.readDisplayRuntimeState(chat.id,3),projectDisplayRuntimeState(chat,3))
})

test('display metadata left by an older writer falls back until a body edit rebuilds it',async t=>{
 const {root,db,chat}=await fixture(t,3)
 const {createIncrementalJsonState}=await import('../tavern-plugin/lib/domain/incremental-json-state.js')
 const {projectDisplayRuntimeState}=await import('../tavern-plugin/lib/domain/chat-session-state.js')
 const pages=createConversationPageStore({root:join(root,'chats')})
 const head=await pages.readHead(chat.id)
 const tree=createIncrementalJsonState({read:ref=>pages.readRecord(chat.id,ref),write:value=>pages.writeRecord(chat.id,value)})
 const stale=(await tree.apply(head.state.sceneIndexRef,[{op:'set',path:'/display/latestTurn',value:999}])).nextRoot
 await pages.commit(chat.id,{expectedRevision:head.revision,state:{...head.state,sceneIndexRef:stale,displayIndexRevision:0}})
 assert.deepEqual(await db.readDisplayRuntimeState(chat.id,3),projectDisplayRuntimeState(chat,3))
 await db.patch(chat.id,chat._storageRevision,[{op:'set',path:['messages',2,'variables',0,'hp'],value:42}])
 assert.equal((await pages.readHead(chat.id)).state.displayIndexRevision,0,'unverified metadata must not be stamped current')
 assert.equal((await db.readDisplayRuntimeState(chat.id,3)).latestTurn,3)
 await db.update(chat.id,c=>{c.messages[2].text='body edit';return c})
 const repaired=await pages.readHead(chat.id)
 assert.equal(repaired.state.displayIndexRevision,repaired.state.chatRevision)
 assert.deepEqual(await db.readDisplayRuntimeState(chat.id,3),projectDisplayRuntimeState(await db.read(chat.id),3))
})
