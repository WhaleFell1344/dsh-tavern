import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installHostProjectionReplay } from '../tavern-plugin/lib/domain/host-projection-replay.js'

const native = { skip: !process.env.DSH_BOOT_MODULE }
async function harness(t) {
  const url = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(url)
  const root = await mkdtemp(join(tmpdir(), 'tavern-projection-replay-'))
  const config = join(root, 'host.yml')
  await writeFile(config, ['dsh-session', 'dsh-session-projection', 'dsh-token-meter', 'dsh-session-turn-outline'].map(n => '- name: ' + new URL('../../' + n + '/lib/index.js', url).href).join('\n'))
  const ctx = await boot('tavern-projection-replay-test', config)
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return ctx.sessionProjections
}
function fixture(rounds) {
  const events = []
  const add = (type, data, surfaceOp) => events.push({ seq: events.length, type, data, ...(surfaceOp ? { surfaceOp } : {}) })
  const message = (role, text) => ({ id: String(events.length), role, content: [{ type: 'text', text }], source: { kind: role === 'user' ? 'user' : 'model', provider: 'fixture', model: 'fixture' } })
  add('system/message', { message: message('system', 'System 世界') }, 'append')
  for (let turn = 1; turn <= rounds; turn++) {
    add('turn/start', { turn })
    add('user/message', message('user', '继续 '.repeat(30)), 'append')
    add('assistant/message', { turn, step: 1, message: message('assistant', 'Story 故事 '.repeat(50)) }, 'append')
    add('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return { events, add, message }
}
function selected(registry) {
  return ['contextBreakdown', 'turnOutline'].map(key => registry.registrations.get(key).def)
}

test('cold replay equals native folds, including replacements; live definitions and inputs remain isolated', native, async t => {
  const registry = await harness(t)
  const { events, add, message } = fixture(40)
  add('system/message', { message: message('system', '') }, 'append')
  add('system/message', { message: message('system', 'new system') }, 'append')
  const lastSystemSeq = events.length - 1
  add('system/message', { message: { ...message('system', ''), content: [] } }, { op: 'replace', startSeq: lastSystemSeq, endSeq: lastSystemSeq })
  add('tool/result', { message: message('tool', 'tool result') }, 'append')
  add('request/header', { header: { tools: [] } })
  add('assistant/message', { message: message('assistant', 'replacement') }, { op: 'replace', startSeq: 2, endSeq: 3 })
  add('user/message', message('user', 'after replacement'), 'append')
  const defs = selected(registry)
  const nativeBuild = registry.buildCell
  const expected = defs.map(def => nativeBuild.call(registry, def, {}, 0, events))
  const inputs = JSON.stringify(events)
  const applies = defs.map(def => def.apply)
  t.after(installHostProjectionReplay(registry))
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i], actual = registry.buildCell(def, {}, 0, events)
    assert.deepEqual(actual, expected[i])
    assert.equal(def.apply, applies[i])
    const before = structuredClone(actual)
    // Native live apply must not mutate the state returned by cold replay.
    const liveEvent = def.key === 'turnOutline'
      ? { seq: events.length, type: 'turn/start', data: { turn: 41 } }
      : { ...events.at(-1), seq: events.length }
    const live = def.apply(actual.state, liveEvent)
    assert.notEqual(live, actual.state)
    assert.deepEqual(live, def.apply(expected[i].state, liveEvent))
    assert.deepEqual(actual, before)
    assert.deepEqual(registry.buildCell(def, {}, 0, events), expected[i])
    // Every intermediate cut, including the empty-system replacement, must
    // produce the same checkpoint, not only the final totals.
    for (let end = 0; end <= events.length; end++) {
      const prefix = events.slice(0, end)
      assert.deepEqual(registry.buildCell(def, {}, 0, prefix), nativeBuild.call(registry, def, {}, 0, prefix))
    }
  }
  assert.equal(JSON.stringify(events), inputs)
})

