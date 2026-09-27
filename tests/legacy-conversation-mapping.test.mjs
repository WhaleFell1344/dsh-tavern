import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createConversationPageStore} from '../tavern-plugin/lib/domain/conversation-page-store.js'
import {createLegacyConversationMapping} from '../tavern-plugin/lib/domain/legacy-conversation-mapping.js'

function chat(count=5){
 const variables={stat_data:{gold:10,inventory:['key']},schema:{gold:'number'}}
 return JSON.parse(JSON.stringify({id:'old',sessionId:'session',_storageRevision:17,
  messages:Array.from({length:count},(_,i)=>({role:i%2?'assistant':'user',text:'message '+i,sourceText:'source '+i,turn:i+1,
   swipeId:1,swipes:['a','b'],variables:[{stat_data:{gold:0}},variables],mvuBaseline:{swipeId:1,variables},
   mvu:{pending:true,pendingSubmission:{operations:[{type:'set',path:'gold',value:11}]},delivery:{prepared:true,effect:{gold:11}}},
   tavernPluginData:{template_rendered:{hash:'test',swipe:1}},custom:{nullable:null,empty:[],unknown:'preserve'}})),
  variables:{local:'chat-local'},posture:'standing',scriptState:{cursor:3},settleStatus:'pending',
  timeline:{branchId:'branch',revision:5,checkpoints:[{beforeRevision:14}],operations:{job:{status:'running'}}},
  nativeCommits:{5:{requestId:'request'}},tavernHelperScriptVariables:{script:{value:2}},
  unknownExtension:{some:{nested:'preserve'}}}))
}
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'legacy-mapping-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const io=[],store=createConversationPageStore({root,onIO:e=>io.push(e)})
 return {root,io,store,mapping:createLegacyConversationMapping({store})}
}

test('old Chat round-trips exactly including property order, MVU delivery and unknown fields',async t=>{
 const {store,mapping}=await fixture(t),source=chat()
 const before=JSON.stringify(source)
 const receipt=await mapping.importChat('shadow',source)
 assert.equal(receipt.verified,true)
 assert.equal(JSON.stringify(source),before)
 const restored=await mapping.exportChat('shadow')
 assert.deepEqual(restored,source)
 assert.equal(JSON.stringify(restored),before)
 const opened=await store.openConversation('shadow')
 assert.deepEqual(opened.state.chatFields.variables,{local:'chat-local'})
 assert.equal(opened.state.messageVariables.stat_data.gold,10)
 assert.equal(opened.messages[0].message.content.text,'message 0')
 assert.equal(opened.messages[0].message.content.variables,undefined)
 const message=await mapping.readMessage('shadow',{cursor:opened.snapshotCursor,position:3})
 assert.deepEqual(message,source.messages[3])
 restored.messages[0].variables[1].stat_data.gold=100
 assert.equal((await mapping.exportChat('shadow')).messages[0].variables[1].stat_data.gold,10)
})

test('shared historical states are stored once and cold tail reads no legacy detail records',async t=>{
 const {root,store,mapping,io}=await fixture(t),source=chat(2000)
 const receipt=await mapping.importChat('shadow',source)
 assert.equal(receipt.messageCount,2000)
 const first=await store.openConversation('shadow',{limit:2})
 assert.equal(first.messages[0].message.variablesRef,first.messages[1].message.variablesRef)
 assert.equal(first.messages[0].message.baselineRef,first.messages[1].message.baselineRef)
 io.length=0
 const cold=createConversationPageStore({root,onIO:e=>io.push(e)})
 const opened=await cold.openConversation('shadow',{limit:50})
 assert.equal(opened.messages.length,50)
 assert.equal(io.filter(e=>e.type==='record').length,0)
 assert.ok(io.filter(e=>e.type==='page').length<=2)
 assert.equal(JSON.stringify(await createLegacyConversationMapping({store:cold}).exportChat('shadow')),JSON.stringify(source))
})

test('absent fields, nulls, hostile property names and empty histories retain their meaning',async t=>{
 const {mapping}=await fixture(t)
 for(const [index,source] of [
  {id:'old',messages:[],variables:null},
  JSON.parse('{"__proto__":{"safe":true},"id":"old","messages":[{"text":"","__proto__":{"safe":true},"variables":null,"mvuBaseline":null}],"constructor":"custom"}'),
  {id:'old',messages:[{role:'tavern-helper',text:'hidden',variables:[{ignored:true}]}]}
 ].entries()){
  await mapping.importChat('shadow'+index,source)
  assert.equal(JSON.stringify(await mapping.exportChat('shadow'+index)),JSON.stringify(source))
 }
 assert.equal({}.safe,undefined)
})

test('non-JSON or invalid messages are rejected before publishing a target',async t=>{
 const {mapping,store}=await fixture(t)
 for(const source of [{id:'old',messages:[null]},{id:'old',messages:[],lost:undefined},{id:'old',messages:[],date:new Date()}, {id:'old',messages:new Array(2)}]){
  await assert.rejects(mapping.importChat('shadow',source))
  assert.equal(await store.openConversation('shadow'),undefined)
 }
})

test('an import cannot overwrite an existing target and exports pin their snapshot',async t=>{
 const {store,mapping}=await fixture(t)
 const source=chat(),receipt=await mapping.importChat('shadow',source)
 await assert.rejects(mapping.importChat('shadow',chat(6)),{code:'CONVERSATION_CONFLICT'})
 await store.commit('shadow',{expectedRevision:1,state:{changed:true}})
 assert.deepEqual(await mapping.exportChat('shadow',{snapshotId:receipt.snapshotId}),source)
 await assert.rejects(mapping.exportChat('shadow'),/mapping|digest|state/i)
})

test('interrupted mapping never publishes a partial target and can be retried',async t=>{
 const {store,mapping}=await fixture(t),source=chat()
 let writes=0
 const interrupted=createLegacyConversationMapping({store:{...store,writeRecord:async(...args)=>{
  if(++writes===2)throw Error('interrupted record write')
  return store.writeRecord(...args)
 }}})
 await assert.rejects(interrupted.importChat('shadow',source),/interrupted/)
 assert.equal(await store.openConversation('shadow'),undefined)
 await mapping.importChat('shadow',source)
 assert.deepEqual(await mapping.exportChat('shadow'),source)
})

test('source mutations during asynchronous import cannot change the captured snapshot',async t=>{
 const {mapping}=await fixture(t),source=chat(),expected=structuredClone(source)
 const importing=mapping.importChat('shadow',source)
 source.messages[0].variables[1].stat_data.gold=99
 source.unknownExtension.some.nested='changed by caller'
 await importing
 assert.deepEqual(await mapping.exportChat('shadow'),expected)
})
