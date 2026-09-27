import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServerTemplateRuntime} from '../tavern-plugin/lib/domain/server-template-runtime.js'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'
import {createChatPersistence} from '../tavern-plugin/lib/domain/chat-persistence.js'
import {createProfileDataStore} from '../tavern-plugin/lib/profile-data-store.js'
import {createTavernExtensionSettings} from '../tavern-plugin/lib/domain/tavern-extension-settings.js'
import {createPromptTemplateGlobalVariables} from '../tavern-plugin/lib/domain/prompt-template-global-variables.js'
import {createTavernScriptHostAdapter} from '../tavern-plugin/lib/domain/tavern-script-host-adapter.js'

test('server engine uses real journal, delta snapshots, persistent variable writes and external changes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'server-template-native-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const open=()=>createChatPersistence({store:createChatJournalStore({dataRoot:root})})
 const persistence=open(),store=createProfileDataStore({dataRoot:root})
 await persistence.write({id:'chat',sessionId:'s',cardPath:'cards/test.json',mode:'story',variables:{},messages:[{role:'assistant',text:'Opening',variables:[{hp:7}]}]})
 await createTavernExtensionSettings(store).save({EjsTemplate:{enabled:true,autosave_enabled:true}}, {})
 const globals=createPromptTemplateGlobalVariables(store)
 let model='first'
 const adapter=createTavernScriptHostAdapter({resolveChat:()=>persistence.read('chat'),writeChat:persistence.write,updateChat:persistence.update,readChatRevision:persistence.readRevision,
 readCard:async()=>({name:'Alice',mes_example:'',description:'',personality:'',scenario:''}),scriptDispatch:{},globalVariables:globals,fullExtensionSettings:createTavernExtensionSettings(store),modelFor:()=>model,
 worldBooks:{bound:async()=>({source:{kind:'standalone',path:'book'},view:{displayName:'book'}}),export:async()=>({document:{entries:{0:{uid:0,comment:'Guide',key:[],constant:true,content:'HP <%= getMessageVar("hp") %>',position:0,order:100}}}})}})
 const sync=[]
 const runtime=createServerTemplateRuntime({store,onDiagnostic:diagnostic=>t.diagnostic(JSON.stringify(diagnostic)),rpc:async(method,args)=>{
  if(method==='getFullPromptTemplateState'){const result=await adapter.readFullPromptTemplateState(args.sessionId,args.cursor);sync.push(result.delta?'delta':'full');return result}
  if(method==='saveFullPromptTemplateSettings')return adapter.saveFullPromptTemplateSettings(args.sessionId,args.settings,args.expectedSettings)
  if(method==='saveFullPromptTemplateState')return adapter.saveFullPromptTemplateState(args.sessionId,args.state)
  if(method==='saveFullPromptTemplateGlobals')return adapter.saveFullPromptTemplateGlobals(args.sessionId,args.variables,args.expectedVariables)
  if(method==='countFullTemplateTokens')return {tokens:args.text.length}
  throw Error(method)
 }})
 t.after(()=>runtime.dispose())
 const engine=runtime.forSession('s')
 assert.equal((await engine.render('<%= charName %>:<%= getMessageVar("hp") %>')).text,'Alice:7')
 await engine.command('/ejs <% setMessageVar("hp",9) %>')
 assert.equal((await open().read('chat')).messages[0].variables[0].hp,9)
 const result=await engine.projectRequest({system:'fixed system',messages:[{role:'user',content:'<%- await getWorldInfo("Guide") %>'}],model:'selected'})
 assert.equal(result.messages[0].content,'HP 9')
 assert.equal(result.system,'fixed system')
 await createPromptTemplateGlobalVariables(createProfileDataStore({dataRoot:root})).save({weather:'rain'})
 model='second'
 assert.equal((await engine.render('<%= getGlobalVar("weather") %>|<%= window.SillyTavern.getContext().dsh.model %>')).text,'rain|second')
 assert.equal(sync[0],'full');assert.ok(sync.slice(1).every(mode=>mode==='delta'))
 await runtime.synchronize('s')
 assert.ok((await open().read('chat')).messages[0].tavernPluginData.template_rendered)
})

test('native window engine persists an old-floor variable edit without a full Chat read',async t=>{
 const {createHelperHistoryAccess}=await import('../tavern-plugin/lib/domain/helper-history-access.js')
 const root=await mkdtemp(join(tmpdir(),'template-native-window-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const persistence=createChatPersistence({store:createChatJournalStore({dataRoot:root,newConversations:true})})
 const store=createProfileDataStore({dataRoot:root}),settings=createTavernExtensionSettings(store)
 await persistence.write({id:'chat',sessionId:'s',mode:'story',cardPath:'card',variables:{},messages:Array.from({length:300},(_,i)=>({role:'assistant',turn:i+1,text:'floor '+i,variables:[{hp:i}]}))})
 await settings.save({EjsTemplate:{enabled:true,autosave_enabled:true}}, {})
 let fullReads=0,historyReads=0
 const access=createHelperHistoryAccess({read:(id,range)=>{historyReads++;return persistence.readHelperContext(id,range)}})
 const adapter=createTavernScriptHostAdapter({
  resolveChat:()=>{fullReads++;return persistence.read('chat')},writeChat:persistence.write,readChatRevision:persistence.readRevision,updateChat:persistence.update,
  patchChat:persistence.patch,resolveChatSlice:(_id,indices,fields)=>persistence.readSlice('chat',indices,fields),
  resolveTemplateWindow:async()=>{const w=await persistence.readWindow('chat',{limit:200});return {chat:w.chat,historyWindow:{...access.issue({chatId:'chat',revision:w.revision,messageCount:w.messageCount}),from:w.from}}},
  readCard:async()=>({name:'Alice',mes_example:'',description:'',personality:'',scenario:''}),scriptDispatch:{},
  fullExtensionSettings:settings,globalVariables:createPromptTemplateGlobalVariables(store),
  worldBooks:{templateSnapshot:async()=>({worldName:'',worldbooks:{}})}
 })
 const runtime=createServerTemplateRuntime({store,rpc:async(method,args)=>{
  if(method==='getFullPromptTemplateState')return adapter.readFullPromptTemplateState('s',args.cursor,args.openingWindow===1)
  if(method==='getPromptTemplateHistory')return access.read(args.token,args.messageId,args.messageId)
  if(method==='saveFullPromptTemplateState')return adapter.saveFullPromptTemplateState('s',args.state)
  if(method==='saveFullPromptTemplateSettings')return adapter.saveFullPromptTemplateSettings('s',args.settings,args.expectedSettings)
  if(method==='saveFullPromptTemplateGlobals')return adapter.saveFullPromptTemplateGlobals('s',args.variables,args.expectedVariables)
  throw Error(method)
 }})
 t.after(()=>runtime.dispose())
 const result=await runtime.forSession('s').render('<% window.SillyTavern.getContext().chat[3].variables[0].hp=77; await window.SillyTavern.getContext().saveChatConditional(); %>saved')
 assert.equal(result.text,'saved')
 assert.equal((await persistence.readSlice('chat',[3])).chat.messages[0].variables[0].hp,77)
 assert.equal(fullReads,0)
 assert.equal(historyReads,1)
})
