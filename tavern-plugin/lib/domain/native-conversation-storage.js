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
 const tree=id=>createIncrementalJsonState({read:ref=>pages.readRecord(id,ref),write:value=>pages.writeRecord(id,value)})
 async function head(id,snapshotId){
  const view=await pages.openConversation(id,{limit:1,...(snapshotId?{snapshotId}:{})})
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
 function currentWorld(chat){
  for(let position=(chat.messages?.length??0)-1;position>=0;position--){
   const row=chat.messages[position],swipe=Math.max(0,Number(row.swipeId)||0)
   const variables=row.variables?.[swipe]
   if(variables&&typeof variables==='object'&&!Array.isArray(variables))return {position,swipe,world:{variables,...(chat.posture!==undefined?{posture:chat.posture}:{})}}
  }
  return {position:null,swipe:0,world:{variables:{},...(chat.posture!==undefined?{posture:chat.posture}:{})}}
 }
 async function encode(id,row,previous,changes){
  const t=tree(id)
  const runtimeRef=previous?await mutate(t,previous.runtimeRef,changes,row):await t.create(row)
  // Pages contain identity + references only; large variables/body/extension
  // payloads live in the incremental tree and share unchanged hashed blocks.
  return {runtimeRef,...(row.id!==undefined?{id:row.id}:{}),...(row.role!==undefined?{role:row.role}:{})}
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
  const t=tree(id),rows=[]
  for(const row of chat.messages??[])rows.push(await encode(id,row))
  const chatHeaderRef=await t.create(header(chat)),selected=currentWorld(chat)
  assertCurrent?.()
  // The initial head is published atomically, including runtime references.
  await domain.create(id,{world:selected.world,messages:rows,metadata:{runtimeLayout:1},runtimeState:{chatHeaderRef,chatRevision:chat._storageRevision,worldMessage: selected.position,worldSwipe:selected.swipe}},{assertCurrent})
  return result(chat,await head(id))
 }
 async function write(id,stored,next,changes,assertCurrent){
  const view=stored.native.view,t=tree(id),grouped=new Map(),headChanges=[]
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
   edits.push({position,message:await encode(id,next.messages[position],previous,mutations)})
  }
  for(let position=retained;position<next.messages.length;position++)append.push(await encode(id,next.messages[position]))
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
  await pages.commit(id,{expectedRevision:view.revision,state,edits,append,truncateTo:retained,
   records:[['chat-revision:'+stored.revision,view.snapshotCursor.snapshotId]]},{assertCurrent})
  return result(next,await head(id))
 }
 return Object.freeze({read,version,create,write})
}
