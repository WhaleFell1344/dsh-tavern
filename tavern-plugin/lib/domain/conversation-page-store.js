import {createHash, randomUUID} from 'node:crypto'
import {mkdir, open, readFile, rename, rm} from 'node:fs/promises'
import path from 'node:path'
import {createDurableFilePromotion} from '../durable-file-promotion.js'

// New-format foundation, deliberately not an automatic legacy Chat migration.
// Only the small head pointer is mutable. Readers pin immutable snapshots;
// append/point edits copy a bounded page and its radix-tree path.
const PAGE_SIZE=64, FANOUT=32, FORMAT=1
const hash=value=>createHash('sha256').update(value).digest('hex')
const copy=value=>JSON.parse(JSON.stringify(value))
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
function conflict(){return Object.assign(new Error('Conversation revision conflict'),{code:'CONVERSATION_CONFLICT'})}
function integer(value,min=0){return Number.isSafeInteger(value)&&value>=min}

export function createConversationPageStore({root,onIO=()=>{}}={}) {
 if(!root)throw Error('Conversation store requires root')
 root=path.resolve(root)
 // A live, slow writer must never lose its lock merely due to elapsed time.
 // Dead process recovery and pending head promotion use the existing protocol.
 const promotion=createDurableFilePromotion({writeLockStaleMs:Number.MAX_SAFE_INTEGER})
 function directory(id){
  if(typeof id!=='string'||!id||id==='.'||id==='..'||/[\\/\0]/.test(id))throw Error('Invalid conversation id')
  return path.join(root,id)
 }
 function blobPath(dir,id){
  if(!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid block reference')
  return path.join(dir,'blocks',id.slice(0,2),id+'.json')
 }
 async function syncDirectory(dir){
  if(process.platform==='win32')return
  const handle=await open(dir,'r')
  try{await handle.sync()}catch(error){if(!['EINVAL','ENOTSUP','EISDIR'].includes(error.code))throw error}finally{await handle.close()}
 }
 async function writeBlock(dir,value){
  const bytes=JSON.stringify(value),id=hash(bytes),target=blobPath(dir,id),parent=path.dirname(target)
  await mkdir(parent,{recursive:true})
  let existing
  try{existing=await readFile(target,'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
  if(existing!==undefined){
   onIO({kind:'read',type:value.kind,bytes:Buffer.byteLength(existing),reason:'deduplication'})
   if(existing!==bytes)throw Error('Immutable block corruption')
   return id
  }
  const staging=target+'.staging-'+randomUUID()
  let handle
  try{
   handle=await open(staging,'wx');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null
   await rename(staging,target)
   await syncDirectory(parent)
   await syncDirectory(path.dirname(parent))
   await syncDirectory(dir)
  }finally{if(handle)await handle.close();await rm(staging,{force:true})}
  onIO({kind:'write',type:value.kind,bytes:Buffer.byteLength(bytes)})
  return id
 }
 function reader(dir){
  // Request-local only: cold and warm operations have the same bounded reads.
  const cache=new Map()
  return async function readBlock(id,kind){
   if(!cache.has(id)){
    const bytes=await readFile(blobPath(dir,id),'utf8')
    if(hash(bytes)!==id)throw Error('Immutable block checksum mismatch')
    const value=JSON.parse(bytes)
    cache.set(id,value);onIO({kind:'read',type:value.kind,bytes:Buffer.byteLength(bytes)})
   }
   const value=cache.get(id)
   if(kind&&value.kind!==kind)throw Error('Invalid block type')
   return value
  }
 }
 function validateHead(head,id){
  if(head.format!==FORMAT||head.id!==id||!integer(head.revision,1)||!integer(head.count)||!integer(head.height)||head.height>10)throw Error('Invalid conversation head')
  return head
 }
 async function current(dir,id,read){
  const bytes=await promotion.read(path.join(dir,'head.json'))
  if(bytes===undefined)return undefined
  const pointer=JSON.parse(bytes)
  if(pointer.format!==FORMAT)throw Error('Unsupported conversation format')
  return {head:validateHead(await read(pointer.headId,'head'),id),headId:pointer.headId}
 }
 async function leaf(read,root,height,page){
  if(root===null)return []
  if(height===0)return (await read(root,'page')).messages
  const node=await read(root,'index'),slot=Math.floor(page/FANOUT**(height-1))%FANOUT
  if(!node.children[slot])throw Error('History index missing page')
  return leaf(read,node.children[slot],height-1,page)
 }
 async function setLeaf(dir,read,root,height,page,messages){
  if(height===0)return writeBlock(dir,{kind:'page',messages})
  const children=root===null?[]:[...(await read(root,'index')).children]
  const slot=Math.floor(page/FANOUT**(height-1))%FANOUT
  // Explicit nulls keep sparse new branches stable after JSON serialization.
  while(children.length<=slot)children.push(null)
  children[slot]=await setLeaf(dir,read,children[slot],height-1,page,messages)
  return writeBlock(dir,{kind:'index',children})
 }
 async function build(dir,messages){
  let refs=[]
  for(let i=0;i<messages.length;i+=PAGE_SIZE)refs.push(await writeBlock(dir,{kind:'page',messages:messages.slice(i,i+PAGE_SIZE)}))
  let height=0
  while(refs.length>1){
   const next=[]
   for(let i=0;i<refs.length;i+=FANOUT)next.push(await writeBlock(dir,{kind:'index',children:refs.slice(i,i+FANOUT)}))
   refs=next;height++
  }
  return {root:refs[0]??null,height}
 }
 function recordKey(key){if(typeof key!=='string'||!key||key.length>512)throw Error('Invalid record key');return hash(key)}
 async function lookup(read,root,key,route,depth=0){
  if(!root)return undefined
  const node=await read(root)
  if(node.kind==='entry')return node.key===key?node.valueRef:undefined
  if(node.kind!=='entries'||depth>=64)throw Error('Invalid record index')
  return lookup(read,node.children[route[depth]],key,route,depth+1)
 }
 // Batch entries by hash path so imports do not rewrite the same branch per key.
 async function putEntries(dir,read,root,updates,depth=0){
  const node=root?await read(root):null
  if(!node||node.kind==='entry'){
   const merged=new Map(node?[[node.key,{key:node.key,valueRef:node.valueRef,route:recordKey(node.key)}]]:[])
   for(const entry of updates)merged.set(entry.key,entry)
   updates=[...merged.values()]
   if(updates.length===1){const {key,valueRef}=updates[0];return writeBlock(dir,{kind:'entry',key,valueRef})}
  }else if(node.kind!=='entries')throw Error('Invalid record index')
  if(depth>=64)throw Error('Record key hash collision')
  const children=node?.kind==='entries'?{...node.children}:{},groups=new Map()
  for(const entry of updates){const slot=entry.route[depth];if(!groups.has(slot))groups.set(slot,[]);groups.get(slot).push(entry)}
  for(const [slot,entries] of groups)children[slot]=await putEntries(dir,read,children[slot],entries,depth+1)
  return writeBlock(dir,{kind:'entries',children})
 }
 async function create(id,input,{assertCurrent}={}){
  const dir=directory(id),value=copy(input)
  if(!record(value.state)||!Array.isArray(value.messages??[])||!(value.messages??[]).every(record))throw Error('Invalid initial conversation')
  let result
  await promotion.update(path.join(dir,'head.json'),async current=>{
   if(current!==undefined)throw conflict()
   const messages=value.messages??[],tree=await build(dir,messages)
   const head={kind:'head',format:FORMAT,id,revision:1,count:messages.length,...tree,
    stateId:await writeBlock(dir,{kind:'state',value:value.state}),metadataId:await writeBlock(dir,{kind:'metadata',value:value.metadata??{}})}
   const headId=await writeBlock(dir,head)
   result={revision:1,snapshotId:headId}
   assertCurrent?.()
   return JSON.stringify({format:FORMAT,headId})
  })
  return result
 }
 async function commit(id,input,{assertCurrent}={}){
  const dir=directory(id),change=copy(input),read=reader(dir)
  if(!integer(change.expectedRevision,1)||!Array.isArray(change.append??[])||!(change.append??[]).every(record)
    ||!Array.isArray(change.edits??[])||(Object.hasOwn(change,'state')&&!record(change.state)))throw Error('Invalid commit')
  let result
  await promotion.update(path.join(dir,'head.json'),async pointer=>{
   if(pointer===undefined)throw conflict()
   const reference=JSON.parse(pointer)
   if(reference.format!==FORMAT)throw Error('Unsupported conversation format')
   const head=validateHead(await read(reference.headId,'head'),id)
   if(head.revision!==change.expectedRevision)throw conflict()
   if(!integer(head.revision+1,1))throw Error('Revision overflow')
   const retained=change.truncateTo ?? head.count
   if(!integer(retained)||retained>head.count)throw Error('Invalid truncation')
   const pages=new Map()
   async function pageAt(page){
    if(!pages.has(page))pages.set(page,page*PAGE_SIZE<retained?(await leaf(read,head.root,head.height,page)).slice(0,Math.min(PAGE_SIZE,retained-page*PAGE_SIZE)):[])
    return pages.get(page)
   }
   for(const edit of change.edits??[]){
    if(!integer(edit.position)||edit.position>=retained||!record(edit.message))throw Error('Invalid edit position or message')
    const page=Math.floor(edit.position/PAGE_SIZE)
    ;(await pageAt(page))[edit.position%PAGE_SIZE]=edit.message
   }
   if(retained<head.count&&retained%PAGE_SIZE)await pageAt(Math.floor(retained/PAGE_SIZE))
   let count=retained
   for(const message of change.append??[]){
    if(!integer(count+1)||count>=PAGE_SIZE*FANOUT**10)throw Error('History capacity exceeded')
    ;(await pageAt(Math.floor(count/PAGE_SIZE)))[count%PAGE_SIZE]=message;count++
   }
   let {root:treeRoot,height}=head
   const lastPage=Math.max(0,Math.ceil(count/PAGE_SIZE)-1)
   while(lastPage>=FANOUT**height){treeRoot=await writeBlock(dir,{kind:'index',children:treeRoot?[treeRoot]:[]});height++}
   for(const [page,messages] of pages)treeRoot=await setLeaf(dir,read,treeRoot,height,page,messages)
   const next={...head,revision:head.revision+1,count,root:treeRoot,height,previousHeadId:reference.headId}
   if(change.records!==undefined){
    if(!Array.isArray(change.records))throw Error('Invalid keyed records')
    const updates=new Map()
    for(const entry of change.records){
     if(!Array.isArray(entry)||entry.length!==2)throw Error('Invalid keyed record')
     const [key,value]=entry,route=recordKey(key)
     const valueRef=await writeBlock(dir,{kind:'record',value})
     updates.set(key,{key,valueRef,route})
    }
    if(updates.size)next.recordRoot=await putEntries(dir,read,next.recordRoot,[...updates.values()])
   }
   if(Object.hasOwn(change,'state'))next.stateId=await writeBlock(dir,{kind:'state',value:change.state})
   if(Object.hasOwn(change,'metadata'))next.metadataId=await writeBlock(dir,{kind:'metadata',value:change.metadata})
   const headId=await writeBlock(dir,next)
   result={revision:next.revision,snapshotId:headId}
   assertCurrent?.()
   return JSON.stringify({format:FORMAT,headId})
  })
  return result
 }
 function pageLimit(limit){if(!integer(limit,1)||limit>500)throw Error('Invalid page limit');return limit}
 async function page(read,head,headId,before,limit){
  if(!integer(before)||before>head.count)throw Error('Invalid cursor position')
  const start=Math.max(0,before-limit),messages=[]
  for(let p=Math.floor(start/PAGE_SIZE);p<Math.ceil(before/PAGE_SIZE);p++){
   const rows=await leaf(read,head.root,head.height,p)
   for(let position=Math.max(start,p*PAGE_SIZE);position<Math.min(before,(p+1)*PAGE_SIZE);position++){
    if(!record(rows[position%PAGE_SIZE]))throw Error('History page missing message')
    messages.push({position,message:copy(rows[position%PAGE_SIZE])})
   }
  }
  return {revision:head.revision,messageCount:head.count,messages,
   snapshotCursor:{snapshotId:headId,before},previousCursor:start?{snapshotId:headId,before:start}:null}
 }
 async function openConversation(id,{limit=50,snapshotId}={}){
  pageLimit(limit)
  const dir=directory(id),read=reader(dir)
  const selected=snapshotId?{head:validateHead(await read(snapshotId,'head'),id),headId:snapshotId}:await current(dir,id,read)
  if(!selected)return undefined
  const {head,headId}=selected
  return {...await page(read,head,headId,head.count,limit),state:copy((await read(head.stateId,'state')).value),metadata:copy((await read(head.metadataId,'metadata')).value)}
 }
 async function readHistoryPage(id,{cursor,limit=50}={}){
  pageLimit(limit)
  if(!record(cursor))throw Error('Invalid history cursor')
  const read=reader(directory(id))
  let head
  try{head=await read(cursor.snapshotId,'head')}catch(error){
   if(error.code==='ENOENT')throw Error('Invalid history cursor')
   throw error
  }
  if(head.id!==id)throw Error('Foreign history cursor')
  validateHead(head,id)
  return page(read,head,cursor.snapshotId,cursor.before,limit)
 }
 async function readState(id,{snapshotId}={}){
  const dir=directory(id),read=reader(dir)
  const head=snapshotId?validateHead(await read(snapshotId,'head'),id):(await current(dir,id,read))?.head
  return head?copy((await read(head.stateId,'state')).value):undefined
 }
 // Detached immutable records let migration separate large historical state
 // and extension payloads from the page body. They are not a second mutable head.
 async function writeRecord(id,value){return writeBlock(directory(id),{kind:'record',value:copy(value)})}
 async function readRecord(id,reference){return copy((await reader(directory(id))(reference,'record')).value)}
 async function readEntries(id,keys,{snapshotId}={}){
  if(!Array.isArray(keys))throw Error('Invalid record keys')
  const routes=keys.map(recordKey),dir=directory(id),read=reader(dir)
  const head=snapshotId?validateHead(await read(snapshotId,'head'),id):(await current(dir,id,read))?.head
  if(!head)return undefined
  const entries=[]
  for(let i=0;i<keys.length;i++){
   const ref=await lookup(read,head.recordRoot,keys[i],routes[i])
   if(ref)entries.push([keys[i],copy((await read(ref,'record')).value)])
  }
  return Object.fromEntries(entries)
 }
 return Object.freeze({create,commit,openConversation,readHistoryPage,readState,writeRecord,readRecord,readEntries})
}
