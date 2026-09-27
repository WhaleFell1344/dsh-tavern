import {projectTavernHelperContext,projectTavernHelperMessage} from './tavern-helper-context.js'
import {projectSessionMessage,projectChatSessionState} from './chat-session-state.js'
import {createScopedMessages} from './scoped-messages.js'
import {createBufferedJsonRecords} from './buffered-json-records.js'
import path from 'node:path'
import {createConversationPageStore} from './conversation-page-store.js'
import {createConversationState} from './conversation-state.js'
import {createIncrementalJsonState} from './incremental-json-state.js'
import {diffJson} from './json-mutation.js'

const pointer=parts=>parts.length?'/'+parts.map(part=>String(part).replace(/~/g,'~0').replace(/\//g,'~1')).join('/'):''
const failure=(code,message)=>Object.assign(new Error(message),{code})
const header=({messages,...value})=>value

/** Native pages/current-state storage behind the existing runtime Chat API.
 * Chat is a detached projection, never an authoritative monolithic disk blob.
 * Existing MVU receipts, sessions and undo metadata remain owned by the runtime;
 * this bridge publishes their changed rows and current world in ONE head CAS.
 * Full read/update remain explicit compatibility materializations. No migration.
 */
export function createNativeConversationStorage({dataRoot,onIO}){
 const pages=createConversationPageStore({root:path.join(dataRoot,'chats'),onIO})
 const domain=createConversationState({store:pages})
 // Request-local, bounded block reuse. Full reads still return independent JSON
 // values, but shared historical snapshots are not fetched from disk per row.
 function tree(id){
  const cache=new Map();let bytes=0
  return createIncrementalJsonState({async read(ref){
   let entry=cache.get(ref)
   if(entry){cache.delete(ref);cache.set(ref,entry)}
   else {
    const value=await pages.readRecord(id,ref),size=Buffer.byteLength(JSON.stringify(value))*2
    entry={value,size}
    if(size<=8*1024*1024){
     while(cache.size&&bytes+size>8*1024*1024){const key=cache.keys().next().value;bytes-=cache.get(key).size;cache.delete(key)}
     cache.set(ref,entry);bytes+=size
    }
   }
   return structuredClone(entry.value)
  },write:value=>pages.writeRecord(id,value)})
 }
 async function head(id,snapshotId){
  const view=await pages.readHead(id,snapshotId?{snapshotId}:{})
  if(view&&(view.metadata?.format!=='conversation-state-v2'||view.metadata.settings?.runtimeLayout!==1))throw failure('CHAT_STORAGE_FORMAT','Unsupported native runtime layout')
  return view
 }
 async function version(id){const view=await head(id);return view?'native:'+view.snapshotCursor.snapshotId:null}
 function result(chat,view){return {chat,revision:chat._storageRevision,native:{view},legacy:false,snapshot:null,open:null,openFrameCount:0,openInvalidLine:0}}
 async function read(id,revision=Infinity){
  let view=await head(id)
  if(!view)return null
  if(revision!==Infinity&&revision!==view.state.chatRevision){
   const ref=(await pages.readEntries(id,['chat-revision:'+revision],{snapshotId:view.snapshotCursor.snapshotId}))['chat-revision:'+revision]
   if(!ref)throw failure('DSH_TAVERN_REVISION_NOT_FOUND','Native Chat revision not found: '+revision)
   view=await head(id,ref)
  }
  const t=tree(id),chat=await t.get(view.state.chatHeaderRef)
  const messages=new Array(view.messageCount)
  let cursor=view.snapshotCursor
  while(cursor){
   const page=await pages.readHistoryPage(id,{cursor,limit:500})
   for(const row of page.messages)messages[row.position]=await t.get(row.message.runtimeRef)
   cursor=page.previousCursor
  }
  chat.messages=messages
  if(chat.id!==id||chat._storageRevision!==view.state.chatRevision)throw failure('CHAT_STORAGE_DAMAGED','Native Chat revision mismatch')
  return result(chat,view)
 }
 async function selectedHeader(id,view,fields){
  const t=tree(id),root=view.state.chatHeaderRef
  if(!Array.isArray(fields)&&fields!=='settlement')return t.get(root)
  const result={}
  const paths=Array.isArray(fields)?fields:await t.keys(root)
  for(const field of paths){
   const parts=String(field).split('.').filter(Boolean)
   if(!parts.length||parts[0]==='messages'||parts.some(part=>['__proto__','prototype','constructor'].includes(part)))continue
   let value
   if(fields==='settlement'&&field==='timeline'&&await t.type(root,'/timeline')==='object'){
    value={}
    for(const key of await t.keys(root,'/timeline'))if(key!=='checkpoints')Object.defineProperty(value,key,{value:await t.get(root,pointer(['timeline',key])),enumerable:true,writable:true,configurable:true})
    value.checkpoints=[]
   }else value=await t.get(root,pointer(parts))
   if(value===undefined)continue
   let target=result
   for(const key of parts.slice(0,-1))target=target[key]??={}
   target[parts.at(-1)]=value
  }
  return result
 }
 async function readSlice(id,indices=[],fields){
  const view=await head(id)
  if(!view)return null
  if(indices.some(index=>index>=view.messageCount))return undefined
  if(indices.some(index=>!Number.isSafeInteger(index)||index<0))throw Error('消息楼层不存在')
  const chat=await selectedHeader(id,view,fields),t=tree(id)
  chat.messages=[]
  const sorted=[...new Set(indices)].sort((a,b)=>a-b),references=new Map()
  for(let start=0;start<sorted.length;){
   let end=start
   while(end+1<sorted.length&&sorted[end+1]-sorted[start]<500)end++
   const selected=await pages.readHistoryPage(id,{cursor:{snapshotId:view.snapshotCursor.snapshotId,before:sorted[end]+1},limit:sorted[end]-sorted[start]+1})
   for(const row of selected.messages)references.set(row.position,row.message.runtimeRef)
   start=end+1
  }
  for(const position of indices)chat.messages.push(await t.get(references.get(position)))
  return {chat,messageCount:view.messageCount,denseMessages:true}
 }
 // Helper owns a read projection, not an editable runtime Chat. Bind header
 // and every page to one immutable head, even while another writer appends.
 async function readHelperContext(id,range){
  const view=await head(id)
  if(!view)return null
  const chat=await selectedHeader(id,view,range?['id','sessionId','_storageRevision','backgroundConfigVersion','conversationFeaturesVersion']:'settlement'),t=tree(id)
  const from=range?Math.max(0,Number(range.from)||0):0
  const to=range?Math.min(view.messageCount-1,Number.isSafeInteger(Number(range.to))?Number(range.to):view.messageCount-1):view.messageCount-1
  if(!Number.isSafeInteger(from))throw Error('消息楼层不存在: '+from)
  const messages=[],turnMessageIds={}
  const fields=['role','tavernRole','tavernHidden','name','turn','greeting','swipeId','swipes','sourceText','text','variables','tavernPluginData']
  for(let start=from;start<=to;start+=500){
   const page=await pages.readHistoryPage(id,{cursor:{snapshotId:view.snapshotCursor.snapshotId,before:Math.min(to+1,start+500)},limit:Math.min(500,to-start+1)})
   for(const {position,message} of page.messages){
    const source={}
    for(const field of fields){
     const value=await t.get(message.runtimeRef,'/'+field)
     if(value!==undefined)source[field]=value
    }
    const projected=projectTavernHelperMessage(source,position)
    messages.push(projected)
    const turn=Math.max(0,Number(source.turn)||(source.greeting===true?1:0))
    if(projected.role==='assistant'&&turn>0)turnMessageIds[String(turn)]=position
   }
  }
  const context={...projectTavernHelperContext({...chat,messages:[]}),messages,turnMessageIds}
  return {chat,context,from,to}
 }
 async function readSessionState(id,options={}){
  const view=await head(id)
  if(!view)return null
  const chat=await selectedHeader(id,view,['id','sessionId','_storageRevision','mode','cardPath','cardContextRevision',
   'backgroundConfigVersion','conversationFeaturesVersion','disabledWritingSkills','contextCompaction','updatedAt','timeline','candidateAgent',
   'cardName','requestMode','statusBarPlacement','webSearchEnabled','candidates','taskMailbox','regenInProgress','settleError','scriptState',
   'hiddenDshErrorTurns','suppressedDshTurns','regeneratedDshTurns','tavernHelperLifecycleRevision','importHistory','rollbackUndo','pendingMvuSettlement'])
  if(Object.values(chat.timeline?.operations??{}).some(op=>op?.kind==='body'&&op.status==='foreground-completed'))return projectChatSessionState((await read(id)).chat)
  const messages=new Array(view.messageCount),t=tree(id)
  let cursor=view.snapshotCursor,pending=null
  while(cursor){
   const page=await pages.readHistoryPage(id,{cursor,limit:500})
   for(const {position,message} of [...page.messages].reverse()){
    let summary=message.session
    // Older native pages lack the optional compact projection. Preserve their
    // contract with a per-row fallback; subsequent edits persist the summary.
    if(!summary){const row=await t.get(message.runtimeRef);summary=sessionSummary(row)}
    messages[position]=projectSessionMessage(summary.message)
    if(pending===null&&summary.pending)pending=summary.pending
   }
   cursor=page.previousCursor
  }
  chat.messages=messages
  return projectChatSessionState(chat,{pendingMvuSettlement:options.scoped!==true&&Object.hasOwn(chat,'pendingMvuSettlement')?chat.pendingMvuSettlement:pending,...(options.scoped===true?{messages:createScopedMessages(messages.length,[],position=>structuredClone(messages[position]))}:{})})
 }
 function sessionSummary(row){return JSON.parse(JSON.stringify({message:projectSessionMessage(row),pending:row.role==='assistant'&&row.mvu?.pending===true?{
  hasSubmission:Boolean(row.mvu.pendingSubmission),prepared:Boolean(row.mvu.delivery?.prepared)}:null}))}
 function currentWorld(chat){
  for(let position=(chat.messages?.length??0)-1;position>=0;position--){
   const row=chat.messages[position],swipe=Math.max(0,Number(row.swipeId)||0)
   const variables=row.variables?.[swipe]
   if(variables&&typeof variables==='object'&&!Array.isArray(variables))return {position,swipe,world:{variables,...(chat.posture!==undefined?{posture:chat.posture}:{})}}
  }
  return {position:null,swipe:0,world:{variables:{},...(chat.posture!==undefined?{posture:chat.posture}:{})}}
 }
 async function encode(id,row,previous,changes,t=tree(id)){
  const runtimeRef=previous?await mutate(t,previous.runtimeRef,changes,row):await t.create(row)
  // Pages contain identity + references only; large variables/body/extension
  // payloads live in the incremental tree and share unchanged hashed blocks.
  return {runtimeRef,session:sessionSummary(row),...(row.id!==undefined?{id:row.id}:{}),...(row.role!==undefined?{role:row.role}:{})}
 }
 async function mutate(t,root,changes,next){
  try{
   for(const change of changes){
    const p=pointer(change.path)
    if(change.op==='set')root=(await t.apply(root,[{op:'set',path:p,value:change.value}])).nextRoot
    else if(change.op==='delete')root=(await t.apply(root,[{op:'remove',path:p}])).nextRoot
    else if(change.op==='splice'){
     const length=await t.size(root,p)
     if(change.index===length&&change.deleteCount===0){
      for(const item of change.items)root=(await t.apply(root,[{op:'set',path:p+'/-',value:item}])).nextRoot
     }else{
      const array=await t.get(root,p)
      array.splice(change.index,change.deleteCount,...change.items)
      root=(await t.apply(root,[{op:'set',path:p,value:array}])).nextRoot
     }
    }else throw Error('Unsupported runtime mutation')
   }
   return root
  }catch(error){
   // JSON Chat permits null-filled sparse arrays. Keep its exact normalized
   // result when that contract cannot be expressed as strict tree operations.
   if(error.code!=='STATE_DELTA_INVALID')throw error
   return t.create(next)
  }
 }
 async function create(id,chat,assertCurrent){
  const batch=createBufferedJsonRecords({read:ref=>pages.readRecord(id,ref),writeMany:values=>pages.writeRecords(id,values)})
  const t=batch.tree,rows=[]
  for(const row of chat.messages??[])rows.push(await encode(id,row,undefined,undefined,t))
  const chatHeaderRef=await t.create(header(chat)),selected=currentWorld(chat)
  assertCurrent?.()
  await batch.flush([chatHeaderRef,...rows.map(row=>row.runtimeRef)])
  // The initial head is published atomically, including runtime references.
  await domain.create(id,{world:selected.world,messages:rows,metadata:{runtimeLayout:1},runtimeState:{chatHeaderRef,chatRevision:chat._storageRevision,worldMessage: selected.position,worldSwipe:selected.swipe}},{assertCurrent})
  return result(chat,await head(id))
 }
 async function write(id,stored,next,changes,assertCurrent){
  const batch=createBufferedJsonRecords({read:ref=>pages.readRecord(id,ref),writeMany:values=>pages.writeRecords(id,values)})
  const view=stored.native.view,t=batch.tree,grouped=new Map(),headChanges=[]
  let from=Infinity
  for(const change of changes){
   if(!change.path.length){from=0;headChanges.splice(0,headChanges.length,{op:'set',path:[],value:header(next)});continue}
   if(change.path[0]!=='messages'){headChanges.push(change);continue}
   if(change.path.length===1){from=Math.min(from,change.op==='splice'?change.index:0);continue}
   const position=Number(change.path[1])
   if(!grouped.has(position))grouped.set(position,[])
   grouped.get(position).push({...change,path:change.path.slice(2)})
  }
  from=Math.min(from,next.messages.length<view.messageCount?next.messages.length:Infinity)
  const retained=Math.min(from,view.messageCount),edits=[],append=[]
  for(const [position,mutations] of grouped){
   if(position>=retained)continue
   const previous=(await pages.readHistoryPage(id,{cursor:{snapshotId:view.snapshotCursor.snapshotId,before:position+1},limit:1})).messages[0].message
   edits.push({position,message:await encode(id,next.messages[position],previous,mutations,t)})
  }
  for(let position=retained;position<next.messages.length;position++)append.push(await encode(id,next.messages[position],undefined,undefined,t))
  const selected=currentWorld(next),old=currentWorld(stored.chat)
  // Reuse the exact received leaf changes on the common settlement hot path.
  // Switching swipes/rollback selects another world and explicitly diffs it.
  let worldChanges
  if(old.position===selected.position&&old.swipe===selected.swipe&&from>selected.position){
   worldChanges=[]
   for(const change of grouped.get(selected.position)??[]){
    if(!change.path.length){worldChanges=null;break}
    if(change.path[0]!=='variables')continue
    if(change.path.length<2){worldChanges=null;break}
    if(Number(change.path[1])===selected.swipe)worldChanges.push({...change,path:['variables',...change.path.slice(2)]})
   }
   if(worldChanges)worldChanges.push(...diffJson(Object.hasOwn(old.world,'posture')?{posture:old.world.posture}:{},Object.hasOwn(selected.world,'posture')?{posture:selected.world.posture}:{}))
  }
  worldChanges??=diffJson(old.world,selected.world)
  const worldRef=await mutate(t,view.state.worldRef,worldChanges,selected.world)
  const chatHeaderRef=await mutate(t,view.state.chatHeaderRef,headChanges,header(next))
  const state={...view.state,chatHeaderRef,chatRevision:next._storageRevision,worldRef,
   worldMessage:selected.position,worldSwipe:selected.swipe,
   storyRevision:view.state.storyRevision+(append.length||edits.length||retained<view.messageCount?1:0),
   worldRevision:view.state.worldRevision+(worldRef!==view.state.worldRef?1:0)}
  assertCurrent?.()
  await batch.flush([worldRef,chatHeaderRef,...edits.map(edit=>edit.message.runtimeRef),...append.map(row=>row.runtimeRef)])
  await pages.commit(id,{expectedRevision:view.revision,state,edits,append,truncateTo:retained,
   records:[['chat-revision:'+stored.revision,view.snapshotCursor.snapshotId]]},{assertCurrent})
  return result(next,await head(id))
 }
 return Object.freeze({read,readHelperContext,readSlice,readSessionState,version,create,write})
}
