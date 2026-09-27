import { projectChatSessionState } from '../tavern-plugin/lib/domain/chat-session-state.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutoCompaction, compactionPolicy, installCompactionPolicy } from '../tavern-plugin/lib/domain/auto-compaction.js'
function fixture() {
  let chat = { id: 'chat', mode: 'story', sessionId: 'front', messages: [], timeline: { branchId: 'main', participants: { background: { sessionId: 'back' } } } }
  let policy = { mode: 'manual' }, activity = { phase: 'idle' }, pressure = 0, fail = '', evidence = 'succeeded'
  const calls = [], deps = {
    readState: async () => projectChatSessionState(chat),
    readChat: async () => structuredClone(chat), updateChat: async (_id, fn) => { chat = fn(structuredClone(chat)); return structuredClone(chat) },
    policy: async () => policy, activity: () => activity, pressure: async () => pressure === null ? null : { percent: pressure },
    exclusive: async (_id, fn) => fn(), checkpoint: async () => 7, recover: async () => evidence, markBackground: async () => {},
    compact: async (id, side) => { calls.push(side); if (fail === side) throw new Error('fixture failure'); return { message: 'done' } }
  }
  let service = createAutoCompaction(deps)
  return { calls, deps, get chat() { return chat }, set policy(v) { policy = v }, set activity(v) { activity = v }, set pressure(v) { pressure = v }, set fail(v) { fail = v },
    run: options => service.run('front', options), round(n) { chat.messages.push({ role: 'assistant', turn: n }) },
    restart() { service = createAutoCompaction(deps) }, blocked: () => service.blocked(chat) }
}
test('default manual disables only the extra joint schedule; settings validate bounds', async () => {
  assert.equal(compactionPolicy().mode, 'manual')
  for (const policy of [{ mode: 'bad' }, { rounds: 0 }, { percent: 100 }, { rounds: 1.5 }]) assert.throws(() => compactionPolicy(policy))
  const h = fixture(); h.pressure = 100; h.round(1); await h.run(); assert.deepEqual(h.calls, [])
})
test('idle manual checks after rollback do not write metadata and invalidate its undo revision', async () => {
  const h = fixture()
  h.chat.timeline.branchId = 'rolled-back'
  h.chat._storageRevision = 23
  h.chat.rollbackUndo = { ready: true, storageRevision: 23 }
  h.chat.contextCompaction = { branch: 'main', operation: null }
  let writes = 0
  const update = h.deps.updateChat
  h.deps.updateChat = (...args) => { writes++; return update(...args) }
  const before = structuredClone(h.chat)
  await h.run()
  assert.equal(writes, 0)
  assert.deepEqual(h.chat, before)
})
test('round mode counts distinct completed story turns; manual success resets baseline', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 2 }; await h.run()
  h.round(1); h.round(1); h.chat.messages.push({ role: 'assistant', turn: 90, greeting: true }); await h.run(); assert.equal(h.calls.length, 0)
  h.round(2); await h.run(); assert.deepEqual(h.calls, ['foreground', 'background'])
  h.round(3); await h.run({ manual: true }); h.round(4); await h.run(); assert.equal(h.calls.length, 4)
  h.round(5); await h.run(); assert.equal(h.calls.length, 6)
})
test('percent mode, unknown capacity, no-progress suppression and branch reset', async () => {
  const h = fixture(); h.policy = { mode: 'percent', percent: 80 }; h.pressure = null; await h.run(); assert.match(h.chat.contextCompaction.warning, /容量/)
  h.pressure = 79; await h.run(); assert.equal(h.calls.length, 0)
  h.pressure = 80; await h.run(); assert.equal(h.calls.length, 2)
  await h.run(); assert.equal(h.calls.length, 2)
  h.chat.timeline.branchId = 'fork'; h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); assert.equal(h.calls.length, 2)
  h.round(1); await h.run(); assert.equal(h.calls.length, 4)
})
test('waits for settlement without blocking it; duplicate automatic calls share one operation', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); h.round(1); h.activity = { phase: 'pending' }
  const a = h.run(), b = h.run()
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(h.blocked(), false); assert.equal(h.calls.length, 0)
  h.activity = { phase: 'idle' }; await Promise.all([a, b]); assert.deepEqual(h.calls, ['foreground', 'background'])
})
test('partial failure persists across restart, manual retry only repeats failed side', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); h.round(1); h.fail = 'background'; await h.run()
  assert.equal(h.chat.contextCompaction.operation.status, 'partial'); h.restart(); h.fail = ''; await h.run(); assert.equal(h.calls.length, 2)
  await h.run({ manual: true }); assert.deepEqual(h.calls, ['foreground', 'background', 'background'])
})
test('restart recovers a dispatched successful foreground from native evidence without reissuing it', async () => {
  const h = fixture(); h.chat.contextCompaction = { operation: { id: 'old', status: 'running', foregroundSessionId: 'front', backgroundSessionId: 'back', foreground: { status: 'dispatching', before: 7 }, background: { status: 'pending' } } }
  h.restart(); await h.run(); assert.deepEqual(h.calls, ['background']); assert.equal(h.chat.contextCompaction.operation.status, 'completed')
})
test('scoped native policy preserves non-Tavern behavior and restores on disposal', async () => {
  const calls = [], engine = { async compactIfNeeded(agent, trigger) { calls.push(trigger); return 'native' } }, original = engine.compactIfNeeded
  const stop = installCompactionPolicy(engine, (agent, trigger, signal, fallback, force) => agent.id === 'tavern' ? null : fallback())
  assert.equal(await engine.compactIfNeeded({ id: 'tavern' }, 'pressure'), null)
  assert.equal(await engine.compactIfNeeded({ id: 'other' }, 'pressure'), 'native'); assert.deepEqual(calls, ['pressure']); stop(); assert.equal(engine.compactIfNeeded, original)
})

