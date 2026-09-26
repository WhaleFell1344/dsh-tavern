import { createHash, randomUUID } from 'node:crypto'
import { createIndexedArrayApi } from './indexed-array.js'
import { isImmutableJson, immutableArrayChanges } from './freeze-json.js'

// Reader cursors retain fingerprints only; never retain another full chat snapshot.
export function createSessionViewSync({ maxReaders = 32 } = {}) {
  const readers = new Map()
  const messageHashes = createIndexedArrayApi()
  const immutableHashes = new WeakMap()
  function hashValue(value) {
    if (isImmutableJson(value) && immutableHashes.has(value)) return immutableHashes.get(value)
    const hash = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    if (isImmutableJson(value)) immutableHashes.set(value,hash)
    return hash
  }
  function parts(view) {
    const result = new Map()
    function add(path, value) {
      if (value === undefined) return
      const key = JSON.stringify(path)
      result.set(key, { path, value, hash: hashValue(value) })
    }
    for (const [key, value] of Object.entries(view || {})) {
      if (['replyProjections','mvuReceipts'].includes(key) && Array.isArray(value)) {
        add([key, 'length'], value.length)
        // Row hashes are retained separately, like Helper messages.
      } else if (['inputSources', 'inputTemplateDisplays', 'tavernHelper'].includes(key) && value && typeof value === 'object') {
        add([key], {})
        for (const [field, item] of Object.entries(value)) {
          if (key === 'tavernHelper' && field === 'messages' && Array.isArray(item)) {
            add([key, field, 'length'], item.length)
            // Per-floor hashes live in a persistent index, outside the small header map.
            // A trusted dirty set covers edits; append/truncation are explicit.
          } else add([key, field], item)
        }
      } else add([key], value)
    }
    return result
  }
  function synchronize(sessionId, view, cursor, options = {}) {
    if (view === null) return { view: null, viewCursor: null }
    const previous = readers.get(cursor)
    const dirtyMessageIndices = options.dirtyMessageIndices instanceof Set ? options.dirtyMessageIndices : null
    const base = previous?.sessionId === sessionId ? previous : null
    const current = parts(view)
    const messages = view?.tavernHelper?.messages, replies = view?.replyProjections
    const receipts=view?.mvuReceipts
    const receiptChanges=immutableArrayChanges(base?.receiptSource?.deref(),receipts)
    const sameReplies = isImmutableJson(replies) && base?.replySource?.deref() === replies
    const arrays = [
      {path:['tavernHelper','messages'],value:messages,previous:base?.messageHashes,dirty:dirtyMessageIndices},
      {path:['replyProjections'],value:replies,previous:base?.replyHashes,dirty:sameReplies ? new Set() : null},
      {path:['mvuReceipts'],value:receipts,previous:base?.receiptHashes,dirty:receiptChanges ? new Set(receiptChanges) : null}
    ]
    const messageSet = [], messageRemove = []
    for (const field of arrays) {
      if (Array.isArray(field.value)) {
        const canReuse = field.previous && field.dirty
        const indices = canReuse ? new Set(field.dirty) : new Set(field.value.keys())
        if (canReuse) for (let i=field.previous.length;i<field.value.length;i++) indices.add(i)
        const updates=[]
        for (const index of indices) {
          if (!Number.isSafeInteger(index) || index<0 || index>=field.value.length) continue
          const value=field.value[index],hash=hashValue(value)
          updates.push([index,hash])
          if (!field.previous || field.previous[index]!==hash) messageSet.push([[...field.path,index],value])
        }
        field.next=messageHashes.update(canReuse ? field.previous : [],updates,field.value.length)
      }
      if (field.previous) {
        const length=Array.isArray(field.value) ? field.value.length : 0
        for(let i=length;i<field.previous.length;i++) messageRemove.push([...field.path,i])
      }
    }
    const nextCursor = randomUUID()
    const hashes = new Map()
    for (const [key, item] of current) hashes.set(key, item.hash)
    readers.set(nextCursor, {
      sessionId,
      hashes,
      messageHashes: arrays[0].next,
      replyHashes: arrays[1].next,
      receiptHashes: arrays[2].next,
      receiptSource: isImmutableJson(receipts) ? new WeakRef(receipts) : undefined,
      replySource: isImmutableJson(replies) ? new WeakRef(replies) : undefined,
      revision: Number.isSafeInteger(options.revision) ? options.revision : previous?.revision
    })
    while (readers.size > maxReaders) readers.delete(readers.keys().next().value)
    if (!previous || previous.sessionId !== sessionId) return { view, viewCursor: nextCursor }
    const set = [], remove = messageRemove
    for (const [key, item] of current) {
      if (previous.hashes.get(key) === item.hash) continue
      set.push([item.path, item.value])
    }
    for (const key of previous.hashes.keys()) if (!current.has(key)) remove.push(JSON.parse(key))
    for (const entry of messageSet) set.push(entry)
    return { viewCursor: nextCursor, viewDelta: { baseCursor: cursor, set, remove } }
  }
  synchronize.peek = function peek(cursor) {
    return readers.get(cursor) || null
  }
  return synchronize
}
