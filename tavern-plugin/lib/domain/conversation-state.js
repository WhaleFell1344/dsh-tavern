import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'

const FORMAT='conversation-state-v1'
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
const error=(code,message=code)=>Object.assign(new Error(message),{code})
function capture(value){
 let json,copy
 try{json=JSON.stringify(value);copy=JSON.parse(json)}catch{throw error('CONVERSATION_INPUT','Expected lossless JSON input')}
 if(!isDeepStrictEqual(copy,value))throw error('CONVERSATION_INPUT','Expected lossless JSON input')
 return copy
}
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function basis(state){return {branchId:state.branchId,storyRevision:state.storyRevision,worldRevision:state.worldRevision,lifecycleRevision:state.lifecycleRevision}}
function operationId(value,max=260){if(typeof value!=='string'||!value||value.length>max)throw error('CONVERSATION_INPUT','Invalid operation id');return value}
function world(value){if(!object(value)||!object(value.variables))throw error('CONVERSATION_INPUT','World requires variables');return value}

/** New-format domain transactions. Legacy shadows are deliberately rejected:
 * activating one requires explicit timeline/delivery and native-session mapping.
 * Every write is a short CAS; retries never rerun models or script effects.
 */
export function createConversationState({store}){
 async function create(id,input){
  const value=capture(input)
  world(value.world)
  return store.create(id,{metadata:{format:FORMAT,settings:value.metadata??{}},messages:value.messages??[],
   state:{branchId:randomUUID(),storyRevision:0,worldRevision:0,lifecycleRevision:0,activeSettlementId:null,world:value.world}})
 }
 async function open(id,{limit=50}={}){
  const view=await store.openConversation(id,{limit})
  if(!view)throw error('CONVERSATION_MISSING')
  if(view.metadata?.format!==FORMAT)throw error('CONVERSATION_FORMAT','Conversation requires explicit domain migration')
  return {...view,basis:basis(view.state)}
 }
 async function records(id,view,keys){return store.readEntries(id,keys,{snapshotId:view.snapshotCursor.snapshotId})}
 async function readOperation(id,key){operationId(key);return (await store.readEntries(id,[key]))?.[key]}
 async function transact(id,build){
  for(let attempt=0;attempt<5;attempt++){
   const view=await open(id,{limit:1}),change=await build(view)
   if(!change.write)return capture(change.result)
   try{
    await store.commit(id,{expectedRevision:view.revision,...change.write})
    return capture(change.result)
   }catch(failure){
    if(!['CONVERSATION_CONFLICT','DSH_TAVERN_WRITE_CONFLICT'].includes(failure.code))throw failure
   }
  }
  throw error('CONVERSATION_CONFLICT','Concurrent writer; retry the same operation id')
 }
 function assertBasis(view,expected){if(!isDeepStrictEqual(view.basis,expected))throw error('CONVERSATION_STALE')}
 function assertTarget(view,op){
  if(!op||op.kind!=='settlement'||['cancelled','superseded'].includes(op.status)
    ||view.state.activeSettlementId!==op.id)throw error('CONVERSATION_STALE')
  assertBasis(view,op.basis)
  const row=view.messages.at(-1)
  if(!row||row.position!==op.position||row.message.id!==op.messageId||row.message.contentVersionId!==op.contentVersionId)throw error('CONVERSATION_STALE')
  return row.message
 }
 async function commitForeground(id,input){
  const args=capture(input),key='fg:'+operationId(args.operationId,256)
  if(typeof args.userText!=='string'||typeof args.assistantText!=='string'||!object(args.basis))throw error('CONVERSATION_INPUT')
  const signature=fingerprint(args)
  return transact(id,async view=>{
   const keys=[key,...(view.state.activeSettlementId?[view.state.activeSettlementId]:[])]
   const existing=await records(id,view,keys)
   if(existing[key]){
    if(existing[key].fingerprint!==signature)throw error('IDEMPOTENCY_CONFLICT')
    return {result:existing[key].receipt}
   }
   assertBasis(view,args.basis)
   const beforeRef=await store.writeRecord(id,view.state.world),settlementId='mvu:'+args.operationId
   const afterState={...view.state,storyRevision:view.state.storyRevision+1,activeSettlementId:settlementId}
   const position=view.messageCount+1,contentVersionId=fingerprint({text:args.assistantText})
   const assistant={id:key+':assistant',role:'assistant',text:args.assistantText,turnId:args.operationId,
    contentVersionId,stateBeforeRef:beforeRef,stateAfterRef:null,settlementId,settlementStatus:'pending'}
   const receipt={status:'committed',operationId:args.operationId,settlementId,position,basis:basis(afterState)}
   const updates=[[key,{kind:'foreground',fingerprint:signature,receipt}],
    [settlementId,{kind:'settlement',id:settlementId,status:'pending',basis:basis(afterState),position,
     messageId:assistant.id,contentVersionId,baselineRef:beforeRef}]]
   const previous=existing[view.state.activeSettlementId],edits=[]
   if(previous&&previous.status!=='completed'){
    const old=assertTarget(view,previous)
    updates.push([previous.id,{...previous,status:'superseded'}])
    edits.push({position:previous.position,message:{...old,settlementStatus:'superseded'}})
   }
   return {result:receipt,write:{state:afterState,records:updates,edits,append:[
    {id:key+':user',role:'user',text:args.userText,turnId:args.operationId,stateBeforeRef:beforeRef,stateAfterRef:beforeRef},assistant]}}
  })
 }
 async function submitSettlement(id,input){
  const args=capture(input),key=operationId(args.operationId)
  if(!Object.hasOwn(args,'submission'))throw error('CONVERSATION_INPUT','Missing submission')
  const signature=fingerprint(args.submission)
  return transact(id,async view=>{
   const op=(await records(id,view,[key]))[key]
   if(op?.submissionFingerprint){
    if(op.submissionFingerprint!==signature)throw error('IDEMPOTENCY_CONFLICT')
    if(op.status==='completed')return {result:op}
   }
   assertTarget(view,op)
   if(op.submissionFingerprint)return {result:op}
   const submissionRef=await store.writeRecord(id,args.submission)
   const next={...op,status:'submitted',submissionRef,submissionFingerprint:signature}
   return {result:next,write:{records:[[key,next]]}}
  })
 }
 async function prepareSettlement(id,input){
  const args=capture(input),key=operationId(args.operationId),value=world(args.world),signature=fingerprint(value)
  return transact(id,async view=>{
   const op=(await records(id,view,[key]))[key]
   if(op?.effectFingerprint&&op.effectFingerprint!==signature)throw error('IDEMPOTENCY_CONFLICT')
   if(op?.status==='completed')return {result:op}
   assertTarget(view,op)
   if(!op.submissionRef)throw error('CONVERSATION_INPUT','Settlement submission must be durable first')
   if(op.status==='prepared')return {result:op}
   const preparedWorldRef=await store.writeRecord(id,value)
   const next={...op,status:'prepared',preparedWorldRef,effectFingerprint:signature}
   return {result:next,write:{records:[[key,next]]}}
  })
 }
 async function commitSettlement(id,input){
  const key=operationId(input.operationId)
  return transact(id,async view=>{
   const op=(await records(id,view,[key]))[key]
   if(op?.status==='completed')return {result:op.receipt}
   const message=assertTarget(view,op)
   if(op.status!=='prepared'||!op.preparedWorldRef)throw error('CONVERSATION_INPUT','No prepared settlement effect')
   const nextState={...view.state,world:world(await store.readRecord(id,op.preparedWorldRef)),worldRevision:view.state.worldRevision+1,activeSettlementId:null}
   const receipt={status:'completed',operationId:key,position:op.position,basis:basis(nextState)}
   return {result:receipt,write:{state:nextState,records:[[key,{...op,status:'completed',receipt}]],
    edits:[{position:op.position,message:{...message,stateAfterRef:op.preparedWorldRef,settlementStatus:'completed'}}]}}
  })
 }
 async function finishUnsuccessfully(id,input,status){
  const args=capture(input),key=operationId(args.operationId)
  return transact(id,async view=>{
   const op=(await records(id,view,[key]))[key]
   if(op?.status==='completed'||op?.status===status)return {result:op}
   const message=assertTarget(view,op)
   const next={...op,status,...(status==='failed'?{error:String(args.error??'Settlement failed')}:{})}
   return {result:next,write:{records:[[key,next]],
    ...(status==='cancelled'?{state:{...view.state,activeSettlementId:null}}:{}),
    edits:[{position:op.position,message:{...message,settlementStatus:status}}]}}
  })
 }
 async function readMessageState(id,{position,side='after'}){
  if(!Number.isSafeInteger(position)||position<0||!['before','after'].includes(side))throw error('CONVERSATION_INPUT')
  const view=await open(id,{limit:1})
  if(position>=view.messageCount)throw error('CONVERSATION_INPUT','Message position out of range')
  const page=await store.readHistoryPage(id,{cursor:{snapshotId:view.snapshotCursor.snapshotId,before:position+1},limit:1})
  const ref=page.messages[0].message[side==='before'?'stateBeforeRef':'stateAfterRef']
  return ref?store.readRecord(id,ref):undefined
 }
 return Object.freeze({create,open,commitForeground,submitSettlement,prepareSettlement,commitSettlement,readOperation,readMessageState,
  failSettlement:(id,input)=>finishUnsuccessfully(id,input,'failed'),cancelSettlement:(id,input)=>finishUnsuccessfully(id,input,'cancelled')})
}
