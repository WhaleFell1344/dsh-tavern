import test from 'node:test'
import assert from 'node:assert/strict'
import {projectChatSessionState} from '../tavern-plugin/lib/domain/chat-session-state.js'
import {createStoryTimeline} from '../tavern-plugin/lib/domain/story-timeline.js'

for(const count of [20,400,10000])test(`session activity ignores ${count} historical checkpoint rows`,()=>{
 let reads=0
 const history=Array.from({length:count},()=>({get text(){reads++;return 'historical body'}}))
 const source={id:'c',messages:[],timeline:{schemaVersion:1,branchId:'b',revision:1,participants:{},operations:{},checkpoints:[{id:'cp',before:{messages:history}}]}}
 const state=projectChatSessionState(source,{messages:[],pendingMvuSettlement:null})
 const view=createStoryTimeline().inspect({chat:state})
 assert.equal(view.checkpointCount,1)
 assert.equal(view.branchId,'b')
 assert.equal(reads,0,`read ${reads} unused historical rows`)
 // Lazy access is still detached and complete when explicitly requested.
 state.timeline.checkpoints[0].before.messages[0].text='changed'
 assert.equal(source.timeline.checkpoints[0].before.messages[0].text,'historical body')
 assert.equal(state.timeline.checkpoints[0].before.messages.length,count)
})

test('ordinary timeline inspect does not clone checkpoint payloads',()=>{
 const timeline={schemaVersion:1,branchId:'b',revision:2,participants:{},operations:{},checkpoints:[{get before(){throw new Error('unexpected history read')}}]}
 assert.equal(createStoryTimeline().inspect({chat:{timeline}}).checkpointCount,1)
})

import {copyLazyHistoryHeader} from '../tavern-plugin/lib/domain/lazy-history-read.js'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'

test('display header checkpoint count is lazy and explicit reads stay complete',()=>{
 let reads=0
 const source={timeline:{checkpoints:[{id:'first',get before(){reads++;return {text:'body'}}}]}}
 const header=copyLazyHistoryHeader(source)
 assert.equal(header.timeline.checkpoints.length,1)
 assert.deepEqual(Object.keys(header.timeline.checkpoints),['0'])
 assert.equal(reads,0)
 assert.deepEqual(JSON.parse(JSON.stringify(header)),JSON.parse(JSON.stringify(source)))
 header.timeline.checkpoints[0].before.text='outside'
 assert.equal(source.timeline.checkpoints[0].before.text,'body')
 assert.equal(copyLazyHistoryHeader(source).timeline.checkpoints[0].before.text,'body')
})

test('journal delta retains revision-bound detached checkpoints and full reads stay cloneable',async t=>{
 const root=await mkdtemp(join(tmpdir(),'timeline-read-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=createChatJournalStore({dataRoot:root})
 await store.update('c',()=>({id:'c',_storageRevision:1,messages:[{role:'assistant',turn:1}],timeline:{schemaVersion:1,branchId:'b',revision:1,participants:{},operations:{},checkpoints:[{id:'old',before:{messages:[{text:'old body'}]}}]}}))
 await store.patch('c',1,[{op:'set',path:['_storageRevision'],value:2}])
 const old=await store.readViewDelta('c',1)
 await store.patch('c',2,[{op:'set',path:['_storageRevision'],value:3},{op:'set',path:['timeline','checkpoints',0,'before','messages',0,'text'],value:'new body'}])
 const next=await store.readViewDelta('c',2)
 assert.equal(old.chat.timeline.checkpoints[0].before.messages[0].text,'old body')
 assert.equal(next.chat.timeline.checkpoints[0].before.messages[0].text,'new body')
 next.chat.timeline.checkpoints[0].before.messages[0].text='outside'
 const full=await store.readSessionState('c')
 assert.equal(structuredClone(full).timeline.checkpoints[0].before.messages[0].text,'new body')
 const fresh=await store.readSessionState('c',{scoped:true})
 assert.equal(fresh.timeline.checkpoints[0].before.messages[0].text,'new body')
})

for(const checkpoints of [null,{},[],[{}]])test(`timeline inspection preserves normalized checkpoint count: ${JSON.stringify(checkpoints)}`,()=>{
 const engine=createStoryTimeline({id:()=> 'b',now:()=>1})
 for(const schemaVersion of [0,1]){
  const chat={timeline:{schemaVersion,branchId:'b',revision:1,checkpoints,operations:{},participants:{}}}
  assert.equal(engine.inspect({chat}).checkpointCount,schemaVersion===1 && Array.isArray(checkpoints) ? checkpoints.length : 0)
 }
})

test('display header does not copy unused undo history',()=>{
 let reads=0
 const source={rollbackUndo:{version:1,ready:true,foreground:{afterCount:10000,nodes:Array.from({length:10000},(_,i)=>({get seq(){reads++;return i}}))},background:[{get nodes(){reads++;return [1,2,3]}}],before:{get messages(){reads++;return [{text:'old body'}]}}}}
 const header=copyLazyHistoryHeader(source)
 assert.equal(header.rollbackUndo.foreground.afterCount,10000)
 assert.equal(header.rollbackUndo.foreground.nodes.length,10000)
 assert.equal(reads,0)
 assert.equal(header.rollbackUndo.foreground.nodes[9999].seq,9999)
 assert.deepEqual(header.rollbackUndo.background[0].nodes,[1,2,3])
 header.rollbackUndo.before.messages[0].text='outside'
 assert.equal(source.rollbackUndo.before.messages[0].text,'old body')
})