test('resumes pending settlement after restart and allows compression after a failed settlement', async () => {
  const h = fixture(); h.activity = { role: 'settlement', phase: 'pending' }
  let settled = 0
  h.deps.settle = async () => { settled++; h.activity = { role: 'settlement', phase: 'failed' } }
  await h.run({ manual: true })
  assert.equal(settled, 1)
  assert.deepEqual(h.calls, ['foreground', 'background'])
  assert.equal(h.chat.contextCompaction.operation.status, 'completed')
})

test('queued foreground input defers idle compression and retries at pre-step', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); h.round(1)
  const compact = h.deps.compact
  h.deps.compact = async (id, side, options) => {
    if (side === 'foreground' && !options.openTurnCompact) throw Object.assign(new Error('busy'), { code: 'busy' })
    return compact(id, side)
  }
  const idle = h.run(), preStep = h.run({ openTurnCompact: () => {} })
  assert.equal((await idle).status, 'deferred')
  assert.equal((await preStep).status, 'completed')
  assert.deepEqual(h.calls, ['foreground', 'background'])
})

test('压缩失败原因进入持久警告，前后台结果保持独立', async () => {
  const h = fixture()
  h.deps.compact = async (_id, side) => {
    if (side === 'foreground') throw new Error('pi-ai stream idle timeout after 300000ms')
    return { message: '后台已压缩' }
  }
  await h.run({ manual: true })
  const state = h.chat.contextCompaction
  assert.equal(state.operation.status, 'partial')
  assert.equal(state.operation.background.status, 'succeeded')
  assert.match(state.warning, /前台：压缩超时：连续 5 分钟/)
  assert.match(state.warning, /可稍后重试/)
  assert.doesNotMatch(state.warning, /后台：压缩超时/)
  h.restart()
  assert.equal(h.chat.contextCompaction.warning, state.warning)
})

test('后台摘要变长时保留未完成状态并解释原因，不附加立即重试提示', async () => {
  const h = fixture()
  h.deps.compact = async (_id, side) => {
    if (side === 'background') throw new Error('summary is not smaller than the shadowed content (1931 estimated framed tokens >= 1612)')
    return { message: '前台压缩完成' }
  }
  await h.run({ manual: true })
  const state = h.chat.contextCompaction
  assert.equal(state.operation.status, 'partial')
  assert.equal(state.operation.foreground.status, 'succeeded')
  assert.match(state.warning, /后台：摘要未缩短内容，已保留原始记录/)
  assert.match(state.warning, /无需立即重复压缩/)
  assert.doesNotMatch(state.warning, /请在更多.*重试/)
})

test('new rounds resume automatic compaction after a background failure', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 2 }; await h.run()
  h.round(1); h.round(2); h.fail = 'background'; await h.run()
  await h.run(); assert.equal(h.calls.length, 2)
  h.round(3); await h.run(); assert.equal(h.calls.length, 2)
  h.round(4); h.fail = ''; await h.run()
  assert.deepEqual(h.calls, ['foreground', 'background', 'foreground', 'background'])
})

test('manual retry after new history cannot reuse the old foreground receipt', async () => {
  const h = fixture(); h.round(1); h.fail = 'background'; await h.run({ manual: true })
  h.round(2); h.fail = ''; await h.run({ manual: true })
  assert.deepEqual(h.calls, ['foreground', 'background', 'foreground', 'background'])
})

test('baseline includes only the rounds captured before compaction', async () => {
  const h = fixture(); h.round(1)
  const compact = h.deps.compact
  h.deps.compact = async (...args) => { if (args[1] === 'background') h.round(2); return compact(...args) }
  await h.run({ manual: true })
  assert.deepEqual(h.chat.contextCompaction.baseline, ['1'])
})

test('retry invalidates a successful receipt when its native session grew without a story round', async () => {
  const h = fixture(); h.fail = 'foreground'; await h.run({ manual: true })
  h.fail = ''; h.deps.checkpoint = async id => id === 'back' ? 8 : 7
  await h.run({ manual: true })
  assert.deepEqual(h.calls, ['foreground', 'background', 'foreground', 'background'])
})

