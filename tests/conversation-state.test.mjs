import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createConversationPageStore} from '../tavern-plugin/lib/domain/conversation-page-store.js'
import {createConversationState} from '../tavern-plugin/lib/domain/conversation-state.js'
async function fixture(t,count=0){
 const root=await mkdtemp(join(tmpdir(),'conversation-state-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const io=[],store=createConversationPageStore({root,onIO:e=>io.push(e)}),domain=createConversationState({store})
 await domain.create('a',{world:{variables:{gold:10},posture:'standing'},messages:Array.from({length:count},(_,i)=>({id:'old'+i,text:'history '+i}))})
 io.length=0
 return {root,store,domain,io}
}
async function foreground(domain,id='turn-1'){
 const opened=await domain.open('a')
 return domain.commitForeground('a',{operationId:id,basis:opened.basis,userText:'continue',assistantText:'reward'})
}

test('foreground, submitted update, prepared effect and receipt survive fresh readers without duplicate append',async t=>{
 const {root,domain}=await fixture(t)
 const basis=(await domain.open('a')).basis
 const input={operationId:'turn-1',basis,userText:'continue',assistantText:'reward'}
 const committed=await domain.commitForeground('a',input)
 assert.deepEqual(await domain.commitForeground('a',input),committed)
 await domain.submitSettlement('a',{operationId:committed.settlementId,submission:{gold:20}})
 await domain.prepareSettlement('a',{operationId:committed.settlementId,world:{variables:{gold:20},posture:'standing'}})
 const fresh=createConversationState({store:createConversationPageStore({root})})
 const receipt=await fresh.commitSettlement('a',{operationId:committed.settlementId})
 assert.deepEqual(await fresh.commitSettlement('a',{operationId:committed.settlementId}),receipt)
 const opened=await fresh.open('a')
 assert.equal(opened.messageCount,2);assert.equal(opened.state.world.variables.gold,20)
 assert.equal(opened.state.storyRevision,1)
 assert.equal(opened.messages.at(-1).message.settlementStatus,'completed')
 assert.equal((await fresh.readMessageState('a',{position:1,side:'before'})).variables.gold,10)
 assert.equal((await fresh.readMessageState('a',{position:1,side:'after'})).variables.gold,20)
})

test('settlement failure retains body and later foreground supersedes the old task',async t=>{
 const {domain}=await fixture(t)
 const first=await foreground(domain)
 await domain.failSettlement('a',{operationId:first.settlementId,error:'provider failed'})
 assert.equal((await domain.open('a')).messageCount,2)
 assert.equal((await domain.readOperation('a',first.settlementId)).status,'failed')
 await foreground(domain,'turn-2')
 assert.equal((await domain.open('a')).messageCount,4)
 await assert.rejects(domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:99}}),{code:'CONVERSATION_STALE'})
 assert.equal((await domain.open('a')).state.world.variables.gold,10)
})

test('duplicate ids with different inputs fail, while an old duplicate can be read after later rounds',async t=>{
 const {root,domain}=await fixture(t)
 const basis=(await domain.open('a')).basis,input={operationId:'one',basis,userText:'u',assistantText:'a'}
 const first=await domain.commitForeground('a',input)
 await foreground(domain,'two')
 const fresh=createConversationState({store:createConversationPageStore({root})})
 assert.deepEqual(await fresh.commitForeground('a',input),first)
 await assert.rejects(fresh.commitForeground('a',{...input,assistantText:'different'}),{code:'IDEMPOTENCY_CONFLICT'})
 assert.equal((await fresh.open('a')).messageCount,4)
})

test('unrelated metadata revision does not invalidate a prepared settlement',async t=>{
 const {store,domain}=await fixture(t)
 const first=await foreground(domain)
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:20}})
 await domain.prepareSettlement('a',{operationId:first.settlementId,world:{variables:{gold:20}}})
 const current=await store.openConversation('a')
 await store.commit('a',{expectedRevision:current.revision,metadata:{...current.metadata,display:'changed'}})
 await domain.commitSettlement('a',{operationId:first.settlementId})
 assert.equal((await domain.open('a')).state.world.variables.gold,20)
 assert.equal((await domain.open('a')).metadata.display,'changed')
})