test('native checkpoint restore preserves schemas, missing-sequence errors, and checkpoint isolation', native, async t => {
  const registry = await harness(t)
  // Other projections have unrelated step constraints; keep this differential
  // registry scoped to the two native definitions the adapter specializes.
  registry.registrations = new Map([...registry.registrations].filter(([key]) => ['contextBreakdown', 'turnOutline'].includes(key)))
  const { events } = fixture(30)
  const cut = 41
  const baseline = registry.restore({}, events, 0, {}, 0)
  const prefix = registry.restore({}, events.slice(0, cut), 0, {}, 0)
  const checkpoint = structuredClone(prefix.checkpoint)
  const originalApply = selected(registry).map(def => def.apply)
  t.after(installHostProjectionReplay(registry))
  assert.deepEqual(registry.restore({}, events, 0, {}, 0), baseline)
  assert.deepEqual(registry.restore(checkpoint, events.slice(cut), cut, {}, 0), baseline)
  assert.deepEqual(checkpoint, prefix.checkpoint)
  assert.deepEqual(selected(registry).map(def => def.apply), originalApply)
  assert.throws(() => registry.restore({}, events.slice(cut), cut, {}, 0), /checkpoint row/)
  assert.throws(() => registry.restore(checkpoint, events.slice(cut + 1), cut, {}, 0), /missing seq/)
  assert.throws(() => registry.restore({ ...checkpoint, contextBreakdown: { ...checkpoint.contextBreakdown, val: {} } }, events.slice(cut), cut, {}, 0))
  assert.deepEqual(checkpoint, prefix.checkpoint)
})

test('ten-thousand-round cold fold delegates only a bounded suffix, preserving every output row', native, async t => {
  const registry = await harness(t)
  const { events } = fixture(10000)
  const started = performance.now()
  const baseline = new Map(selected(registry).map(def => [def.key, registry.buildCell(def, {}, 0, events)]))
  const nativeMs = performance.now() - started
  t.after(installHostProjectionReplay(registry))
  const optimizedAt = performance.now()
  for (const def of selected(registry)) {
    let maxRows = 0, calls = 0
    const measured = { ...def, apply(state, event) {
      maxRows = Math.max(maxRows, (state.nodes || state.turns).length)
      calls++
      return def.apply(state, event)
    } }
    const cell = registry.buildCell(measured, {}, 0, events)
    assert.deepEqual(cell, baseline.get(def.key))
    // Non-surface context events use native apply with the full array but do
    // not copy/scan it. Count only actual append transitions separately below.
    assert.equal(calls, events.length)
    assert.equal((cell.state.nodes || cell.state.turns).length, def.key === 'contextBreakdown' ? 20001 : 10000)
    if (def.key === 'turnOutline') assert.ok(maxRows <= 1)
    let appendMax = 0
    registry.buildCell({ ...def, apply(state, event) {
      if (event.surfaceOp === 'append') appendMax = Math.max(appendMax, (state.nodes || state.turns).length)
      return def.apply(state, event)
    } }, {}, 0, events)
    assert.ok(appendMax <= 1)
  }
  t.diagnostic(`10000 rounds: native ${nativeMs.toFixed(1)} ms; optimized including two folds and equality checks ${(performance.now() - optimizedAt).toFixed(1)} ms`)
})

test('installation is reference counted and leaves unknown projection versions native', native, async t => {
  const registry = await harness(t)
  const originalBuild = Object.getOwnPropertyDescriptor(registry, 'buildCell'), originalRestore = Object.getOwnPropertyDescriptor(registry, 'restore')
  const stop1 = installHostProjectionReplay(registry), stop2 = installHostProjectionReplay(registry)
  const { events } = fixture(3)
  const nativeDef = selected(registry)[1]
  let maxRows = 0
  const unknown = { ...nativeDef, stateVersion: 999, apply(state, event) { maxRows = Math.max(maxRows, state.turns.length); return nativeDef.apply(state, event) } }
  registry.buildCell(unknown, {}, 0, events)
  assert.equal(maxRows, 3)
  stop1(); stop1()
  assert.ok(Object.hasOwn(registry, 'buildCell'))
  stop2()
  assert.deepEqual(Object.getOwnPropertyDescriptor(registry, 'buildCell'), originalBuild)
  assert.deepEqual(Object.getOwnPropertyDescriptor(registry, 'restore'), originalRestore)
})
