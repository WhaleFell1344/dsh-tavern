import {copyJsonTree} from './copy-json-tree.js'
import {createScopedMessages} from './scoped-messages.js'

function lazyArray(source) {
  const detached=new Map()
  const rows=createScopedMessages(source.length,[],index=>{
    if(!detached.has(index))detached.set(index,copyJsonTree(source[index]))
    return detached.get(index)
  })
  // Unlike transaction-owned rows, a readable history array must enumerate
  // every index when explicitly requested. Enumeration pays for its own output.
  return new Proxy(rows,{
    ownKeys(){return [...Array.from({length:source.length},(_,index)=>String(index)),'length']},
    getOwnPropertyDescriptor(target,key){
      if(typeof key==='string' && /^(0|[1-9]\d*)$/.test(key) && Number(key)<source.length)
        return {enumerable:true,configurable:true,get:()=>target[key]}
      return Reflect.getOwnPropertyDescriptor(target,key)
    }
  })
}

// Internal display/activity inputs only. Rollback payloads can contain entire
// historical Chats; retain their immutable source version and detach on access.
// Default public reads still materialize ordinary, structuredClone-safe arrays.
export function copyLazyHistoryHeader(source) {
  const timeline=source.timeline, undo=source.rollbackUndo
  const head={...source}
  if(Array.isArray(timeline?.checkpoints))head.timeline={...timeline,checkpoints:[]}
  if(undo && typeof undo==='object') {
    head.rollbackUndo={...undo}
    if(Object.hasOwn(undo,'before'))head.rollbackUndo.before=undefined
    if(Array.isArray(undo.background))head.rollbackUndo.background=[]
    if(Array.isArray(undo.foreground?.nodes))head.rollbackUndo.foreground={...undo.foreground,nodes:[]}
  }
  const result=copyJsonTree(head)
  if(Array.isArray(timeline?.checkpoints))result.timeline.checkpoints=lazyArray(timeline.checkpoints)
  if(Array.isArray(undo?.foreground?.nodes))result.rollbackUndo.foreground.nodes=lazyArray(undo.foreground.nodes)
  if(Array.isArray(undo?.background))result.rollbackUndo.background=lazyArray(undo.background)
  if(undo && Object.hasOwn(undo,'before')) {
    Object.defineProperty(result.rollbackUndo,'before',{
      enumerable:true,configurable:true,
      get(){const value=copyJsonTree(undo.before);Object.defineProperty(this,'before',{value,writable:true,enumerable:true,configurable:true});return value},
      set(value){Object.defineProperty(this,'before',{value,writable:true,enumerable:true,configurable:true})}
    })
  }
  return result
}