test('new foreground and changed body both fence off old prepared effects',async t=>{
 const {store,domain}=await fixture(t)
 const first=await foreground(domain)
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:20}})
 await domain.prepareSettlement('a',{operationId:first.settlementId,world:{variables:{gold:20}}})
 const opened=await store.openConversation('a')
 await store.commit('a',{expectedRevision:opened.revision,edits:[{position:1,message:{...opened.messages[1].message,contentVersionId:'edited'}}]})
 await assert.rejects(domain.commitSettlement('a',{operationId:first.settlementId}),{code:'CONVERSATION_STALE'})
 // Direct store edits deliberately break domain invariants; restore before testing a new turn.
 const changed=await store.openConversation('a')
 await store.commit('a',{expectedRevision:changed.revision,edits:[{position:1,message:opened.messages[1].message}]})
 await foreground(domain,'next')
 await assert.rejects(domain.commitSettlement('a',{operationId:first.settlementId}),{code:'CONVERSATION_STALE'})
 assert.equal((await domain.open('a')).state.world.variables.gold,10)
})

test('explicit cancellation prevents restart from applying a saved effect',async t=>{
 const {root,domain}=await fixture(t)
 const first=await foreground(domain)
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:20}})
 await domain.prepareSettlement('a',{operationId:first.settlementId,world:{variables:{gold:20}}})
 await domain.cancelSettlement('a',{operationId:first.settlementId})
 const fresh=createConversationState({store:createConversationPageStore({root})})
 await assert.rejects(fresh.commitSettlement('a',{operationId:first.settlementId}),{code:'CONVERSATION_STALE'})
 assert.equal((await fresh.open('a')).messageCount,2)
})

test('twenty thousand historical messages stay untouched by foreground and settlement',async t=>{
 const {domain,io}=await fixture(t,20000)
 const first=await foreground(domain)
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:20}})
 await domain.prepareSettlement('a',{operationId:first.settlementId,world:{variables:{gold:20}}})
 await domain.commitSettlement('a',{operationId:first.settlementId})
 assert.ok(io.filter(e=>e.kind==='read'&&e.type==='page').length<20)
 assert.ok(io.filter(e=>e.kind==='write'&&e.type==='page').length<=2)
 assert.equal((await domain.open('a')).messageCount,20002)
})

test('lost acknowledgement can be retried without repeating foreground or settlement',async t=>{
 const {store,domain}=await fixture(t)
 let lose=false
 const unreliable=createConversationState({store:{...store,commit:async(...args)=>{const result=await store.commit(...args);if(lose){lose=false;throw Error('lost acknowledgement')}return result}}})
 const input={operationId:'lost',basis:(await domain.open('a')).basis,userText:'u',assistantText:'a'}
 lose=true
 await assert.rejects(unreliable.commitForeground('a',input),/lost acknowledgement/)
 const first=await unreliable.commitForeground('a',input)
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:20}})
 await domain.prepareSettlement('a',{operationId:first.settlementId,world:{variables:{gold:20}}})
 lose=true
 await assert.rejects(unreliable.commitSettlement('a',{operationId:first.settlementId}),/lost acknowledgement/)
 const receipt=await unreliable.commitSettlement('a',{operationId:first.settlementId})
 assert.equal(receipt.basis.worldRevision,1)
 assert.equal((await domain.open('a')).messageCount,2)
})

test('CAS retry preserves a concurrent metadata update and appends once',async t=>{
 const {store,domain}=await fixture(t)
 let interfere=true
 const racing=createConversationState({store:{...store,commit:async(id,change)=>{
  if(interfere){interfere=false;const view=await store.openConversation(id);await store.commit(id,{expectedRevision:view.revision,metadata:{...view.metadata,title:'concurrent'}})}
  return store.commit(id,change)
 }}})
 await foreground(racing)
 const view=await domain.open('a')
 assert.equal(view.metadata.title,'concurrent');assert.equal(view.messageCount,2)
})

