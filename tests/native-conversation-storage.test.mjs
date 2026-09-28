import {projectTavernHelperContext,hydrateTavernHelperMessages} from '../tavern-plugin/lib/domain/tavern-helper-context.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'
import {createConversationPageStore} from '../tavern-plugin/lib/domain/conversation-page-store.js'
import {createConversationState} from '../tavern-plugin/lib/domain/conversation-state.js'
import {projectChatSessionState,projectChatBackgroundConfig,projectSceneImageState} from '../tavern-plugin/lib/domain/chat-session-state.js'

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'native-chat-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const io=[],store=createChatJournalStore({dataRoot:root,newConversations:true,onNativeIO:e=>io.push(e)})
 const persistence=createChatPersistence({store})
 const pages=createConversationPageStore({root:join(root,'chats')})
 return {root,store,persistence,pages,domain:createConversationState({store:pages}),io}
}
const row=gold=>({role:'assistant',text:'reward',variables:[{stat_data:{gold},schema:{}}]})

test('one variable transaction persists final roots, not twenty intermediate worlds',async t=>{
 const {persistence,io,domain,root}=await fixture(t)
 const chat=await persistence.write({id:'a',messages:[{role:'assistant',text:'reward',variables:[{stat_data:Object.fromEntries(Array.from({length:20},(_,i)=>['f'+i,0]))}]}]})
 io.length=0
 await persistence.patch('a',chat._storageRevision,Array.from({length:20},(_,i)=>({op:'set',path:['messages',0,'variables',0,'stat_data','f'+i],value:1})))
 assert.ok(io.filter(e=>e.kind==='write').length<=35,'do not persist unreachable intermediate tree roots')
 assert.deepEqual((await domain.readWorld('a')).variables.stat_data,Object.fromEntries(Array.from({length:20},(_,i)=>['f'+i,1])))
 const fresh=createChatJournalStore({dataRoot:root})
 assert.deepEqual((await fresh.read('a')).messages[0].variables[0],(await domain.readWorld('a')).variables)
})

test('process death during a buffered flush cannot publish half a variable transaction',async t=>{
 const {root,persistence}=await fixture(t)
 const original=await persistence.write({id:'a',messages:[row(0)]})
 const child=spawnSync(process.execPath,['--input-type=module','-e',`
  import {createChatJournalStore} from ${JSON.stringify(new URL('../tavern-plugin/lib/domain/chat-journal-store.js',import.meta.url).href)};
  import {createChatPersistence} from ${JSON.stringify(new URL('../tavern-plugin/lib/domain/chat-persistence.js',import.meta.url).href)};
  let writes=0;
  const store=createChatJournalStore({dataRoot:${JSON.stringify(root)},onNativeIO:e=>{if(['write','link'].includes(e.kind)&&e.type==='record'&&++writes===2)process.kill(process.pid,'SIGKILL')}});
  await createChatPersistence({store}).patch('a',1,[{op:'set',path:['messages',0,'variables',0,'stat_data','gold'],value:10}]);
 `],{encoding:'utf8',timeout:15000})
 assert.equal(child.signal,'SIGKILL',child.stderr)
 const restarted=createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 assert.deepEqual(await restarted.read('a'),original)
 await restarted.patch('a',1,[{op:'set',path:['messages',0,'variables',0,'stat_data','gold'],value:10}])
 assert.equal((await restarted.read('a')).messages[0].variables[0].stat_data.gold,10)
})