test('an unavailable previously successful side does not block retrying the other side', async () => {
  const h = fixture(); h.fail = 'foreground'; await h.run({ manual: true })
  h.fail = ''; h.deps.checkpoint = async id => { if (id === 'back') throw Error('missing background session'); return 7 }
  await h.run({ manual: true })
  assert.equal(h.chat.contextCompaction.operation.foreground.status, 'succeeded')
  assert.equal(h.chat.contextCompaction.operation.background.status, 'failed')
  assert.deepEqual(h.calls, ['foreground', 'background', 'foreground'])
})

test('native foreground protection resets round counting without clearing a background failure', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 2 }; await h.run()
  h.round(1); h.round(2); h.fail = 'background'; await h.run()
  h.round(3)
  await createAutoCompaction(h.deps).recordForeground('front')
  assert.deepEqual(h.chat.contextCompaction.baseline, ['1', '2', '3'])
  assert.equal(h.chat.contextCompaction.operation.background.status, 'failed')
  h.round(4); h.fail = ''; await h.run(); assert.equal(h.calls.length, 2)
  h.round(5); await h.run(); assert.equal(h.calls.length, 4)
})

test('manual request joining an automatic no-op still executes, concurrent clicks share the work', async () => {
  const h = fixture()
  let release
  const gate = new Promise(resolve => { release = resolve })
  h.deps.policy = async () => { await gate; return { mode: 'manual' } }
  const automatic = h.run()
  await new Promise(resolve => setImmediate(resolve))
  const first = h.run({ manual: true }), second = h.run({ manual: true })
  await new Promise(resolve => setImmediate(resolve)); release()
  await automatic
  assert.equal((await first).status, 'completed')
  assert.equal((await second).status, 'completed')
  assert.deepEqual(h.calls, ['foreground', 'background'])
})

test('failed post-compaction measurement does not leave a completed operation blocking the chat', async () => {
  const h = fixture(); h.policy = { mode: 'percent', percent: 80 }
  let measurements = 0
  h.deps.pressure = async () => { if (++measurements > 1) throw Error('meter unavailable'); return { percent: 90 } }
  const result = await h.run()
  assert.equal(result.status, 'completed')
  assert.equal(h.chat.contextCompaction.operation.status, 'completed')
  assert.equal(h.blocked(), false)
  assert.match(h.chat.contextCompaction.warning, /占用.*测量|测量.*占用/)
})

test('manual retry joining an automatic failure suppression still retries the failed side', async () => {
  const h = fixture(); h.policy = { mode: 'rounds', rounds: 1 }; await h.run(); h.round(1)
  h.fail = 'background'; await h.run(); h.fail = ''
  let release
  const gate = new Promise(resolve => { release = resolve })
  h.deps.policy = async () => { await gate; return { mode: 'rounds', rounds: 1 } }
  const automatic = h.run(); await new Promise(resolve => setImmediate(resolve))
  const manual = h.run({ manual: true }); await new Promise(resolve => setImmediate(resolve)); release()
  await automatic; assert.equal((await manual).status, 'completed')
  assert.deepEqual(h.calls, ['foreground', 'background', 'background'])
})

test('cancellation during the final measurement still publishes committed results', async () => {
  const h = fixture(); h.policy = { mode: 'percent', percent: 80 }
  const controller = new AbortController()
  h.deps.pressure = async () => { controller.abort(); controller.signal.throwIfAborted() }
  const result = await h.run({ manual: true, signal: controller.signal })
  assert.equal(result.status, 'completed')
  assert.equal(h.blocked(), false)
  assert.deepEqual(h.calls, ['foreground', 'background'])
})

test('idle automatic checks use detached session metadata without reading full story history',async()=>{
  const h=fixture();let reads=0
  h.deps.readState=async()=>({id:'chat',sessionId:'front',mode:'story',contextCompaction:{}})
  const original=h.deps.readChat;h.deps.readChat=async(...args)=>{reads++;return original(...args)}
  await h.run();await h.run()
  assert.equal(reads,0)
  await h.run({manual:true})
  assert.ok(reads>0,'actual compression must still load authoritative history')
})

test('manual policy bypasses summary history but enabled policies and running recovery retain it',async()=>{
  const h=fixture()
  h.deps.readMetadata=async()=>({id:'chat',sessionId:'front',mode:'story',contextCompaction:h.chat.contextCompaction})
  let reads=0
  const read=h.deps.readState
  h.deps.readState=async(...args)=>{reads++;return read(...args)}
  await h.run()
  assert.equal(reads,0)
  h.policy={mode:'rounds',rounds:2}
  await h.run()
  assert.equal(reads,1)
  await h.run({manual:true})
  assert.ok(reads>1)
  const beforeRecovery=reads
  h.policy={mode:'manual'}
  // Reuse a real operation shape and re-enter durable recovery on the manual policy.
  h.chat.contextCompaction.operation.status='running'
  await h.run()
  assert.ok(reads>beforeRecovery)
})

test('metadata preflight retains the normal persisted policy-error path',async()=>{
 const h=fixture()
 h.deps.readMetadata=async()=>({id:'chat',sessionId:'front',mode:'story'})
 h.policy={mode:'invalid'}
 await assert.rejects(h.run(),/请选择有效的上下文压缩模式/)
 assert.match(h.chat.contextCompaction.warning,/请选择有效的上下文压缩模式/)
})
