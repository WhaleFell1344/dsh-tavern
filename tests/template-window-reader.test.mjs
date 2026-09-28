import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'
import {createTemplateWindowReader,templateStateFields} from '../tavern-plugin/lib/domain/template-window-reader.js'
import {createTavernScriptHostAdapter} from '../tavern-plugin/lib/domain/tavern-script-host-adapter.js'

test('short native histories retain template cursors instead of full windows on every refresh',async t=>{
 const root=await mkdtemp(join(tmpdir(),'template-short-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const store=createChatJournalStore({dataRoot:root,newConversations:true})
 await createChatPersistence({store}).write({id:'chat',sessionId:'s',mode:'story',backgroundConfigVersion:1,conversationFeaturesVersion:1,
  cardDefinitionSnapshot:{name:'saved card',description:'large'.repeat(100000)},messages:[{role:'assistant',text:'hello'}]})
 let full=0,windows=0
 const resolveTemplateWindow=createTemplateWindowReader({links:async()=>({s:'chat'}),completeSessions:new Set(),access:{issue:()=>{throw Error('short histories need no window lease')}},
  readWindow:(id,options)=>{windows++;assert.equal(options.requirePartial,true);return store.readWindow(id,options)}})
 const adapter=createTavernScriptHostAdapter({resolveTemplateWindow,writeChat:async()=>{throw Error("unexpected write")},
  resolveChat:()=>{full++;return store.read('chat')},resolveChatMetadataSlice:()=>store.readSlice('chat',[],templateStateFields),
  readCard:async chat=>{assert.equal(chat.cardDefinitionSnapshot.name,'saved card');return chat.cardDefinitionSnapshot},worldBooks:{bound:async()=>null},scriptDispatch:{}})
 const first=await adapter.readFullPromptTemplateState('s',undefined,true)
 assert.ok(first.cursor);assert.equal(first.historyWindow,undefined)
 const second=await adapter.readFullPromptTemplateState('s',first.cursor,true)
 assert.deepEqual(second.delta.chat.set,[]);assert.equal(full,1);assert.equal(windows,2)
})

test('long history retains its bounded window and virtual input count',async()=>{
 let issued
 const window={chat:{sessionId:'s',backgroundConfigVersion:1,conversationFeaturesVersion:1,promptTemplateInput:{message:{}}},from:50,messageCount:250,revision:9}
 const read=createTemplateWindowReader({links:async()=>({s:'chat'}),completeSessions:new Set(['full']),
  access:{issue:value=>(issued=value,{token:'lease'})},readWindow:async()=>window})
 assert.equal(await read('full'),undefined)
 assert.deepEqual((await read('s')).historyWindow,{token:'lease',from:50,messageCount:251})
 assert.equal(issued.messageCount,250)
})

test('large character template projection remains cached and observes edits',async t=>{
 const card={name:'large',description:'x'.repeat(9*1024*1024)}
 const adapter=createTavernScriptHostAdapter({resolveChat:async()=>({id:'c',sessionId:'s',mode:'story',_storageRevision:1,messages:[]}),
  writeChat:async()=>{},readCard:async()=>structuredClone(card),worldBooks:{bound:async()=>null},scriptDispatch:{}})
 const first=await adapter.readFullPromptTemplateState('s')
 const stringify=JSON.stringify;let characterSerializations=0
 t.mock.method(JSON,'stringify',(value,...args)=>{if(Array.isArray(value)&&value[0]?.data?.name==='large')characterSerializations++;return stringify(value,...args)})
 const second=await adapter.readFullPromptTemplateState('s',first.cursor)
 assert.equal(characterSerializations,0,'unchanged large characters must not be rebuilt and re-fingerprinted')
 assert.equal(second.delta.environment.set.characters,undefined)
 card.description='updated'
 const third=await adapter.readFullPromptTemplateState('s',second.cursor)
 assert.equal(third.delta.environment.set.characters[0].description,'updated')
 assert.equal(first.environment.characters[0].description.length,9*1024*1024)
})