test('cold selected reads skip historical variables and return the same session projection',async t=>{
 const {root,persistence}=await fixture(t)
 const historical=row(1)
 historical.variables[0].stat_data.archive='history-only'.repeat(15000)
 const chat=await persistence.write({id:'a',sessionId:'s',messages:[historical,...Array.from({length:128},()=>row(2)),{...row(3),mvu:{pending:true,pendingSubmission:{ops:[]}}}],
  timeline:{schemaVersion:1,operations:{},checkpoints:['large-checkpoint'.repeat(15000)],participants:{background:{status:'idle'}}},mode:'story'})
 let io=[]
 const fresh=createChatJournalStore({dataRoot:root,onNativeIO:e=>io.push(e)})
 const selected=await fresh.readSlice('a',[129],'settlement')
 assert.equal(selected.messageCount,130)
 assert.deepEqual(selected.chat.messages,[chat.messages[129]])
 assert.deepEqual(selected.chat.timeline.checkpoints,[])
 assert.ok(io.every(e=>e.bytes<65536),'selected reads must skip historical variables and checkpoints')
 assert.ok(io.filter(e=>e.type==='page').length<=3,'tail selection must not read every page')
 io=[]
 const tail=await fresh.readSlice('a',Array.from({length:100},(_,i)=>30+i),'settlement')
 assert.deepEqual(tail.chat.messages,chat.messages.slice(30))
 assert.ok(io.filter(e=>e.type==='page').length<=4,'adjacent row selections must share page reads')
 const duplicates=await fresh.readSlice('a',[129,30,129],['id','_storageRevision'])
 assert.deepEqual(duplicates.chat.messages,[chat.messages[129],chat.messages[30],chat.messages[129]])
 duplicates.chat.messages[0].text='changed'
 assert.notEqual(duplicates.chat.messages[2].text,'changed')
 io=[]
 assert.deepEqual(await fresh.readBackgroundConfig('a'),projectChatBackgroundConfig(chat))
 assert.ok(io.every(e=>e.bytes<65536))
 io=[]
 assert.deepEqual(await fresh.readSessionState('a'),projectChatSessionState(chat))
 // Session's public contract includes checkpoints, but never historical variables.
 const historyBytes=Buffer.byteLength(JSON.stringify({kind:'record',value:{type:'scalar',value:historical.variables[0].stat_data.archive}}))
 assert.ok(!io.some(e=>e.bytes===historyBytes),'session metadata must not hydrate history-only payload')
 const scoped=await fresh.readSessionState('a',{scoped:true})
 assert.deepEqual([...scoped.messages],projectChatSessionState(chat).messages)
 assert.deepEqual(scoped.pendingMvuSettlement,{hasSubmission:true,prepared:false})
 scoped.messages[0].role='changed'
 assert.equal((await fresh.readSessionState('a')).messages[0].role,'assistant')
 assert.deepEqual((await fresh.read('a')).messages,chat.messages,'full read still returns complete historical values')
})

test('fresh native gameplay writes pages, recovers variables and preserves historical revisions',async t=>{
 const {root,store,persistence,domain,pages}=await fixture(t)
 const chat=await persistence.write({id:'a',messages:[row(0)],posture:'standing'})
 const initial=structuredClone(chat)
 chat.messages.push({role:'user',text:'play'},row(10))
 const saved=await persistence.write(chat)
 const head=await domain.open('a')
 assert.equal(head.metadata.format,'conversation-state-v2')
 assert.equal(head.state.world.variables.stat_data.gold,10)
 assert.equal(head.messageCount,3)
 assert.ok(head.messages.every(r=>r.message.runtimeRef&&!Object.hasOwn(r.message,'variables')))
 assert.deepEqual((await readdir(join(root,'chats/a'))).sort(),['blocks','head.json'])
 assert.deepEqual(await store.readRevision('a',initial._storageRevision),initial)
 const fresh=createChatJournalStore({dataRoot:root})
 assert.deepEqual(await fresh.read('a'),saved)
 const read=await fresh.read('a');read.messages[0].variables[0].stat_data.gold=999
 assert.equal((await fresh.read('a')).messages[0].variables[0].stat_data.gold,0)
 await persistence.patch('a',saved._storageRevision,[{op:'set',path:['messages',2,'variables',0,'stat_data','gold'],value:23}])
 assert.equal((await domain.readWorld('a')).variables.stat_data.gold,23)
 assert.equal((await fresh.read('a')).messages[2].variables[0].stat_data.gold,23)
 const before=await pages.openConversation('a')
 let checks=0
 await assert.rejects(persistence.patch('a',saved._storageRevision+1,[{op:'set',path:['posture'],value:'lost'}],{assertCurrent(){if(++checks===2)throw Error('cancelled')}}),/cancelled/)
 assert.equal(checks,2,'guard must be checked again immediately before head publication')
 assert.equal((await pages.openConversation('a')).revision,before.revision)
})

