import { createHash } from 'node:crypto'
import { createIndexedArrayApi } from './indexed-array.js'
import { freezeJson } from './freeze-json.js'
import { projectReplyHistory } from './reply-presentation.js'
import { projectPersistentStatusView } from './persistent-status-view.js'

// Display projection resolves identity macros only. Gameplay variables must not
// invalidate every historical row on each settlement.
function displayDependencies(options) {
  return {...options, macroState: {userName: options.macroState?.userName}}
}

// Derived, disposable state only. The journal remains the authority for changed indices.
export function createIncrementalReplyView({ readChanges, maxBytes = 8 * 1024 * 1024, maxEntries = 4 } = {}) {
  const cache = new Map()
  const sourceIndex = createIndexedArrayApi({measure:value=>48+String(value).length*2})
  function sourceKey(message) {
    if (!message) return JSON.stringify(message)
    const {variables,mvu,...display} = message
    return createHash('sha256').update(JSON.stringify(display)).digest('hex')
  }
  function output(result, shared) { return shared ? {...result} : structuredClone(result) }
  let bytes = 0
  const stats = { rebuilt: 0, incremental: 0, reused: 0, projectedMessages: 0 }
  async function project(chat, options = {}, statusOptions = options, {shared = false} = {}) {
    const signature = createHash('sha256').update(JSON.stringify([displayDependencies(options), displayDependencies(statusOptions), chat.timeline?.branchId])).digest('hex')
    const previous = cache.get(chat.id)
    const revision = chat._storageRevision
    const messages = Array.isArray(chat.messages) ? chat.messages : []
    let changes
    if (previous?.signature === signature && Number.isSafeInteger(revision)) {
      if (previous.revision === revision) { stats.reused++; return output(previous.result,shared) }
      if (previous.revision < revision) {
        try { changes = await readChanges?.(chat.id, previous.revision) }
        catch { changes = undefined } // The full Chat was already read successfully.
      }
    }
    const compatible = changes && changes.baseRevision === previous.revision && changes.chat?._storageRevision === revision
      && changes.messageCount === messages.length && changes.denseMessages && Array.isArray(changes.indices)
      && changes.indices.every((index, at) => Number.isSafeInteger(index) && index >= 0 && index < messages.length && (at === 0 || index > changes.indices[at - 1]))
    // MVU payloads/receipts do not participate in body or static panel projection.
    // Check only the declared dirty sources, then retain the immutable result.
    if (compatible && messages.length === previous.roles.length
      && changes.indices.every(id => sourceKey(messages[id]) === previous.sources[id])) {
      if (cache.get(chat.id) === previous) previous.revision = revision
      stats.reused++
      return output(previous.result,shared)
    }
    let rows, roles, before, indices
    if (compatible) {
      rows = previous.rows.slice(0, messages.length)
      roles = previous.roles.slice(0, messages.length)
      before = previous.before.slice(0, messages.length)
      indices = [...changes.indices]
      const structural = messages.length !== previous.roles.length || indices.some(i => messages[i]?.role !== previous.roles[i])
      if (structural) {
        const first = indices.reduce((first, index) => Math.min(first, index), Math.min(previous.roles.length, messages.length))
        indices = Array.from({length: messages.length - first}, (_, i) => first + i)
      }
      stats.incremental++
    } else {
      rows = []; roles = []; before = []
      indices = Array.from({length: messages.length}, (_, i) => i)
      stats.rebuilt++
    }
    const projectMessages = projectReplyHistory.prepare(options)
    for (const index of indices) {
      const message = messages[index]
      before[index] = index === 0 ? 1 : before[index - 1] + (roles[index - 1] === 'user' ? 1 : 0)
      roles[index] = message?.role
      if (message?.role !== 'assistant') { rows[index] = null; continue }
      const turn = Math.max(0, Number(message.turn) || (message.greeting === true ? 1 : before[index]))
      if (turn === 0) { rows[index] = null; continue }
      rows[index] = projectMessages([{...message, turn}])
      stats.projectedMessages++
    }
    const projections = rows.flatMap(row => row?.projections || [])
    const status = projectPersistentStatusView(messages, projections, statusOptions)
    const result = freezeJson({ ...status, presentation: null, latestSourceBacked: rows.findLast(row => row)?.latestSourceBacked || false })
    const sources = compatible
      ? sourceIndex.update(previous.sources,indices.map(id=>[id,sourceKey(messages[id])]),messages.length)
      : sourceIndex.from(messages.map(sourceKey))
    const size = JSON.stringify([rows, result]).length * 2 + messages.length * 64 + 512 + sourceIndex.info(sources).bytes
    if (Number.isSafeInteger(revision) && size <= maxBytes && maxEntries > 0 && !(cache.get(chat.id)?.revision > revision)) {
      if (cache.has(chat.id)) { bytes -= cache.get(chat.id).size; cache.delete(chat.id) }
      while (cache.size && (bytes + size > maxBytes || cache.size >= maxEntries)) {
        const oldest = cache.keys().next().value; bytes -= cache.get(oldest).size; cache.delete(oldest)
      }
      cache.set(chat.id, {revision, signature, rows, roles, before, result, size, sources}); bytes += size
    }
    return output(result,shared)
  }
  return { project, stats: () => ({...stats, entries: cache.size, estimatedBytes: bytes}) }
}
