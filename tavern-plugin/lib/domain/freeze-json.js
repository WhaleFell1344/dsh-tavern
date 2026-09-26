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