for(const field of ['branchId','worldRevision','lifecycleRevision'])test(field+' changes fence prepared effects',async t=>{
 const {store,domain}=await fixture(t)
 const first=await foreground(domain)
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:20}})
 await domain.prepareSettlement('a',{operationId:first.settlementId,world:{variables:{gold:20}}})
 await assert.rejects(domain.prepareSettlement('a',{operationId:first.settlementId,world:{variables:{gold:30}}}),{code:'IDEMPOTENCY_CONFLICT'})
 const view=await store.openConversation('a')
 await store.commit('a',{expectedRevision:view.revision,state:{...view.state,[field]:field==='branchId'?'another-branch':1}})
 await assert.rejects(domain.commitSettlement('a',{operationId:first.settlementId}),{code:'CONVERSATION_STALE'})
 assert.equal((await domain.open('a')).state.world.variables.gold,10)
})

test('concurrent foregrounds from the same basis cannot both commit',async t=>{
 const {domain}=await fixture(t)
 const basis=(await domain.open('a')).basis
 const results=await Promise.allSettled(['one','two'].map(operationId=>domain.commitForeground('a',{operationId,basis,userText:'u',assistantText:'a'})))
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 assert.equal((await domain.open('a')).messageCount,2)
})

test('domain rejects legacy shadows and malformed input without a write',async t=>{
 const {store,domain}=await fixture(t)
 await store.create('legacy',{state:{},metadata:{format:'legacy-chat-mapping-v1'}})
 await assert.rejects(domain.open('legacy'),{code:'CONVERSATION_FORMAT'})
 await assert.rejects(domain.readMessageState('a',{position:0}),{code:'CONVERSATION_INPUT'})
 const first=await foreground(domain,'x'.repeat(256))
 await assert.rejects(domain.submitSettlement('a',{operationId:first.settlementId}),{code:'CONVERSATION_INPUT'})
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:20}})
 assert.equal((await domain.readOperation('a',first.settlementId)).status,'submitted')
})

test('incremental calculation, durable preparation and wire replay retain derived effects across restart',async t=>{
 const {root,store,domain}=await fixture(t)
 const {createIncrementalJsonState}=await import('../tavern-plugin/lib/domain/incremental-json-state.js')
 const {receiveConversationDelta}=await import('../tavern-plugin/lib/domain/conversation-state.js')
 const first=await foreground(domain),before=await domain.open('a',{includeWorld:false})
 assert.equal(Object.hasOwn(before.state,'world'),false)
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:-3}})
 let calls=0
 await domain.calculateSettlement('a',{operationId:first.settlementId},async state=>{
  calls++
  await state.delta('/variables/gold',-3)
  await state.set('/posture',(await state.get('/variables/gold'))===7?'sitting':'standing')
 })
 await assert.rejects(domain.readSettlementDelta('a',first.settlementId),/No committed delta/)
 const restarted=createConversationState({store:createConversationPageStore({root})})
 await restarted.calculateSettlement('a',{operationId:first.settlementId},()=>{calls++;throw Error('must not rerun')})
 assert.equal(calls,1)
 await restarted.commitSettlement('a',{operationId:first.settlementId})
 const delta=JSON.parse(JSON.stringify(await restarted.readSettlementDelta('a',first.settlementId)))
 assert.equal(delta.mode,'delta');assert.ok(JSON.stringify(delta).length<1000)
 assert.deepEqual(delta.changes,[{op:'set',path:'/variables/gold',value:7},{op:'set',path:'/posture',value:'sitting'}])
 const replica=createIncrementalJsonState({read:ref=>store.readRecord('replica',ref),write:value=>store.writeRecord('replica',value)})
 const initial=await replica.create({variables:{gold:10},posture:'standing'})
 let client=await receiveConversationDelta({tree:replica,root:initial,basis:before.basis},delta)
 assert.equal(await replica.get(client.root,'/variables/gold'),7)
 assert.equal(await replica.get(client.root,'/posture'),'sitting')
 assert.deepEqual(await receiveConversationDelta({tree:replica,...client},delta),client)
 await assert.rejects(receiveConversationDelta({tree:replica,root:initial,basis:{...before.basis,branchId:'other'}},delta),{code:'CONVERSATION_STALE'})
 assert.equal((await restarted.readMessageState('a',{position:1,side:'before'})).variables.gold,10)
 assert.equal((await restarted.readMessageState('a',{position:1,side:'after'})).variables.gold,7)
 assert.equal(await restarted.readWorld('a',{path:'/variables/gold'}),7)
})