test('scalar variable writes do not read unrelated large values and corrupt heads never fall back',async t=>{
 const {root,persistence,io,domain}=await fixture(t)
 const message=row(0)
 message.variables[0].stat_data.archive='untouched'.repeat(20000)
 const chat=await persistence.write({id:'a',messages:[message]})
 io.length=0
 await persistence.patch('a',chat._storageRevision,[{op:'set',path:['messages',0,'variables',0,'stat_data','gold'],value:42}])
 assert.ok(io.every(event=>event.bytes<65536),'a scalar patch must not load or write the large sibling')
 assert.equal((await domain.readWorld('a',{path:'/variables/stat_data/gold'})),42)
 const {writeFile}=await import('node:fs/promises')
 await writeFile(join(root,'chats/a/head.json'),'{broken')
 await assert.rejects(createChatJournalStore({dataRoot:root}).read('a'),SyntaxError)
})

test('rollback across page boundaries and undo keep old immutable snapshots readable',async t=>{
 const {persistence,store,pages,domain}=await fixture(t)
 const chat=await persistence.write({id:'a',messages:Array.from({length:140},(_,i)=>row(i))})
 const before=await pages.openConversation('a')
 const original=structuredClone(chat)
 chat.messages.splice(63)
 await persistence.write(chat)
 assert.equal((await domain.readWorld('a')).variables.stat_data.gold,62)
 chat.messages.push(row(900),row(901))
 await persistence.write(chat)
 assert.deepEqual((await store.read('a')).messages.slice(62).map(r=>r.variables[0].stat_data.gold),[62,900,901])
 assert.equal((await pages.readHistoryPage('a',{cursor:before.snapshotCursor,limit:1})).messageCount,140)
 chat.messages=original.messages
 await persistence.write(chat)
 assert.deepEqual((await store.read('a')).messages,original.messages)
 assert.equal((await domain.readWorld('a')).variables.stat_data.gold,139)
})

test('new-format option does not convert existing journals or card chats; stale merges remain isolated',async t=>{
 const {root,persistence,store}=await fixture(t)
 const legacy=createChatJournalStore({dataRoot:root})
 await legacy.update('old',()=>({id:'old',messages:[row(1)],_storageRevision:1}))
 await store.update('old',chat=>({...chat,_storageRevision:2,posture:'still legacy'}))
 assert.ok((await readdir(join(root,'chats/old'))).includes('snapshots'))
 await assert.rejects(readFile(join(root,'chats/old/head.json')),{code:'ENOENT'})
 await persistence.write({id:'card',mode:'card',messages:[]})
 await assert.rejects(readFile(join(root,'chats/card/head.json')),{code:'ENOENT'})
 await persistence.write({id:'a',messages:[row(1)],posture:'start'})
 const first=await persistence.read('a'),second=await persistence.read('a')
 first.posture='changed';await persistence.write(first)
 second.extra='independent';await persistence.write(second)
 assert.equal((await persistence.read('a')).posture,'changed')
 const third=await persistence.read('a'),fourth=await persistence.read('a')
 third.posture='third';await persistence.write(third)
 fourth.posture='fourth'
 await assert.rejects(persistence.write(fourth),{code:'DSH_TAVERN_CHAT_CONFLICT'})
})


