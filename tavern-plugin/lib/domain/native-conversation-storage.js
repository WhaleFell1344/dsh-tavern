import {projectTavernHelperContext,projectTavernHelperMessage} from './tavern-helper-context.js'
import {projectSessionMessage,projectChatSessionState,projectSceneImageState,projectDisplayRuntimeState} from './chat-session-state.js'
import {createScopedMessages} from './scoped-messages.js'
import {createBufferedJsonRecords} from './buffered-json-records.js'
import path from 'node:path'
import {createConversationPageStore} from './conversation-page-store.js'
import {createConversationState} from './conversation-state.js'
import {createIncrementalJsonState} from './incremental-json-state.js'
import {diffJson,applyJsonChangesShared} from './json-mutation.js'

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
 const summaryCache=new Map(),summaryLoads=new Map()
 let summaryBytes=0
 async function sessionSummaries(id,view){
  const key=JSON.stringify([id,view.snapshotCursor.snapshotId])
  const cached=summaryCache.get(key)
  if(cached){summaryCache.delete(key);summaryCache.set(key,cached);return cached}
  if(summaryLoads.has(key))return summaryLoads.get(key)
  const loading=(async()=>{
   const messages=new Array(view.messageCount),t=tree(id)
   let cursor=view.snapshotCursor,pending=null,bytes=messages.length*8
   while(cursor){
    const page=await pages.readHistoryPage(id,{cursor,limit:500})
    for(const {position,message} of [...page.messages].reverse()){
     const summary=message.session || sessionSummary(await t.get(message.runtimeRef))
     messages[position]=projectSessionMessage(summary.message)
     bytes+=48+JSON.stringify(messages[position]).length*2
     if(pending===null&&summary.pending)pending=summary.pending
    }
    cursor=page.previousCursor
   }
   const value={messages,pending,bytes}
   if(bytes<=8*1024*1024){
    while(summaryCache.size && (summaryCache.size>=4 || summaryBytes+bytes>16*1024*1024)){
     const oldest=summaryCache.keys().next().value;summaryBytes-=summaryCache.get(oldest).bytes;summaryCache.delete(oldest)
    }
    summaryCache.set(key,value);summaryBytes+=bytes
   }
   return value
  })()
  summaryLoads.set(key,loading)
  try{return await loading}finally{summaryLoads.delete(key)}
 }
 // Request-local, bounded block reuse. Full reads still return independent JSON
 // values, but shared historical snapshots are not fetched from disk per row.
 function tree(id){
  const cache=new Map();let bytes=0
  return createIncrementalJsonState({decodedCacheBytes:8*1024*1024,async read(ref){
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
 async function readRevisionMetadata(id){
  const view=await head(id)
  return view?{revision:view.state.chatRevision,messageCount:view.messageCount,stamp:'native:'+view.snapshotCursor.snapshotId}:null
 }
 function result(chat,view){return {chat,revision:chat._storageRevision,native:{view},legacy:false,snapshot:null,open:null,openFrameCount:0,openInvalidLine:0}}
 async function headAtRevision(id,revision=Infinity){
  if(revision!==Infinity&&(!Number.isSafeInteger(revision)||revision<1))throw failure('DSH_TAVERN_REVISION_NOT_FOUND','Invalid native Chat revision')
  let view=await head(id)
  if(!view)return null
  if(revision!==Infinity&&revision!==view.state.chatRevision){
   const ref=(await pages.readEntries(id,['chat-revision:'+revision],{snapshotId:view.snapshotCursor.snapshotId}))['chat-revision:'+revision]
   if(!ref)throw failure('DSH_TAVERN_REVISION_NOT_FOUND','Native Chat revision not found: '+revision)
   view=await head(id,ref)
  }
  return view
 }
 async function read(id,revision=Infinity){
  const view=await headAtRevision(id,revision)
  if(!view)return null
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
 // A window is explicitly NOT a writable Chat: coordinates refer to the pinned
 // full archive, while chat.messages contains only this bounded page.
 async function readWindow(id,{limit=48,before,revision,includeCheckpoints=false}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Invalid history window limit')
  const view=await headAtRevision(id,revision??Infinity)
  if(!view)return null
  const end=before??view.messageCount
  if(!Number.isSafeInteger(end)||end<0||end>view.messageCount)throw Error('Invalid history window cursor')
  const from=Math.max(0,end-limit),chat=await selectedHeader(id,view,includeCheckpoints?undefined:'settlement'),t=tree(id)
  const page=await pages.readHistoryPage(id,{cursor:{snapshotId:view.snapshotCursor.snapshotId,before:end},limit})
  chat.messages=[]
  for(const row of page.messages)chat.messages.push(await t.get(row.message.runtimeRef))
  return {chat,messageCount:view.messageCount,from,to:end-1,revision:view.state.chatRevision}
 }
 async function readSlice(id,indices=[],fields,pinned){
  const view=pinned||await head(id)
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
 async function changeCoverage(id,revision){
  const view=await head(id)
  if(!view)return null
  const current=view.state.chatRevision
  if(!Number.isSafeInteger(revision)||revision<1||revision>current||current-revision>64)return undefined
  const keys=Array.from({length:current-revision},(_,i)=>'chat-change:'+(revision+i+1))
  const refs=await pages.readEntries(id,keys,{snapshotId:view.snapshotCursor.snapshotId})
  const indices=new Set();let tail=view.messageCount,layoutFrom=view.messageCount,layoutChanged=false
  for(let i=0;i<keys.length;i++){
   if(!refs[keys[i]])return undefined
   const frame=await pages.readRecord(id,refs[keys[i]])
   if(frame.baseRevision!==revision+i||frame.revision!==revision+i+1)return undefined
   for(const index of frame.indices)if(index<view.messageCount)indices.add(index)
   if(frame.tail!==null)tail=Math.min(tail,frame.tail)
   if(frame.layoutFrom!==null){layoutChanged=true;layoutFrom=Math.min(layoutFrom,frame.layoutFrom)}
  }
  for(let index=tail;index<view.messageCount;index++)indices.add(index)
  return {view,indices:[...indices].sort((a,b)=>a-b),baseRevision:revision,revision:current,layoutChanged,layoutFrom}
 }
 async function readChangedSlice(id,revision,fields,indicesOnly=false){
  const coverage=await changeCoverage(id,revision)
  if(!coverage)return coverage
  const {view,...changes}=coverage
  if(indicesOnly)return {indices:changes.indices,baseRevision:changes.baseRevision,revision:changes.revision}
  if(revision===changes.revision)return undefined
  return {...changes,...await readSlice(id,changes.indices,fields,view)}
 }
 // A transaction pins one immutable head; only explicit reads populate rows.
 async function readSettlementBase(id){
  const view=await head(id)
  if(!view)return null
  const chat=await selectedHeader(id,view,'settlement'),t=tree(id),rows=new Map(),references=new Map()
  const count=view.messageCount
  let tail=Promise.resolve()
  async function pageFor(position){
   const start=Math.floor(position/64)*64,end=Math.min(count,start+64)
   if(!references.has(position)){
    const page=await pages.readHistoryPage(id,{cursor:{snapshotId:view.snapshotCursor.snapshotId,before:end},limit:end-start})
    for(const row of page.messages)references.set(row.position,row.message)
   }
   return references.get(position)
  }
  async function ensure(indices){
   const ids=indices===undefined?Array.from({length:count},(_,i)=>i):[...new Set(indices)]
   for(const index of ids)if(!Number.isSafeInteger(index)||index<0||index>=count)throw Error('消息楼层不存在: '+index)
   const pending=tail.then(async()=>{for(const index of ids)if(!rows.has(index)){
    const reference=await pageFor(index)
    rows.set(index,await t.get(reference.runtimeRef))
   }})
   tail=pending.catch(()=>{})
   return pending
  }
  chat.messages=createScopedMessages(count,[],index=>{
   if(!rows.has(index))throw Object.assign(Error('MVU history floor is not loaded: '+index),{code:'MVU_HISTORY_NOT_LOADED'})
   return rows.get(index)
  })
  async function previousMvu(before){
   for(let index=before-1;index>=0;index--){
    const reference=await pageFor(index)
    let valid=reference.session?.mvuSnapshot
    // Old native pages have no flag. Inspect only the selected variable shape,
    // never materialize their body or unrelated variable values.
    if(typeof valid!=='boolean'){
     const swipe=await t.get(reference.runtimeRef,'/swipeId')||0
     const path='/variables/'+swipe
     const keys=await t.type(reference.runtimeRef,path)==='object'?await t.keys(reference.runtimeRef,path):[]
     valid=keys.includes('stat_data')&&keys.includes('schema')
    }
    if(valid){await ensure([index]);return index}
   }
   return -1
  }
  return {chat,messageCount:count,denseMessages:true,ensure,previousMvu}
 }
 // Helper owns a read projection, not an editable runtime Chat. Bind header
 // and every page to one immutable head, even while another writer appends.
 async function readHelperContext(id,range){
  const view=await headAtRevision(id,range?.revision??Infinity)
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
 async function readSceneImageState(id){
  const view=await head(id)
  if(!view)return null
  const chat=await selectedHeader(id,view,['id','sessionId','mode','backgroundConfigVersion','conversationFeaturesVersion','sceneImagesEnabled'])
  const t=tree(id),messages=new Array(view.messageCount)
  let cursor=view.snapshotCursor
  while(cursor){
   const page=await pages.readHistoryPage(id,{cursor,limit:500})
   for(const {position,message} of page.messages){
    const row={}
    for(const field of ['role','turn','greeting','text','sourceText','swipeId']){
     const value=await t.get(message.runtimeRef,'/'+field)
     if(value!==undefined)row[field]=value
    }
    const count=await t.type(message.runtimeRef,'/swipes')==='array'?await t.size(message.runtimeRef,'/swipes'):null
    if(count!==null){
     row.swipes=new Array(count).fill(null)
     const selected=Math.max(0,Number(row.swipeId)||0)
     if(Number.isInteger(selected)&&selected<count)row.swipes[selected]=await t.get(message.runtimeRef,'/swipes/'+selected)
    }
    messages[position]=row
   }
   cursor=page.previousCursor
  }
  return projectSceneImageState({...chat,messages})
 }
 async function readDisplayRuntimeState(id,turn){
  const view=await head(id)
  if(!view)return null
  const chat=await selectedHeader(id,view,['id','sessionId','_storageRevision','mode','backgroundConfigVersion','conversationFeaturesVersion','updatedAt','rollbackUndo'])
  const {messages}=await sessionSummaries(id,view)
  const result=projectDisplayRuntimeState({...chat,messages},turn)
  if(result.messageIndex>=0){
   const page=await pages.readHistoryPage(id,{cursor:{snapshotId:view.snapshotCursor.snapshotId,before:result.messageIndex+1},limit:1})
   result.displayRuntime=await tree(id).get(page.messages[0].message.runtimeRef,'/displayRuntime')
  }
  return result
 }
 async function readSessionState(id,options={}){
  const view=await head(id)
  if(!view)return null
  const chat=await selectedHeader(id,view,['id','sessionId','_storageRevision','mode','cardPath','cardContextRevision',
   'backgroundConfigVersion','conversationFeaturesVersion','disabledWritingSkills','contextCompaction','updatedAt','timeline','candidateAgent',
   'cardName','requestMode','statusBarPlacement','webSearchEnabled','candidates','taskMailbox','regenInProgress','settleError','scriptState',
   'hiddenDshErrorTurns','suppressedDshTurns','regeneratedDshTurns','tavernHelperLifecycleRevision','importHistory','rollbackUndo','pendingMvuSettlement'])
  if(Object.values(chat.timeline?.operations??{}).some(op=>op?.kind==='body'&&op.status==='foreground-completed'))return projectChatSessionState((await read(id)).chat)
  // Cached rows never leave this module: full projections detach them below,
  // scoped projections clone each row on access. Snapshot identity pins validity.
  const {messages,pending}=await sessionSummaries(id,view)
  chat.messages=messages
  return projectChatSessionState(chat,{pendingMvuSettlement:options.scoped!==true&&Object.hasOwn(chat,'pendingMvuSettlement')?chat.pendingMvuSettlement:pending,...(options.scoped===true?{messages:createScopedMessages(messages.length,[],position=>structuredClone(messages[position]))}:{})})
 }
 function sessionSummary(row){const variables=row.variables?.[Math.max(0,Number(row.swipeId)||0)];return JSON.parse(JSON.stringify({mvuSnapshot:Boolean(variables&&variables.stat_data!==undefined&&variables.schema!==undefined),message:projectSessionMessage(row),pending:row.role==='assistant'&&row.mvu?.pending===true?{
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
 // Point mutations can be validated against just the header and touched rows.
 // Structural edits and removal of the latest world retain the full fallback.
 async function patch(id,revision,changes,assertCurrent){
  const view=await head(id)
  if(!view)return null
  if(view.state.chatRevision!==revision)return undefined
  if(changes.some(change=>!change.path?.length || change.path[0]==='messages' &&
    (change.path.length<3 || !Number.isSafeInteger(change.path[1]) || change.path[1]<0 || change.path[1]>=view.messageCount)))return null
  const t=tree(id),originalHeader=await t.get(view.state.chatHeaderRef),rows=new Map()
  for(const change of changes){
   if(change.path[0]!=='messages'||rows.has(change.path[1]))continue
   const position=change.path[1]
   const page=await pages.readHistoryPage(id,{cursor:{snapshotId:view.snapshotCursor.snapshotId,before:position+1},limit:1})
   rows.set(position,await t.get(page.messages[0].message.runtimeRef))
  }
  let nextHeader=originalHeader
  const normalized=[]
  for(const raw of changes){
   const isMessage=raw.path[0]==='messages',position=raw.path[1]
   const base=isMessage?rows.get(position):nextHeader,relative=isMessage?raw.path.slice(2):raw.path
   let change=JSON.parse(JSON.stringify(raw))
   if(raw.op==='set'&&raw.value===undefined){
    let parent=base
    for(const key of relative.slice(0,-1))parent=parent?.[key]
    if(!parent||typeof parent!=='object')throw Error('Missing mutation parent')
    if(Array.isArray(parent))change.value=null
    else if(Object.hasOwn(parent,relative.at(-1)))change={op:'delete',path:raw.path}
    else continue
   }
   const next=applyJsonChangesShared(base,[{...change,path:relative}])
   if(isMessage)rows.set(position,next);else nextHeader=next
   normalized.push(change)
  }
  if(nextHeader.id!==id||nextHeader._storageRevision!==revision+(changes.length?1:0))throw Error('Invalid journal patch revision')
  if(!changes.length){assertCurrent?.();return result({...nextHeader,messages:[]},view)}
  const old={position:view.state.worldMessage,swipe:view.state.worldSwipe,world:await t.get(view.state.worldRef)}
  let selected={...old,world:{variables:old.world.variables,...(nextHeader.posture!==undefined?{posture:nextHeader.posture}:{})}}
  // A changed newer floor may introduce a new active variable snapshot.
  const candidates=[...rows].filter(([position])=>old.position===null||position>=old.position).sort(([a],[b])=>b-a)
  for(const [position,row] of candidates){
   const swipe=Math.max(0,Number(row.swipeId)||0),variables=row.variables?.[swipe]
   if(variables&&typeof variables==='object'&&!Array.isArray(variables)){
    selected={position,swipe,world:{variables,...(nextHeader.posture!==undefined?{posture:nextHeader.posture}:{})}}
    break
   }
   if(position===old.position)return null // needs an earlier world lookup
  }
  const next={...nextHeader,messages:createScopedMessages(view.messageCount,rows)}
  const saved=await write(id,result({...originalHeader,messages:[]},view),next,normalized,assertCurrent,{old,selected})
  return {...saved,chat:{...nextHeader,messages:[]}}
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
 async function write(id,stored,next,changes,assertCurrent,worldSelection){
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
  const selected=worldSelection?.selected??currentWorld(next),old=worldSelection?.old??currentWorld(stored.chat)
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
  let layoutFrom=Number.isFinite(from)?from:null
  for(const [position,mutations] of grouped)if(mutations.some(change=>!change.path.length||['turn','role','greeting','tavernRole','importSource'].includes(change.path[0])))layoutFrom=Math.min(layoutFrom??Infinity,position)
  const changeRef=await pages.writeRecord(id,{baseRevision:stored.revision,revision:next._storageRevision,
   indices:edits.map(edit=>edit.position),tail:Number.isFinite(from)?from:null,layoutFrom})
  await pages.commit(id,{expectedRevision:view.revision,state,edits,append,truncateTo:retained,
   records:[['chat-revision:'+stored.revision,view.snapshotCursor.snapshotId],['chat-change:'+next._storageRevision,changeRef]]},{assertCurrent})
  return result(next,await head(id))
 }
 return Object.freeze({patch,read,readWindow,readSettlementBase,readChangedSlice,readRevisionMetadata,readHelperContext,readSlice,readSessionState,readDisplayRuntimeState,readSceneImageState,version,create,write})
}
