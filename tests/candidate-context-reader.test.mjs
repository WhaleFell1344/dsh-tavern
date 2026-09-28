import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCandidateContextReader} from '../tavern-plugin/lib/domain/candidate-context-reader.js'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'

test('native candidate projection leaves large card scripts and historic bodies unread',async t=>{
 const root=await mkdtemp(join(tmpdir(),'candidate-context-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const p=createChatPersistence({store:createChatJournalStore({dataRoot:root,newConversations:true})})
 await p.write({id:'c',sessionId:'s',mode:'story',backgroundConfigVersion:1,conversationFeaturesVersion:1,
  cardDefinitionSnapshot:{name:'Test',description:'setting',extensions:{script:'x'.repeat(4*1024*1024)}},
  openingWorldbookSnapshot:{version:1,document:null},
  messages:Array.from({length:150},(_,i)=>({role:'assistant',text:i<110?'old'.repeat(10000):'recent '+i,variables:[{hp:i}]}))})
 const windows=[]
 const reader=createCandidateContextReader({headerForSession:async()=>({id:'c'}),readChat:async()=>{throw Error('full Chat read')},readWindow:async(id,options)=>{windows.push(options);return p.readWindow(id,options)}})
 const chat=await reader.forSession('s')
 assert.equal(windows.length,1)
 assert.equal(chat.messages.length,32)
 assert.equal(chat.messages.at(-1).text,'recent 149')
 assert.deepEqual(chat.cardDefinitionSnapshot,{name:'Test',description:'setting'})
 chat.messages.at(-1).text='changed'
 assert.equal((await reader.read('c')).messages.at(-1).text,'recent 149')
 assert.equal((await p.read('c')).messages.length,150)
})

test('sparse assistant context pages at one revision and retains the latest variable scope',async()=>{
 const calls=[]
 const header={id:'c',cardDefinitionSnapshot:{name:'Test'},openingWorldbookSnapshot:{version:1,document:null}}
 const reader=createCandidateContextReader({headerForSession:async()=>header,readChat:async()=>{throw Error('full read')},readWindow:async(_id,options)=>{
  calls.push(options)
  return options.before===undefined?{chat:{...header,messages:[{role:'user',text:'new'}]},from:32,revision:9}:
    {chat:{messages:[{role:'assistant',text:'old',variables:[{hp:3}]}]},from:0,revision:9}
 }})
 const chat=await reader.read('c')
 assert.equal(calls[1].revision,9)
 assert.equal(chat.messages[0].variables[0].hp,3)
 assert.equal(chat.messages.at(-1).text,'new')
})
