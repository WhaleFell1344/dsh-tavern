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
