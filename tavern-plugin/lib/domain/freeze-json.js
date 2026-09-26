import {createOrderedNumericIndex} from './ordered-numeric-index.js'
import {createIndexedArrayApi} from './indexed-array.js'
// Internal immutable projections may share JSON subtrees across revisions.
// Public editable reads must still detach them before returning.
const immutable = new WeakSet()
export const isImmutableJson = value => Boolean(value && typeof value === 'object' && immutable.has(value))
export function freezeJson(value) {
  if (!value || typeof value !== 'object' || immutable.has(value)) return value
  for (const child of Object.values(value)) freezeJson(child)
  Object.freeze(value)
  immutable.add(value)
  return value
}

// Immutable indexed arrays retain shared branches across point updates. Only
// this factory can brand them: every stored row is deeply frozen first.
const indexedOwners = new WeakMap()
export function createImmutableJsonIndex(options) {
  const index=createIndexedArrayApi(options)
  const brand=value=>{immutable.add(value);indexedOwners.set(value,index);return value}
  return {...index,
    from(source){return index.info(source) ? source : brand(index.from(source.map(freezeJson)))},
    update(source,entries,length=source.length){return brand(index.update(index.info(source) ? source : index.from(source.map(freezeJson)),entries.map(([id,row])=>[id,freezeJson(row)]),length))}
  }
}
export function immutableArrayChanges(before,after) {
  const index=indexedOwners.get(after)
  return index && index===indexedOwners.get(before) ? index.changed(before,after) : null
}

export function createImmutableOrderedJsonIndex(options) {
  const index=createOrderedNumericIndex(options)
  const owner={ordered:index,changed(before,after){
    const changes=index.changed(before,after)
    if(!changes)return null
    const dirty=new Set()
    let shifted=after.length
    for(const row of changes){
      if(row.before===undefined || row.after===undefined){
        shifted=Math.min(shifted,index.rank(before,row.key),index.rank(after,row.key))
      }else dirty.add(index.rank(after,row.key))
    }
    // Positional consumers must see shifted rows, but a tail append/truncation
    // leaves the shared prefix untouched. Never scan that prefix for hashes.
    for(let position=shifted;position<after.length;position++)dirty.add(position)
    return [...dirty]
  }}
  const brand=value=>{immutable.add(value);indexedOwners.set(value,owner);return value}
  return {...index,
    from(entries){return brand(index.from(entries.map(([key,value])=>[key,freezeJson(value)])))},
    update(source,entries){return brand(index.update(source,entries.map(([key,value])=>[key,freezeJson(value)])))}
  }
}

export function isImmutableOrderedArray(value) {
  const info=indexedOwners.get(value)?.ordered?.info(value)
  return Boolean(info && info.unsafe===0)
}
export function immutableOrderedChanges(before,after) {
  const owner=indexedOwners.get(after)
  return owner?.ordered && owner===indexedOwners.get(before) ? owner.ordered.changed(before,after) : null
}