test('scalar settlement leaves large unrelated variables out of calculation, head and wire payload',async t=>{
 const {store,domain,io}=await fixture(t)
 await domain.create('large',{world:{variables:{gold:10,unused:'x'.repeat(1000000),fields:Object.fromEntries(Array.from({length:1000},(_,i)=>['f'+i,i]))}}})
 const fg=await domain.commitForeground('large',{operationId:'one',basis:(await domain.open('large',{includeWorld:false})).basis,userText:'u',assistantText:'a'})
 await domain.submitSettlement('large',{operationId:fg.settlementId,submission:{gold:1}})
 io.length=0
 await domain.prepareSettlement('large',{operationId:fg.settlementId,changes:[{op:'delta',path:'/variables/gold',value:1}]})
 await domain.commitSettlement('large',{operationId:fg.settlementId})
 const delta=await domain.readSettlementDelta('large',fg.settlementId)
 assert.ok(io.filter(e=>e.kind==='read').reduce((n,e)=>n+e.bytes,0)<30000)
 assert.ok(io.filter(e=>e.kind==='write').reduce((n,e)=>n+e.bytes,0)<20000)
 assert.ok(JSON.stringify(delta).length<1000)
 const raw=await store.readState('large')
 assert.equal(Object.hasOwn(raw.state??raw,'world'),false)
 assert.equal(await domain.readWorld('large',{path:'/variables/gold'}),11)
 assert.equal((await domain.readWorld('large',{path:'/variables/unused'})).length,1000000)
})

test('bad derived changes cannot partially settle and full-world compatibility stays explicit',async t=>{
 const {domain}=await fixture(t),first=await foreground(domain)
 await domain.submitSettlement('a',{operationId:first.settlementId,submission:{gold:20}})
 await assert.rejects(domain.prepareSettlement('a',{operationId:first.settlementId,changes:[{op:'set',path:'/variables/gold',value:99},{op:'remove',path:'/missing'}]}))
 await assert.rejects(domain.prepareSettlement('a',{operationId:first.settlementId,changes:[{op:'set',path:'/variables',value:null}]}))
 assert.equal(await domain.readWorld('a',{path:'/variables/gold'}),10)
 assert.equal((await domain.readOperation('a',first.settlementId)).status,'submitted')
 await domain.prepareSettlement('a',{operationId:first.settlementId,world:{variables:{gold:20}}})
 await domain.commitSettlement('a',{operationId:first.settlementId})
 assert.equal((await domain.readSettlementDelta('a',first.settlementId)).mode,'snapshot')
})

test('v1 full-world conversations and history remain readable and upgrade on foreground',async t=>{
 const {store,domain}=await fixture(t)
 const old={variables:{gold:5},format:'incremental-world-v1'}
 await store.create('old',{metadata:{format:'conversation-state-v1'},state:{branchId:'old',storyRevision:0,worldRevision:0,lifecycleRevision:0,activeSettlementId:null,world:old},messages:[]})
 assert.deepEqual((await domain.open('old')).state.world,old)
 const fg=await domain.commitForeground('old',{operationId:'new',basis:(await domain.open('old')).basis,userText:'u',assistantText:'a'})
 await domain.submitSettlement('old',{operationId:fg.settlementId,submission:{gold:1}})
 await domain.prepareSettlement('old',{operationId:fg.settlementId,changes:[{op:'delta',path:'/variables/gold',value:1}]})
 await domain.commitSettlement('old',{operationId:fg.settlementId})
 assert.deepEqual((await domain.readMessageState('old',{position:1,side:'before'})),old)
 assert.equal(await domain.readWorld('old',{path:'/variables/gold'}),6)
})
