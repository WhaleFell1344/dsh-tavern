import { createHash, randomUUID } from 'node:crypto'
import { createIndexedArrayApi } from './indexed-array.js'

// Reader cursors retain fingerprints only; never retain another full chat snapshot.
export function createSessionViewSync({ maxReaders = 32 } = {}) {
  const readers = new Map()
  const messageHashes = createIndexedArrayApi()
  function hashValue(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
  }
  function parts(view) {
    const result = new Map()
    function add(path, value) {
      if (value === undefined) return
      const key = JSON.stringify(path)
      result.set(key, { path, value, hash: hashValue(value) })
    }
    for (const [key, value] of Object.entries(view || {})) {
      if (key === 'replyProjections' && Array.isArray(value)) {
        add([key, 'length'], value.length)
        value.forEach((row, index) => add([key, index], row))
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
    const messages = view?.tavernHelper?.messages
    let indexedHashes, messageSet = [], messageRemove = []
    if (Array.isArray(messages)) {
      const canReuse = base?.messageHashes && dirtyMessageIndices
      const indices = canReuse ? new Set(dirtyMessageIndices) : new Set(messages.keys())
      if (canReuse) for (let i = base.messageHashes.length; i < messages.length; i++) indices.add(i)
      const updates = []
      for (const index of indices) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length) continue
        const value = messages[index], hash = hashValue(value)
        updates.push([index, hash])
        if (!base?.messageHashes || base.messageHashes[index] !== hash) messageSet.push([['tavernHelper','messages',index],value])
      }
      indexedHashes = messageHashes.update(canReuse ? base.messageHashes : [], updates, messages.length)
    }
    if (base?.messageHashes) {
      const length = Array.isArray(messages) ? messages.length : 0
      for (let i = length; i < base.messageHashes.length; i++) messageRemove.push(['tavernHelper','messages',i])
    }
    const nextCursor = randomUUID()
    const hashes = new Map()
    for (const [key, item] of current) hashes.set(key, item.hash)
    readers.set(nextCursor, {
      sessionId,
      hashes,
      messageHashes: indexedHashes,
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