test('cold Helper projections read only requested page rows and preserve all historical API fields',async t=>{
 const {root,persistence}=await fixture(t)
 const messages=Array.from({length:530},(_,i)=>({...row(i),turn:i+1,swipeId:1,swipes:['a'+i,'b'+i],variables:[{gold:i},{gold:i+1}],tavernPluginData:{custom:i}}))
 messages[0]={...messages[0],role:'tavern-helper',tavernRole:'system',tavernHidden:true,name:'plugin'}
 // These large runtime-only fields must never be read for a Helper request.
 messages[529].displayRuntime={frames:['diagnostic'.repeat(20000)]}
 messages[529].mvuBaseline={variables:{archive:'baseline'.repeat(20000)}}
 const chat=await persistence.write({id:'helper',sessionId:'s',messages,variables:{chat:true},tavernHelperScriptVariables:{test:{value:1}},tavernPluginMetadata:{custom:true}})
 const io=[]
 const cold=createChatPersistence({store:createChatJournalStore({dataRoot:root,cacheMaxBytes:1,onNativeIO:e=>io.push(e)})})
 const range=await cold.readHelperContext('helper',{from:527,to:600})
 assert.deepEqual({from:range.from,to:range.to,messages:range.context.messages},hydrateTavernHelperMessages(chat,527,600))
 assert.ok(io.filter(e=>e.type==='page').length<=2)
 assert.ok(io.every(e=>e.bytes<65536),'skip runtime-only blobs even in selected rows')
 io.length=0
 const full=await cold.readHelperContext('helper')
 assert.deepEqual(full.context,projectTavernHelperContext(chat))
 assert.ok(io.every(e=>e.bytes<65536))
 full.context.messages[0].variables.gold=-1
 assert.deepEqual((await cold.readHelperContext('helper')).context,projectTavernHelperContext(chat),'detached full API')
 assert.deepEqual((await cold.readHelperContext('helper',{from:540})).context.messages,[])
 assert.deepEqual((await cold.read('helper')).messages,chat.messages,'full runtime API stays lossless')
})

test('legacy Helper reads keep the complete context and range fallback',async t=>{
 const {root}=await fixture(t)
 const p=createChatPersistence({store:createChatJournalStore({dataRoot:root,newConversations:false})})
 const chat=await p.write({id:'legacy-helper',messages:[row(1),row(2)],variables:{custom:true}})
 assert.deepEqual((await p.readHelperContext(chat.id)).context,projectTavernHelperContext(chat))
 const selected=await p.readHelperContext(chat.id,{from:1,to:1})
 assert.deepEqual({from:selected.from,to:selected.to,messages:selected.context.messages},hydrateTavernHelperMessages(chat,1,1))
})

test('cold native delta eligibility checks never hydrate a Chat that has no cached change coverage',async t=>{
 const {root,persistence}=await fixture(t)
 const historical=row(1)
 historical.displayRuntime={frames:['must-not-read'.repeat(20000)]}
 const chat=await persistence.write({id:'delta',messages:[historical,row(2)]})
 const io=[]
 const cold=createChatJournalStore({dataRoot:root,cacheMaxBytes:1,onNativeIO:e=>io.push(e)})
 assert.deepEqual(await cold.readChangedIndices('delta',chat._storageRevision),{indices:[],baseRevision:chat._storageRevision,revision:chat._storageRevision})
 assert.equal(await cold.readChangedIndices('delta',0),undefined)
 assert.equal(await cold.readChangedSlice('delta',0),undefined)
 assert.equal(await cold.readViewDelta('delta',0),undefined)
 assert.ok(io.every(e=>e.type!=='page'&&e.bytes<65536),'checking missing delta coverage must only read the head')
})

test('a cold native point patch reads only its target and keeps current world and revisions atomic',async t=>{
 const {root,persistence,domain}=await fixture(t)
 const historical={...row(1),displayRuntime:{frames:['unrelated-history'.repeat(20000)]}}
 const chat=await persistence.write({id:'cold-patch',messages:[historical,row(2),{role:'user',text:'next'}],posture:'before'})
 const io=[]
 const cold=createChatPersistence({store:createChatJournalStore({dataRoot:root,cacheMaxBytes:1,onNativeIO:e=>io.push(e)})})
 assert.equal(await cold.patch(chat.id,0,[{op:'set',path:['posture'],value:'stale'}]),undefined)
 const saved=await cold.patch(chat.id,chat._storageRevision,[
  {op:'set',path:['messages',1,'variables',0,'stat_data','gold'],value:3},
  {op:'set',path:['posture'],value:'after'}])
 assert.equal(saved._storageRevision,2)
 assert.ok(io.every(e=>e.bytes<65536),'point patch must not read unrelated historical payloads')
 assert.deepEqual((await domain.readWorld(chat.id)),{variables:{stat_data:{gold:3},schema:{}},posture:'after'})
 const full=await cold.read(chat.id)
 assert.deepEqual(full.messages[0],historical)
 assert.deepEqual((await cold.readRevision(chat.id,1)).messages,chat.messages)
 await cold.patch(chat.id,2,[{op:'set',path:['messages',2,'variables'],value:[{stat_data:{gold:4}}]}])
 assert.equal((await domain.readWorld(chat.id)).variables.stat_data.gold,4)
 await cold.patch(chat.id,3,[{op:'delete',path:['messages',2,'variables']}])
 assert.equal((await domain.readWorld(chat.id)).variables.stat_data.gold,3,'removing current variables must reselect the earlier world')
})

