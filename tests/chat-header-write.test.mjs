import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'

const header = ({messages, ...head}) => structuredClone(head)
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'header-write-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const journal=createChatJournalStore({dataRoot:root})
  await journal.update('a',()=>({id:'a',sessionId:'s',_storageRevision:1,variables:{gold:1},messages:Array.from({length:20000},(_,i)=>({role:'assistant',turn:i+1,text:'history '+i,variables:[{gold:i}]}))}))
  const forbidden=()=>{throw Error('full-history read/write must not run')}
  return {journal,persistence:createChatPersistence({store:{...journal,read:forbidden,update:forbidden,readRevision:forbidden},now:()=>100})}
}

test('foreground header writes merge concurrent rows without copying or updating full history',async t=>{
  const {journal,persistence}=await fixture(t)
  const chat=await journal.read('a'),base=header(chat),first=chat.messages[0]
  chat.preparedWorldBookContext='new worldbook'
  await journal.patch('a',1,[{op:'set',path:['messages',19999,'variables',0,'gold'],value:900},{op:'set',path:['_storageRevision'],value:2}])
  const next=await persistence.writeHeader(chat,base,{source:'foreground.prepare'})
  assert.equal(chat.messages[0],first)
  assert.equal(chat.messages.length,20000)
  assert.equal(chat.messages[19999].variables[0].gold,900)
  assert.equal(next._storageRevision,3)
  assert.equal(chat._storageRevision,3)
  assert.equal(next.messages,undefined)
  const saved=await journal.readSlice('a',[19999])
  assert.equal(saved.chat.preparedWorldBookContext,'new worldbook')
  assert.equal(saved.chat.messages[0].variables[0].gold,900)
  chat.variables.gold=2
  await persistence.writeHeader(chat,next)
  assert.equal((await journal.readSlice('a',[])).chat.variables.gold,2)
})

test('header writer rejects conflicting metadata and retains deletion semantics',async t=>{
  const {journal,persistence}=await fixture(t)
  const chat=await journal.read('a'),base=header(chat)
  chat.variables.gold=2
  await journal.patch('a',1,[{op:'set',path:['variables','gold'],value:3},{op:'set',path:['_storageRevision'],value:2}])
  await assert.rejects(persistence.writeHeader(chat,base),{code:'DSH_TAVERN_CHAT_CONFLICT'})
  const fresh=await journal.read('a'),before=header(fresh)
  delete fresh.variables.gold
  await persistence.writeHeader(fresh,before)
  assert.deepEqual((await journal.readSlice('a',[])).chat.variables,{})
})

test('header revision promotion also refreshes concurrent append and truncation',async t=>{
 const {journal,persistence}=await fixture(t)
 const chat=await journal.read('a');let base=header(chat)
 chat.preparedWorldBookContext='append'
 await journal.patch('a',1,[{op:'splice',path:['messages'],index:20000,deleteCount:0,items:[{text:'new floor'}]},{op:'set',path:['_storageRevision'],value:2}])
 base=await persistence.writeHeader(chat,base)
 assert.equal(chat.messages.length,20001)
 assert.equal(chat.messages.at(-1).text,'new floor')
 await journal.patch('a',3,[{op:'splice',path:['messages'],index:19999,deleteCount:2,items:[]},{op:'set',path:['_storageRevision'],value:4}])
 chat.preparedWorldBookContext='truncated'
 await persistence.writeHeader(chat,base)
 assert.equal(chat.messages.length,19999)
 assert.equal(chat._storageRevision,5)
})

test('missing change coverage falls back to current history, not an old revision merge',async t=>{
 const {journal}=await fixture(t)
 let fullReads=0
 const persistence=createChatPersistence({store:{...journal,read:async id=>{fullReads++;return journal.read(id)},readChangedSlice:async()=>undefined,readRevision:()=>{throw Error('old revision recovery')}}})
 const chat=await journal.read('a'),base=header(chat)
 chat.preparedWorldBookContext='changed'
 await journal.patch('a',1,[{op:'set',path:['messages',0,'text'],value:'concurrent edit'},{op:'set',path:['_storageRevision'],value:2}])
 await persistence.writeHeader(chat,base)
 assert.equal(fullReads,1)
 assert.equal(chat.messages[0].text,'concurrent edit')
})

test('foreground preparation keeps its detached history without another timeline copy',async()=>{
 const {createTurnOrchestrator}=await import('../tavern-plugin/lib/domain/turn-orchestration.js')
 const {createStoryTimeline}=await import('../tavern-plugin/lib/domain/story-timeline.js')
 const {createForegroundFrameBuilder}=await import('../tavern-plugin/lib/domain/agent-input-frame.js')
 const messages=Array.from({length:20000},()=>({role:'assistant',get text(){throw Error('preparation must not copy historical bodies')}}))
 let saved
 const orchestrator=createTurnOrchestrator({
  store:{chatForSession:async()=>({id:'a',sessionId:'s',cardPath:'card.json',mode:'story',messages,_storageRevision:1}),readCard:async()=>({name:'Card'}),
   writeChatHeader:async chat=>{saved=chat;return header(chat)}},
  timeline:createStoryTimeline(),frameBuilder:createForegroundFrameBuilder(),planner:{plan:async()=>({text:'context'})}
 })
 const prepared=await orchestrator.prepare({sessionId:'s',turn:10001,userText:'continue'})
 assert.equal(prepared.ready,true)
 assert.equal(saved.messages,messages)
 assert.equal(saved.messages.length,20000)
 assert.equal(Object.values(saved.timeline.operations)[0].kind,'body')
})
