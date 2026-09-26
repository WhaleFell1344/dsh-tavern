import {createIndexedArrayApi} from './indexed-array.js'
import {freezeJson} from './freeze-json.js'
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
// Only message projections are retained; returning rows always detaches receipts.
export function createMvuReceiptIndex({maxBytes = 8*1024*1024} = {}) {
  const cache = new Map()
  let retainedBytes = 0
  const all = createIndexedArrayApi({eligible:row=>row.assistant,measure:row=>JSON.stringify(row).length*2})
  const quiet = createIndexedArrayApi({eligible:row=>row.receipt && !notable.has(String(row.receipt.status ?? ''))})
  const alerts = createIndexedArrayApi({eligible:row=>row.receipt && notable.has(String(row.receipt.status ?? ''))})
  return function project(chat,activity,changes) {
    const messages = Array.isArray(chat.messages) ? chat.messages : []
    const previous = cache.get(chat.id), revision = chat._storageRevision
    const reuse = previous && changes && Number.isSafeInteger(revision) && previous.lifecycle === chat.tavernHelperLifecycleRevision
      && (previous.revision === revision || previous.revision === changes.baseRevision)
      && Array.isArray(changes.indices)
    let state
    if (reuse) {
      const indices = new Set(previous.revision === revision ? [] : changes.indices)
      for(let id=previous.length;id<messages.length;id++)indices.add(id)
      const entries = [...indices].filter(id=>id>=0 && id<messages.length).map(id=>[id,rowOf(messages[id])])
      state = {...previous,revision,length:messages.length,all:all.update(previous.all,entries,messages.length),
        quiet:quiet.update(previous.quiet,entries,messages.length),alerts:alerts.update(previous.alerts,entries,messages.length)}
    } else {
      const rows = messages.map(rowOf)
      state = {revision,lifecycle:chat.tavernHelperLifecycleRevision,length:messages.length,all:all.from(rows),quiet:quiet.from(rows),alerts:alerts.from(rows)}
    }
    state.bytes = all.info(state.all).bytes + quiet.info(state.quiet).bytes + alerts.info(state.alerts).bytes
    if (chat.id && Number.isSafeInteger(revision) && state.bytes <= maxBytes && !(previous?.revision > revision)) {
      if(previous) { retainedBytes -= previous.bytes; cache.delete(chat.id) }
      while(cache.size && (cache.size>=8 || retainedBytes+state.bytes>maxBytes)) {
        const key=cache.keys().next().value;retainedBytes-=cache.get(key).bytes;cache.delete(key)
      }
      cache.set(chat.id,state);retainedBytes+=state.bytes
    }
    const latest = all.previous(state.all,messages.length)
    const interrupted = activity.reason === 'interrupted' && activity.role === 'settlement' && state.all[latest]?.receipt ? latest : -1
    const selected = []
    for(let id=alerts.previous(state.alerts,messages.length);id>=0;id=alerts.previous(state.alerts,id)) selected.push(id)
    if(interrupted>=0 && !selected.includes(interrupted))selected.push(interrupted)
    selected.sort((a,b)=>a-b)
    const ordinary=[]
    for(let id=quiet.previous(state.quiet,messages.length);id>=0 && ordinary.length<3;id=quiet.previous(state.quiet,id)) if(id!==interrupted)ordinary.push(id)
    selected.push(...ordinary.reverse())
    const byTurn = new Map()
    for(const id of selected) {
      const row = state.all[id], receipt = structuredClone(row.receipt)
      if(id===interrupted) {
        receipt.status='interrupted'
        receipt.summary='后台结算因服务重启或异常退出而中断，请重试结算；正文和已保存变量保留。'
      }
      byTurn.set(row.turn,{turn:row.turn,receipt})
    }
    return [...byTurn.values()].sort((a,b)=>a.turn-b.turn)
  }
}