test('cold native patches match warm JSON semantics and reject invalid or cancelled writes',async t=>{
 const {root,persistence}=await fixture(t)
 const initial={messages:[{...row(1),swipes:['a','b'],swipeId:0,variables:[{gold:1},{gold:2}],tavernPluginData:{old:true}},{role:'user',text:'next'}],variables:{chat:true},tavernHelperScriptVariables:{a:{value:1}}}
 await persistence.write({id:'warm',...structuredClone(initial)})
 await persistence.write({id:'cold',...structuredClone(initial)})
 const cold=createChatPersistence({store:createChatJournalStore({dataRoot:root,cacheMaxBytes:1})})
 const frames=[
  [{op:'set',path:['messages',0,'swipeId'],value:1}],
  [{op:'set',path:['messages',0,'tavernPluginData','old'],value:undefined},{op:'set',path:['messages',0,'variables',0],value:undefined}],
  [{op:'splice',path:['messages',0,'swipes'],index:0,deleteCount:1,items:['c','d']}],
  [{op:'set',path:['messages',1,'variables'],value:[{gold:4}]}],
  [{op:'set',path:['messages',0,'variables',0],value:{gold:8}}],
  [{op:'set',path:['variables','chat'],value:false},{op:'set',path:['tavernHelperScriptVariables','a','value'],value:3}],
  [{op:'delete',path:['messages',1,'variables']}]
 ]
 for(let index=0;index<frames.length;index++){
  await persistence.patch('warm',index+1,frames[index],{touchUpdatedAt:false})
  await cold.patch('cold',index+1,frames[index],{touchUpdatedAt:false})
  const {id:a,updatedAt:b,...warm}=await persistence.read('warm')
  const {id:c,updatedAt:d,...actual}=await cold.read('cold')
  assert.deepEqual(actual,warm)
 }
 const before=await cold.read('cold'),revision=before._storageRevision
 await assert.rejects(cold.patch('cold',revision,[{op:'set',path:['messages',0,'text'],value:'late'}],{assertCurrent(){throw Error('cancelled')}}),/cancelled/)
 await assert.rejects(cold.patch('cold',revision,[{op:'set',path:['messages',0,'missing','child'],value:1}]),/Missing mutation parent/)
 assert.deepEqual(await cold.read('cold'),before)
 let guards=0
 await assert.rejects(cold.patch('cold',revision,[{op:'set',path:['messages',0,'text'],value:'prepared'}],{assertCurrent(){if(++guards===2)throw Error('cancelled before head')}}),/cancelled before head/)
 assert.equal(guards,2)
 assert.deepEqual(await cold.read('cold'),before)
})


test('Helper hydration is pinned to the view revision across concurrent edits and rollback',async t=>{
 const {root,persistence}=await fixture(t)
 const before=await persistence.write({id:'hydration',messages:[row(1),row(2)]})
 await persistence.patch(before.id,1,[{op:'set',path:['messages',0,'variables',0,'stat_data','gold'],value:99}])
 await persistence.patch(before.id,2,[{op:'splice',path:['messages'],index:1,deleteCount:1,items:[]}])
 const cold=createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 const selected=await cold.readHelperContext(before.id,{from:0,to:1,revision:1})
 assert.equal(selected.chat._storageRevision,1)
 assert.deepEqual(selected.context.messages,projectTavernHelperContext(before).messages)
 assert.equal((await cold.readHelperContext(before.id)).context.messages.length,1)
 await assert.rejects(cold.readHelperContext(before.id,{revision:999}),{code:'DSH_TAVERN_REVISION_NOT_FOUND'})
})


