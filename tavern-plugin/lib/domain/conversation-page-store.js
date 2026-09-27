import {createHash, randomUUID} from 'node:crypto'
import {mkdir, open, readFile, rename, rm, link} from 'node:fs/promises'
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

export function createConversationPageStore({root,onIO=()=>{},linkFile=link}={}) {
 if(!root)throw Error('Conversation store requires root')
 root=path.resolve(root)
 // A live, slow writer must never lose its lock merely due to elapsed time.
 // Dead process recovery and pending head promotion use the existing protocol.
 const promotion=createDurableFilePromotion({writeLockStaleMs:Number.MAX_SAFE_INTEGER})
 const packed=new Map();let packedBytes=0
 function cachePacked(dir,id,value,size){
  const key=dir+'/'+id,old=packed.get(key)
  if(old){packedBytes-=old.size;packed.delete(key)}
  while(packed.size&&packedBytes+size>8*1024*1024){const oldest=packed.keys().next().value;packedBytes-=packed.get(oldest).size;packed.delete(oldest)}
  if(size<=8*1024*1024){packed.set(key,{value,size});packedBytes+=size}
 }
 function decodeBlock(dir,id,bytes){
  if(hash(bytes)===id)return JSON.parse(bytes)
  let pack
  try{pack=JSON.parse(bytes)}catch{throw Error('Immutable block checksum mismatch')}
  if(pack?.kind!=='record-pack-v1'||!Array.isArray(pack.records)||pack.records.length>128)throw Error('Immutable block checksum mismatch')
  const entries=[],seen=new Set()
  for(const entry of pack.records){
   if(!Array.isArray(entry)||entry.length!==2||seen.has(entry[0]))throw Error('Immutable pack checksum mismatch')
   const [ref,value]=entry,record={kind:'record',value},encoded=JSON.stringify(record)
   if(hash(encoded)!==ref)throw Error('Immutable pack checksum mismatch')
   seen.add(ref);entries.push([ref,record,Buffer.byteLength(encoded)*2+128])
  }
  if(!seen.has(id))throw Error('Immutable pack is missing requested block')
  for(const entry of entries)cachePacked(dir,...entry)
  return entries.find(entry=>entry[0]===id)[1]
 }
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
 async function writeBlock(dir,value,directories){
  const bytes=JSON.stringify(value),id=hash(bytes),target=blobPath(dir,id),parent=path.dirname(target)
  await mkdir(parent,{recursive:true})
  if(directories){directories.add(parent);directories.add(path.dirname(parent));directories.add(dir)}
  let existing
  try{existing=await readFile(target,'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
  if(existing!==undefined){
   onIO({kind:'read',type:value.kind,bytes:Buffer.byteLength(existing),reason:'deduplication'})
   if(existing!==bytes&&JSON.stringify(decodeBlock(dir,id,existing))!==bytes)throw Error('Immutable block corruption')
   return id
  }
  const staging=target+'.staging-'+randomUUID()
  let handle
  try{
   handle=await open(staging,'wx');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null
   await rename(staging,target)
   if(!directories){
    await syncDirectory(parent)
    await syncDirectory(path.dirname(parent))
    await syncDirectory(dir)
   }
  }finally{if(handle)await handle.close();await rm(staging,{force:true})}
  onIO({kind:'write',type:value.kind,bytes:Buffer.byteLength(bytes)})
  return id
 }
 function reader(dir){
  // Page/index reads remain request-local; decoded record packs have a bounded cache.
  const cache=new Map()
  return async function readBlock(id,kind){
   if(!cache.has(id)){
    const remembered=packed.get(dir+'/'+id)
    if(remembered){cache.set(id,remembered.value);packed.delete(dir+'/'+id);packed.set(dir+'/'+id,remembered)}
    else {
     const bytes=await readFile(blobPath(dir,id),'utf8'),value=decodeBlock(dir,id,bytes)
     cache.set(id,value);onIO({kind:'read',type:value.kind,bytes:Buffer.byteLength(bytes)})
    }
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
 async function create(id,input,{assertCurrent,verifyBeforePublish}={}){
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
   await verifyBeforePublish?.(headId)
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
 // Header/configuration readers never need a history page, including its
 // potentially large historical receipts. The pointer pins all returned fields.
 async function readHead(id,{snapshotId}={}){
  const dir=directory(id),read=reader(dir)
  const selected=snapshotId?{head:validateHead(await read(snapshotId,'head'),id),headId:snapshotId}:await current(dir,id,read)
  if(!selected)return undefined
  const {head,headId}=selected
  return {revision:head.revision,messageCount:head.count,snapshotCursor:{snapshotId:headId,before:head.count},
   state:copy((await read(head.stateId,'state')).value),metadata:copy((await read(head.metadataId,'metadata')).value)}
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
 // Independent immutable blocks may be flushed concurrently. All files and
 // directory entries are durable before this returns and BEFORE head publication.
 async function writeRecords(id,values){
  const dir=directory(id),records=copy(values),directories=new Set(),refs=new Array(records.length)
  const entries=new Map(),groups=[]
  for(let i=0;i<records.length;i++){
   const bytes=JSON.stringify({kind:'record',value:records[i]}),ref=hash(bytes)
   refs[i]=ref;entries.set(ref,{ref,value:records[i],bytes})
  }
  let group=[],groupBytes=64
  for(const entry of entries.values()){
   let existing
   try{existing=await readFile(blobPath(dir,entry.ref),'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
   const parent=path.dirname(blobPath(dir,entry.ref))
   directories.add(parent);directories.add(path.join(dir,'blocks'));directories.add(dir)
   if(existing!==undefined){
    if(JSON.stringify(decodeBlock(dir,entry.ref,existing))!==entry.bytes)throw Error('Immutable block corruption')
    onIO({kind:'read',type:'record',bytes:Buffer.byteLength(existing),reason:'deduplication'})
    continue
   }
   const size=Buffer.byteLength(JSON.stringify([entry.ref,entry.value]))+1
   if(group.length&&(groupBytes+size>64*1024||group.length>=128)){groups.push(group);group=[];groupBytes=64}
   group.push(entry);groupBytes+=size
  }
  if(group.length)groups.push(group)
  const packDirectory=path.join(dir,'blocks','.packs')
  if(groups.some(group=>group.length>1)){await mkdir(packDirectory,{recursive:true});directories.add(packDirectory)}
  // Hard links provide direct hash lookup without a growing pack index. Each
  // pack inode is synced once; all link directories are synced before the head.
  // Filesystems without hard links keep the original durable block layout.
  let index=0
  const workers=Array.from({length:Math.min(8,groups.length)},async()=>{
   while(index<groups.length){
    const group=groups[index++]
    if(group.length===1){await writeBlock(dir,{kind:'record',value:group[0].value},directories);continue}
    const bytes=JSON.stringify({kind:'record-pack-v1',records:group.map(entry=>[entry.ref,entry.value])})
    const target=path.join(packDirectory,hash(bytes)+'.json'),staging=target+'.staging-'+randomUUID()
    let handle
    try{
     handle=await open(staging,'wx');await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null
     await rename(staging,target)
     onIO({kind:'write',type:'record-pack',bytes:Buffer.byteLength(bytes)})
     for(const entry of group){
      const destination=blobPath(dir,entry.ref)
      await mkdir(path.dirname(destination),{recursive:true})
      try{await linkFile(target,destination);onIO({kind:'link',type:'record',bytes:0})}
      catch(error){
       if(error.code==='EEXIST'){
        if(JSON.stringify(decodeBlock(dir,entry.ref,await readFile(destination,'utf8')))!==entry.bytes)throw Error('Immutable block corruption')
       }else if(['EXDEV','EPERM','EACCES','ENOTSUP','EOPNOTSUPP','ENOSYS','EMLINK'].includes(error.code)){
        await writeBlock(dir,{kind:'record',value:entry.value},directories)
       }else throw error
      }
     }
    }finally{if(handle)await handle.close();await rm(staging,{force:true})}
   }
  })
  const results=await Promise.allSettled(workers)
  const failed=results.find(result=>result.status==='rejected')
  if(failed)throw failed.reason
  // Children first, then their parents: no acknowledged head can name a block
  // whose directory entry has not completed its durability barrier.
  const leaves=[...directories].filter(directory=>directory!==dir&&directory!==path.join(dir,'blocks'))
  let directoryIndex=0
  const synced=await Promise.allSettled(Array.from({length:Math.min(8,leaves.length)},async()=>{
   while(directoryIndex<leaves.length)await syncDirectory(leaves[directoryIndex++])
  }))
  const syncFailure=synced.find(result=>result.status==='rejected')
  if(syncFailure)throw syncFailure.reason
  if(directories.size){await syncDirectory(path.join(dir,'blocks'));await syncDirectory(dir)}
  return refs
 }
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
 return Object.freeze({create,commit,readHead,openConversation,readHistoryPage,readState,writeRecord,writeRecords,readRecord,readEntries})
}
