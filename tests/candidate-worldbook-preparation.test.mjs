import test from 'node:test'
import assert from 'node:assert/strict'
import {createCandidateWorldbookPreparation} from '../tavern-plugin/lib/domain/candidate-worldbook-preparation.js'

function harness(){
 let revision=1,resources='settings-1',calls=0,prepare=async()=>({context:'round '+revision,prefixContext:'fixed'})
 const cache=createCandidateWorldbookPreparation({version:async()=>({revision,resources}),prepare:async()=>{calls++;return prepare()},onError:()=>{}})
 return {cache,get calls(){return calls},set prepare(value){prepare=value},set resources(value){resources=value},change(source){revision++;cache.changed({sessionId:'s',_storageRevision:revision},{source})},external(){revision++}}
}
test('round preparation is reused when candidate command metadata advances',async()=>{
 const h=harness();await h.cache.warm('s');assert.equal(h.calls,1)
 for(const source of ['candidate.mailbox.preparing','background.candidate.begin','background.candidate.bind','background.candidate.commit','candidate.mailbox.completed'])h.change(source)
 const result=await h.cache.get('s');assert.equal(h.calls,1);assert.equal(result.context,'round 1')
 result.context='caller mutation';assert.equal((await h.cache.get('s')).context,'round 1')
})
test('variables, body, resources, unknown revisions and rollback invalidate prepared state',async()=>{
 const h=harness();await h.cache.warm('s')
 for(const source of ['mvu.patch','body.commit','rollback','card.reload']){h.change(source);await h.cache.get('s')}
 assert.equal(h.calls,5)
 h.resources='settings-2';await h.cache.get('s');assert.equal(h.calls,6)
 h.external();h.change('candidate.mailbox.preparing');await h.cache.get('s');assert.equal(h.calls,7)
})
test('click joins preparation already running after settlement without evaluating twice',async()=>{
 const h=harness();let release;h.prepare=()=>new Promise(resolve=>{release=resolve})
 const pending=h.cache.warm('s');await new Promise(resolve=>setImmediate(resolve))
 const click=h.cache.get('s');release({context:'ready'})
 assert.equal((await click).context,'ready');await pending;assert.equal(h.calls,1)
})
test('concurrent state changes cannot publish stale prepared output or replay template effects',async()=>{
 const h=harness();let release;h.prepare=()=>new Promise(resolve=>{release=resolve})
 const pending=h.cache.get('s');await new Promise(resolve=>setImmediate(resolve))
 h.change('mvu.patch');release({context:'old'})
 await assert.rejects(pending,{code:'CANDIDATE_CONTEXT_CHANGED'});assert.equal(h.calls,1)
 h.prepare=async()=>({context:'new'});assert.equal((await h.cache.get('s')).context,'new')
})
test('failed warmup does not become a successful cached context',async()=>{
 const h=harness();h.prepare=async()=>{throw Error('template failed')};await h.cache.warm('s')
 h.prepare=async()=>({context:'recovered'});assert.equal((await h.cache.get('s')).context,'recovered');assert.equal(h.calls,2)
})

test('no-op variable saves with the same authoritative revision retain preparation',async()=>{
 let calls=0
 const cache=createCandidateWorldbookPreparation({version:async()=>({revision:12,resources:'same'}),prepare:async()=>{calls++;return {context:'ready'}}})
 await cache.warm('s')
 cache.changed({sessionId:'s',_storageRevision:12},{source:'tavern-helper.variables'})
 await cache.get('s');assert.equal(calls,1)
})

test('real native task commits retain preparation but variable commits invalidate it',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {createChatJournalStore}=await import('../tavern-plugin/lib/domain/chat-journal-store.js')
 const {createChatPersistence}=await import('../tavern-plugin/lib/domain/chat-persistence.js')
 const root=await mkdtemp(join(tmpdir(),'candidate-round-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const p=createChatPersistence({store:createChatJournalStore({dataRoot:root,newConversations:true})})
 await p.write({id:'c',sessionId:'s',variables:{hp:1},messages:[{role:'assistant',text:'body'}]})
 let calls=0
 const cache=createCandidateWorldbookPreparation({
  version:async()=>({revision:(await p.readSlice('c',[],['_storageRevision'])).chat._storageRevision,resources:'pinned'}),
  prepare:async()=>{calls++;return {context:String((await p.readSlice('c',[],['variables'])).chat.variables.hp)}}
 })
 await cache.warm('s')
 const write=async(path,value,source)=>{
  const before=(await p.readSlice('c',[],['_storageRevision'])).chat
  cache.changed(await p.patch('c',before._storageRevision,[{op:'set',path,value}],{returnProjection:['sessionId','_storageRevision']}),{source})
 }
 await write(['taskMailbox'],{tasks:{}},'candidate.mailbox.preparing')
 assert.equal((await cache.get('s')).context,'1');assert.equal(calls,1)
 await write(['variables','hp'],2,'tavern-helper.variables')
 assert.equal((await cache.get('s')).context,'2');assert.equal(calls,2)
 assert.equal((await p.read('c')).messages[0].text,'body')
})

test('initialization normalizes settings before pinning template dependencies',async()=>{
 let resources='before-init',calls=0,connections=0
 const cache=createCandidateWorldbookPreparation({version:async()=>({revision:1,resources}),
  ready:async()=>{connections++;resources='initialized'},prepare:async()=>{calls++;return {context:resources}}})
 await cache.warm('s')
 assert.equal((await cache.get('s')).context,'initialized')
 assert.equal(calls,1);assert.equal(connections,1)
})

test('partial template diagnostics are not retained as a reusable success',async()=>{
 const h=harness();h.prepare=async()=>({context:'partial',diagnostics:[{code:'runtime-error'}]})
 await h.cache.warm('s');await h.cache.get('s');assert.equal(h.calls,2)
})