test('native scene polling does not materialize historical variables or display diagnostics',async t=>{
 const {root,persistence}=await fixture(t)
 const message={...row(1),swipes:['inactive','active'],swipeId:1,variables:[{archive:'unused'.repeat(40000)}],displayRuntime:{frames:['diagnostic'.repeat(30000)]}}
 const chat=await persistence.write({id:'scene',mode:'story',messages:[message,{role:'user',text:'next'},row(2)]})
 const io=[],cold=createChatJournalStore({dataRoot:root,onNativeIO:e=>io.push(e)})
 assert.deepEqual(await cold.readSceneImageState('scene'),projectSceneImageState(chat))
 assert.ok(io.every(e=>e.bytes<65536))
})

test('native opening window reads only tail pages and pins later paging to the same revision',async t=>{
 const {root,persistence}=await fixture(t)
 const messages=Array.from({length:530},(_,i)=>({...row(i),turn:i+1,text:'floor '+i}))
 messages[0].text='old body'.repeat(100000)
 const chat=await persistence.write({id:'window',sessionId:'s',backgroundConfigVersion:1,conversationFeaturesVersion:1,timeline:{checkpoints:[{participants:{background:{sessionId:'old-background'}}}]},messages})
 const io=[],cold=createChatPersistence({store:createChatJournalStore({dataRoot:root,cacheMaxBytes:1,onNativeIO:e=>io.push(e)})})
 const window=await cold.readWindow('window',{limit:48})
 assert.equal(window.messageCount,530)
 assert.equal(window.from,482)
 assert.equal(window.to,529)
 assert.deepEqual(window.chat.messages,chat.messages.slice(-48))
 assert.equal(window.chat._storageRevision,chat._storageRevision)
 assert.ok(io.filter(e=>e.type==='page').length<=2)
 assert.ok(io.every(e=>e.bytes<65536),'opening must not read an old body')
 assert.deepEqual((await cold.readWindow('window',{limit:1,includeCheckpoints:true})).chat.timeline.checkpoints,chat.timeline.checkpoints)
 await persistence.patch('window',chat._storageRevision,[{op:'set',path:['messages',529,'text'],value:'new'}])
 const pinned=await cold.readWindow('window',{limit:48,revision:chat._storageRevision})
 assert.equal(pinned.chat.messages.at(-1).text,'floor 529')
 assert.equal((await cold.readWindow('window',{before:482,limit:48})).to,481)
})

test('session summary reads share a bounded immutable-revision cache without exposing mutable rows',async t=>{
 const {root,persistence}=await fixture(t)
 const messages=Array.from({length:530},(_,i)=>({...row(i),turn:i+1}))
 await persistence.write({id:'summary-cache',messages})
 const io=[],cold=createChatJournalStore({dataRoot:root,onNativeIO:e=>io.push(e)})
 const first=await cold.readSessionState('summary-cache',{scoped:true})
 assert.ok(io.some(e=>e.type==='page'))
 const firstPages=io.filter(e=>e.type==='page').length
 first.messages[529].turn=999
 io.length=0
 const again=await cold.readSessionState('summary-cache',{scoped:true})
 assert.equal(again.messages[529].turn,530)
 assert.equal(io.filter(e=>e.type==='page').length,0,'same revision must not rescan all history pages')
 const full=await cold.readSessionState('summary-cache')
 full.messages[529].turn=888
 assert.equal((await cold.readSessionState('summary-cache')).messages[529].turn,530)
 const parallelIO=[],parallel=createChatJournalStore({dataRoot:root,onNativeIO:e=>parallelIO.push(e)})
 await Promise.all(Array.from({length:4},()=>parallel.readSessionState('summary-cache',{scoped:true})))
 assert.equal(parallelIO.filter(e=>e.type==='page').length,firstPages,'concurrent readers share the same immutable load')
 await persistence.patch('summary-cache',1,[{op:'set',path:['messages',529,'turn'],value:600}])
 assert.equal((await cold.readSessionState('summary-cache',{scoped:true})).messages[529].turn,600)
})

