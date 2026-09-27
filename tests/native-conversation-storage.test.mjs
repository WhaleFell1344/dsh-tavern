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
import {projectChatSessionState,projectChatBackgroundConfig} from '../tavern-plugin/lib/domain/chat-session-state.js'

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
