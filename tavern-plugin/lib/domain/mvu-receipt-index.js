import {createIndexedArrayApi} from './indexed-array.js'
import {freezeJson,createImmutableJsonIndex} from './freeze-json.js'
import {copyJsonTree} from './copy-json-tree.js'
const notable = new Set(['pending','error','interrupted','partial','stale'])
function rowOf(message) {
  const assistant = message?.role === 'assistant'
  const turn = Math.max(0,Number(message?.turn) || (message?.greeting === true ? 1 : 0))
  if (!assistant || !turn || !message.mvu) return {assistant}
  const stored = message.mvu.receipt, diagnostics = Array.isArray(message.mvu.diagnostics) ? message.mvu.diagnostics : []
  const receipt = stored && typeof stored === 'object' ? structuredClone(stored) : {
    version:1,status:message.mvu.pending === true ? 'pending' : diagnostics.length ? 'error' : message.mvu.modified === true ? 'updated' : 'unchanged',
    summary:'',changes:[],failures:diagnostics.map(item=>({command:String(item.command ?? ''),message:String(item.message ?? '')}))
  }
  return freezeJson({assistant,turn,receipt})
}
// Public reads detach receipts; internal views may share branded immutable output.
export function createMvuReceiptIndex({maxBytes = 8*1024*1024, shared = false, onVisit} = {}) {
  const outputIndex=createImmutableJsonIndex({visit:onVisit,measure:row=>JSON.stringify(row).length*2})
  const cache = new Map()
  let retainedBytes = 0
  const all = createIndexedArrayApi({visit:onVisit,eligible:row=>row.assistant,measure:row=>JSON.stringify(row).length*2})
  const quiet = createIndexedArrayApi({visit:onVisit,eligible:row=>row.receipt && !notable.has(String(row.receipt.status ?? ''))})
  const alerts = createIndexedArrayApi({visit:onVisit,eligible:row=>row.receipt && notable.has(String(row.receipt.status ?? ''))})
  return function project(chat,activity,changes) {
    const messages = Array.isArray(chat.messages) ? chat.messages : []
    const previous = cache.get(chat.id), revision = chat._storageRevision
    const reuse = previous && changes && Number.isSafeInteger(revision) && previous.lifecycle === chat.tavernHelperLifecycleRevision
      && (previous.revision === revision || previous.revision === changes.baseRevision)
      && Array.isArray(changes.indices)
    let state, pointEntries
    if (reuse) {
      const indices = new Set(previous.revision === revision ? [] : changes.indices)
      for(let id=previous.length;id<messages.length;id++)indices.add(id)
      const entries = [...indices].filter(id=>id>=0 && id<messages.length).map(id=>[id,rowOf(messages[id])])
        .filter(([id,row])=>id>=previous.length || JSON.stringify(row)!==JSON.stringify(previous.all[id]))
      pointEntries=entries
      const unchanged = entries.length===0 && previous.length===messages.length
      state = {...previous,revision,length:messages.length,all:unchanged ? previous.all : all.update(previous.all,entries,messages.length),
        quiet:unchanged ? previous.quiet : quiet.update(previous.quiet,entries,messages.length),alerts:unchanged ? previous.alerts : alerts.update(previous.alerts,entries,messages.length)}
    } else {
      const rows = messages.map(rowOf)
      state = {revision,lifecycle:chat.tavernHelperLifecycleRevision,length:messages.length,all:all.from(rows),quiet:quiet.from(rows),alerts:alerts.from(rows)}
    }
    const latest = all.previous(state.all,messages.length)
    const interrupted = activity.reason === 'interrupted' && activity.role === 'settlement' && state.all[latest]?.receipt ? latest : -1
    const unchangedOutput = reuse && state.all===previous.all && previous.interrupted===interrupted && previous.output
    if (unchangedOutput) {
      state.output=previous.output;state.outputBytes=previous.outputBytes
    } else if (reuse && previous.length===messages.length && previous.interrupted===interrupted
      && pointEntries.every(([id,row])=>{
        const old=previous.all[id]
        return old.assistant===row.assistant && old.turn===row.turn && Boolean(old.receipt)===Boolean(row.receipt)
          && notable.has(String(old.receipt?.status ?? ''))===notable.has(String(row.receipt?.status ?? ''))
      })) {
      const entries=pointEntries.filter(([id])=>previous.outputPositions.has(id)).map(([id,row])=>[previous.outputPositions.get(id),{turn:row.turn,receipt:displayReceipt(row,id,interrupted)}])
      state.output=entries.length ? outputIndex.update(previous.output,entries) : previous.output
      state.outputBytes=outputIndex.info(state.output).bytes
    } else {
      const selected = []
      for(let id=alerts.previous(state.alerts,messages.length);id>=0;id=alerts.previous(state.alerts,id)) selected.push(id)
      if(interrupted>=0 && !selected.includes(interrupted))selected.push(interrupted)
      selected.sort((a,b)=>a-b)
      const ordinary=[]
      for(let id=quiet.previous(state.quiet,messages.length);id>=0 && ordinary.length<3;id=quiet.previous(state.quiet,id)) if(id!==interrupted)ordinary.push(id)
      selected.push(...ordinary.reverse())
      const byTurn = new Map()
      for(const id of selected) {
        const row = state.all[id]
        byTurn.set(row.turn,{id,value:{turn:row.turn,receipt:displayReceipt(row,id,interrupted)}})
      }
      const selectedRows=[...byTurn.values()].sort((a,b)=>a.value.turn-b.value.turn)
      state.outputPositions=new Map(selectedRows.map((row,index)=>[row.id,index]))
      state.output=outputIndex.from(selectedRows.map(row=>row.value))
      state.outputBytes=outputIndex.info(state.output).bytes
    }
    state.interrupted=interrupted
    state.bytes = all.info(state.all).bytes + quiet.info(state.quiet).bytes + alerts.info(state.alerts).bytes + state.outputBytes + state.outputPositions.size*48
    if (chat.id && Number.isSafeInteger(revision) && state.bytes <= maxBytes && !(previous?.revision > revision)) {
      if(previous) { retainedBytes -= previous.bytes; cache.delete(chat.id) }
      while(cache.size && (cache.size>=8 || retainedBytes+state.bytes>maxBytes)) {
        const key=cache.keys().next().value;retainedBytes-=cache.get(key).bytes;cache.delete(key)
      }
      cache.set(chat.id,state);retainedBytes+=state.bytes
    }
    return shared ? state.output : copyJsonTree(state.output)
  }
}

function displayReceipt(row,id,interrupted) {
  if(id!==interrupted)return row.receipt
  return {...row.receipt,status:'interrupted',summary:'后台结算因服务重启或异常退出而中断，请重试结算；正文和已保存变量保留。'}
}