test('native display capture reads only target diagnostics at absolute coordinates',async t=>{
 const {root,persistence}=await fixture(t)
 const chat=await persistence.write({id:'display',sessionId:'s',mode:'story',backgroundConfigVersion:1,conversationFeaturesVersion:1,
  rollbackUndo:{ready:true,storageRevision:1},messages:[{role:'assistant',greeting:true,text:'old'.repeat(50000),variables:[{huge:'vars'.repeat(50000)}]},
   {role:'user',text:'next'},{role:'assistant',turn:2,text:'last',displayRuntime:{frames:[{dom:'target'}]}}]})
 const {projectDisplayRuntimeState}=await import('../tavern-plugin/lib/domain/chat-session-state.js')
 const io=[],fresh=createChatJournalStore({dataRoot:root,onNativeIO:event=>io.push(event)})
 for(const turn of [1,2,9])assert.deepEqual(await fresh.readDisplayRuntimeState('display',turn),projectDisplayRuntimeState(chat,turn))
 assert.ok(io.every(event=>event.bytes<65536),'display capture must skip body and variable blobs')
})

test('cold native settlement checkpoint reads only its target floor and preserves operation guards',async t=>{
 const {root,persistence}=await fixture(t)
 await persistence.write({id:'checkpoint',sessionId:'s',tavernHelperLifecycleRevision:3,
  timeline:{schemaVersion:1,branchId:'b',revision:7,operations:{op:{id:'op',kind:'agent',status:'running'}}},
  messages:Array.from({length:1200},(_,i)=>({...row(i),text:'floor '+i}))})
 const io=[],cold=createChatJournalStore({dataRoot:root,onNativeIO:e=>io.push(e)})
 const selected=await cold.readSettlementCheckpoint('checkpoint',1198,'op')
 assert.equal(selected.chat.messages[0].variables[0].stat_data.gold,1198)
 assert.ok(Number.isSafeInteger(selected.chat._storageRevision))
 assert.equal(selected.chat.tavernHelperLifecycleRevision,3)
 assert.equal(selected.chat.timeline.operations.op.status,'running')
 assert.ok(io.filter(e=>e.type==='page').length<=2,'checkpoint must not materialize archive')
 const saved=await createChatPersistence({store:cold}).patch('checkpoint',selected.chat._storageRevision,[{op:'set',path:['messages',1198,'mvu'],value:{pending:true}}])
 assert.ok(saved,'selected revision must support a scoped CAS write')
 selected.chat.messages[0].text='local'
 assert.equal((await cold.readSlice('checkpoint',[1198])).chat.messages[0].text,'floor 1198')
})

test('cold candidate task state reads no history pages and stays detached across revisions',async t=>{
 const {createTaskStateReader}=await import('../tavern-plugin/lib/domain/task-state-reader.js')
 const {persistence,root}=await fixture(t)
 const saved=await persistence.write({id:'task-state',sessionId:'session',mode:'story',cardPath:'card',
  timeline:{schemaVersion:1,branchId:'branch',revision:1,operations:{},participants:{},checkpoints:[]},
  candidates:{requestId:'request',messageId:'last',operationId:'candidate'},
  messages:Array.from({length:530},(_,i)=>({...row(i),turn:i+1}))})
 const io=[],cold=createChatPersistence({store:createChatJournalStore({dataRoot:root,onNativeIO:event=>io.push(event)})})
 const reader=createTaskStateReader({readSlice:cold.readSlice,readState:()=>{throw Error('must not materialize session history')}})
 const selected=await reader.read('task-state')
 assert.deepEqual(selected.candidates,saved.candidates)
 assert.deepEqual(selected.timeline,saved.timeline)
 assert.equal(selected._storageRevision,saved._storageRevision)
 assert.equal(io.filter(event=>event.type==='page').length,0)
 selected.candidates.requestId='local mutation'
 selected.timeline.operations.local={status:'running'}
 assert.deepEqual((await reader.read('task-state')).timeline,saved.timeline)
 await persistence.patch('task-state',saved._storageRevision,[{op:'set',path:['candidates','requestId'],value:'new request'}])
 assert.equal((await reader.read('task-state')).candidates.requestId,'new request')
 assert.equal(io.filter(event=>event.type==='page').length,0)
})

test('opening eligibility skips materialization when the entire conversation fits in the window',async t=>{
 const {root,persistence}=await fixture(t)
 const chat=await persistence.write({id:'short-opening',cardDefinitionSnapshot:{payload:'large-card'.repeat(100000)},messages:[row(1),row(2)]})
 const io=[],cold=createChatPersistence({store:createChatJournalStore({dataRoot:root,onNativeIO:e=>io.push(e)})})
 assert.equal(await cold.readWindow(chat.id,{limit:48,requirePartial:true}),null)
 assert.ok(io.every(e=>e.bytes<65536),'an ineligible opening must not materialize the large card')
 assert.deepEqual((await cold.readWindow(chat.id,{limit:48})).chat.messages,chat.messages,'ordinary full windows remain available')
 assert.equal((await cold.readWindow(chat.id,{limit:1,requirePartial:true})).from,1,'partial windows remain available')
})

test('scoped mailbox commit preserves story, world and historical revisions',async t=>{
 const {root,persistence,domain}=await fixture(t)
 const original=await persistence.write({id:'mailbox',cardSnapshot:{large:'card'.repeat(20000)},messages:[row(7)]})
 const cold=createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 const saved=await cold.patch('mailbox',original._storageRevision,[{op:'set',path:['taskMailbox'],value:{version:1,tasks:{},latestByKind:{},optional:undefined}}],{returnProjection:['id','_storageRevision','taskMailbox']})
 assert.equal(saved.taskMailbox.version,1)
 assert.equal(saved.cardSnapshot,undefined)
 assert.deepEqual((await cold.read('mailbox')).messages,original.messages)
 assert.deepEqual((await cold.read('mailbox')).cardSnapshot,original.cardSnapshot)
 assert.deepEqual((await domain.readWorld('mailbox')).variables.stat_data,{gold:7})
 assert.deepEqual(await cold.readRevision('mailbox',original._storageRevision),original)
 assert.equal(await cold.patch('mailbox',original._storageRevision,[{op:'set',path:['taskMailbox'],value:{version:99}}],{returnProjection:['id']}),undefined)
})


test('candidate metadata patch canonicalizes optional undefined leaves',async t=>{
 const {persistence}=await fixture(t)
 const original=await persistence.write({id:'optional',messages:[row(7)],candidates:{choices:[],script:{old:true}}})
 const saved=await persistence.patch('optional',original._storageRevision,[{op:'set',path:['candidates','script'],value:undefined},{op:'set',path:['candidates','optional'],value:undefined}],{returnProjection:['id','candidates']})
 assert.deepEqual(saved.candidates,{choices:[]})
})

test('unchanged card blocks survive task revisions without sharing writable projections',async t=>{
 const {root,persistence}=await fixture(t)
 const chat=await persistence.write({id:'resource-reuse',cardDefinitionSnapshot:{description:'large'.repeat(200000)},messages:[row(1)]})
 await persistence.write({id:'other-game',messages:[]})
 const io=[],reader=createChatPersistence({store:createChatJournalStore({dataRoot:root,onNativeIO:e=>io.push(e)})})
 const first=await reader.readSlice(chat.id,[],['id','cardDefinitionSnapshot'])
 first.chat.cardDefinitionSnapshot.description='caller mutation'
 await reader.readSlice('other-game',[],['id'])
 const updated=await persistence.patch(chat.id,chat._storageRevision,[{op:'set',path:['taskMailbox'],value:{version:1}}],{returnProjection:['id','_storageRevision']})
 io.length=0
 const second=await reader.readSlice(chat.id,[],['id','cardDefinitionSnapshot'])
 assert.equal(second.chat.cardDefinitionSnapshot.description,'large'.repeat(200000))
 assert.ok(io.every(e=>e.bytes<65536),'unchanged large immutable blocks should not be loaded again')
 await persistence.patch(chat.id,updated._storageRevision,[{op:'set',path:['cardDefinitionSnapshot','description'],value:'external edit'}])
 assert.equal((await reader.readSlice(chat.id,[],['cardDefinitionSnapshot'])).chat.cardDefinitionSnapshot.description,'external edit')
 assert.equal((await reader.readRevision(chat.id,chat._storageRevision)).cardDefinitionSnapshot.description,'large'.repeat(200000))
})
