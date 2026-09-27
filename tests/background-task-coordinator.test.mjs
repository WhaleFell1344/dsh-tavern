import assert from 'node:assert/strict'
import test from 'node:test'
import { createChatPersistence } from '../tavern-plugin/lib/domain/chat-persistence.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'

import { createBackgroundTaskCoordinator } from '../tavern-plugin/lib/domain/background-task-coordinator.js'

function coordinatorHarness(options = {}) {
  let current = {
    id: 'chat-1', mode: 'story', messages: [], posture: '', candidates: null,
    settleStatus: 'idle', settleError: null
  }
  const writes = []
  let sequence = 0
  const timeline = createStoryTimeline({
    id(prefix) { sequence++; return prefix + '-' + sequence },
    now() { return 1000 + sequence }
  })
  const coordinator = createBackgroundTaskCoordinator({
    timeline,
    blocked: options.blocked,
    store: {
      async readChat() { return current },
      async writeChat(chat) { current = chat; writes.push(chat) },
      async updateChat(_chatId, mutation) {
        const next = await mutation(current)
        if (next !== undefined) current = next
        writes.push(current)
        return current
      }
    }
  })
  return { coordinator, timeline, current: function () { return current }, writes }
}

test('后台任务通过一个 interface 原子开始、重载并提交时间线结果', async () => {
  const harness = coordinatorHarness()
  const task = await harness.coordinator.begin(harness.current(), 'settlement')
  assert.equal(task.participantRequest.role, 'background')
  assert.equal(harness.writes.length, 1)

  const result = await task.commit({
    stateChanged: true,
    participant: task.participant({ traceSessionId: 'background-1', traceBoundary: 42 }),
    apply(draft) { draft.posture = '门边站立。' }
  })

  assert.equal(result.status, 'committed')
  assert.equal(result.chat.posture, '门边站立。')
  assert.equal(harness.writes.length, 2)
  assert.equal(harness.current().timeline.participants.background.sessionId, 'background-1')
})

test('展示刷新插入结算提交时，后台基于最新 Chat 原子保留双方消息差量', async () => {
  let value = {
    id: 'chat-1', mode: 'story',
    messages: [{ role: 'assistant', text: '正文', displayRuntime: null, mvu: { pending: true } }],
    posture: '', candidates: null, settleStatus: 'idle', settleError: null,
    _storageRevision: 1
  }
  let tail = Promise.resolve()
  const persistence = createChatPersistence({
    now: () => 1000,
    data: {
      async readJson() { return structuredClone(value) },
      async updateJson(_path, updater) {
        const current = tail.then(async function () {
          const next = await updater(structuredClone(value))
          if (next !== undefined) value = structuredClone(next)
          return structuredClone(value)
        })
        tail = current.catch(function () {})
        return await current
      },
      async remove() {}
    }
  })
  let injectDisplayRefresh = false
  async function refreshDisplay() {
    await persistence.update('chat-1', function (chat) {
      chat.messages[0].displayRuntime = { dom: '<p>正文</p>' }
      return chat
    }, { source: 'display.capture' })
  }
  const timeline = createStoryTimeline({ id: prefix => prefix + '-1', now: () => 1000 })
  const coordinator = createBackgroundTaskCoordinator({
    timeline,
    store: {
      readChat: chatId => persistence.read(chatId),
      async writeChat(chat, metadata) {
        if (injectDisplayRefresh) {
          injectDisplayRefresh = false
          await refreshDisplay()
        }
        return await persistence.write(chat, metadata)
      },
      async updateChat(chatId, mutation, metadata) {
        if (injectDisplayRefresh) {
          injectDisplayRefresh = false
          await refreshDisplay()
        }
        return await persistence.update(chatId, mutation, metadata)
      }
    }
  })

  const task = await coordinator.begin(await persistence.read('chat-1'), 'settlement')
  injectDisplayRefresh = true
  const result = await task.commit({
    stateChanged: true,
    apply(chat) { chat.messages[0].mvu = { pending: false, modified: true } }
  })

  assert.deepEqual(result.chat.messages[0].displayRuntime, { dom: '<p>正文</p>' })
  assert.deepEqual(result.chat.messages[0].mvu, { pending: false, modified: true })
})

test('Tavern 联合压缩期间不允许启动新的后台任务', async () => {
  const harness = coordinatorHarness({ blocked: () => true })
  await assert.rejects(
    () => harness.coordinator.begin(harness.current(), 'settlement'),
    function (error) { return error && error.code === 'COMPACTION_RUNNING' }
  )
  assert.equal(harness.writes.length, 0)
})

test('同一 Tavern Chat 的后台 operation 严格串行，不会用新任务取消旧任务', async () => {
  const harness = coordinatorHarness()
  const first = await harness.coordinator.begin(harness.current(), 'settlement')

  await assert.rejects(
    harness.coordinator.begin(first.chat, 'candidate'),
    function (error) { return error && error.code === 'BACKGROUND_BUSY' }
  )

  const operations = Object.values(harness.timeline.inspect({ chat: first.chat }).operations)
  assert.equal(operations.length, 1)
  assert.equal(operations[0].status, 'running')
  assert.equal(operations[0].role, 'settlement')
})

test('同一候选请求标识重试时返回原 Operation，不会启动第二个后台任务', async () => {
  const harness = coordinatorHarness()
  const first = await harness.coordinator.begin(harness.current(), 'candidate', { requestId: 'candidate-request-1' })
  const retried = await harness.coordinator.begin(first.chat, 'candidate', { requestId: 'candidate-request-1' })

  assert.equal(retried.operationId, first.operationId)
  assert.equal(first.created, true)
  assert.equal(retried.created, false)
  assert.equal(harness.writes.length, 1)
  assert.equal(Object.values(harness.timeline.inspect({ chat: retried.chat }).operations).length, 1)
})

test('按 Operation ID 查询终态，不会被同一 Chat 的后续任务覆盖', async () => {
  const harness = coordinatorHarness()
  const first = await harness.coordinator.begin(harness.current(), 'candidate')
  const firstCompleted = await first.commit({ stateChanged: false })
  const second = await harness.coordinator.begin(harness.current(), 'candidate')

  assert.equal(harness.coordinator.activity(second.chat).operationId, second.operationId)
  assert.deepEqual(harness.coordinator.operation(second.chat, first.operationId), {
    operationId: first.operationId,
    role: 'candidate',
    requestId: '',
    status: 'completed',
    busy: false,
    terminal: true,
    successful: true,
    basedOn: first.basedOn,
    updatedAt: firstCompleted.chat.timeline.operations[first.operationId].completedAt
  })
})

test('Foreground Turn 提交后直接开放状态结算，不创建世界书 Agent 阶段', async () => {
  const harness = coordinatorHarness()
  const begunBody = harness.timeline.apply({ chat: harness.current(), intent: { kind: 'body.begin', turn: 1, userText: '向前走' } })
  const completedBody = harness.timeline.complete({
    chat: begunBody.chat,
    operationId: begunBody.value.operationId,
    basedOn: begunBody.value.basedOn,
    outcome: { status: 'success' }
  })
  Object.assign(harness.current(), completedBody.chat)

  assert.equal(harness.coordinator.activity(harness.current()).phase, 'pending')
  assert.equal(harness.coordinator.activity(harness.current()).role, 'settlement')
  assert.equal(harness.coordinator.activity(harness.current()).busy, false)
  assert.equal(Object.values(harness.timeline.inspect({ chat: harness.current() }).operations).some(function (operation) { return operation.role === 'worldbook' }), false)

  await assert.rejects(harness.coordinator.begin(harness.current(), 'candidate'), function (error) {
    return error && error.code === 'BACKGROUND_BUSY'
  })

  const settlement = await harness.coordinator.begin(harness.current(), 'settlement')
  const afterSettlement = await settlement.commit({ stateChanged: true })
  assert.equal(harness.coordinator.activity(afterSettlement.chat).phase, 'idle')
  assert.equal(harness.coordinator.activity(afterSettlement.chat).busy, false)
})

test('结算失败后释放后台 Agent，可继续候选任务或重试结算', async () => {
  const harness = coordinatorHarness()
  const body = harness.timeline.apply({ chat: harness.current(), intent: { kind: 'body.begin', turn: 1, userText: '向前走' } })
  const foreground = harness.timeline.complete({
    chat: body.chat,
    operationId: body.value.operationId,
    basedOn: body.value.basedOn,
    outcome: { status: 'success' }
  })
  Object.assign(harness.current(), foreground.chat)
  const settlement = await harness.coordinator.begin(harness.current(), 'settlement')
  await settlement.fail()

  const candidate = await harness.coordinator.begin(harness.current(), 'candidate')
  await candidate.commit()
  await assert.doesNotReject(harness.coordinator.begin(harness.current(), 'settlement'))
})

test('进程重启把遗留 running 结算恢复为可重试失败，不假装仍在执行', async () => {
  const harness = coordinatorHarness()
  const begunBody = harness.timeline.apply({ chat: harness.current(), intent: { kind: 'body.begin', turn: 1, userText: '向前走' } })
  const completedBody = harness.timeline.complete({ chat: begunBody.chat, operationId: begunBody.value.operationId, basedOn: begunBody.value.basedOn, outcome: { status: 'success' } })
  Object.assign(harness.current(), completedBody.chat)
  const settlement = await harness.coordinator.begin(harness.current(), 'settlement')

  const recovered = await harness.coordinator.recover(settlement.chat)

  assert.equal(recovered.activity.phase, 'failed')
  assert.equal(recovered.activity.reason, 'interrupted')
  assert.equal(recovered.activity.busy, false)
  assert.equal(recovered.activity.role, 'settlement')
  const interrupted = Object.values(harness.timeline.inspect({ chat: recovered.chat }).operations).find(function (operation) {
    return operation.kind === 'agent' && operation.role === 'settlement'
  })
  assert.equal(interrupted.status, 'interrupted')
  await harness.coordinator.begin(recovered.chat, 'settlement')
})

test('重启会持久关闭遗留候选 operation，但不会误排结算', async () => {
  const harness = coordinatorHarness()
  const candidate = await harness.coordinator.begin(harness.current(), 'candidate')
  const recovered = await harness.coordinator.recover(candidate.chat)

  assert.equal(recovered.status, 'recovered')
  assert.equal(recovered.activity.busy, false)
  assert.equal(Object.values(harness.current().timeline.operations)[0].status, 'interrupted')
})

test('后台模型失败由 coordinator 关闭 operation，任务 module 只负责上报失败', async () => {
  const harness = coordinatorHarness()
  const task = await harness.coordinator.begin(harness.current(), 'candidate')
  const result = await task.fail({ traceSessionId: 'background-2', traceBoundary: 7 })

  assert.equal(result.status, 'failed')
  assert.equal(harness.writes.length, 2)
  assert.equal(Object.values(harness.current().timeline.operations)[0].status, 'failed')
})

test('运行前保存代理身份，重启恢复后重试复用，但不冒充结算已完成', async () => {
  const h = coordinatorHarness()
  const first = await h.coordinator.begin(h.current(), 'settlement')
  await first.bindSession('background-started')
  assert.notEqual(h.current().timeline.participants.background?.status, 'current')
  await h.coordinator.recover(h.current())
  const retry = await h.coordinator.begin(h.current(), 'settlement')
  assert.equal(retry.participantRequest.sessionId, 'background-started')
})

test('manual interruption unlocks background and rejects late state writes and stale stop requests', async () => {
  const h = coordinatorHarness();
  const task = await h.coordinator.begin(h.current(), 'settlement');
  const stopped = await h.coordinator.recover(h.current(), { operationId: task.operationId });
  assert.equal(stopped.activity.busy, false);
  assert.equal(stopped.activity.reason, 'interrupted');
  const late = await task.commit({ apply(chat) { chat.posture = 'late write'; } });
  assert.equal(late.status, 'stale');
  assert.equal(h.current().posture, '');
  const next = await h.coordinator.begin(h.current(), 'settlement');
  const stale = await h.coordinator.recover(h.current(), { operationId: task.operationId });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.activity.busy, true);
  assert.equal(stale.activity.operationId, next.operationId);
});

test('replacement binding survives stale failure receipts and subsequent retries', async () => {
  const h = coordinatorHarness()
  const seed = await h.coordinator.begin(h.current(), 'settlement')
  await seed.commit({ participant: seed.participant({ sessionId: 'old', boundary: 42 }) })
  const task = await h.coordinator.begin(h.current(), 'settlement')
  await task.bindSession('replacement')
  assert.equal(h.current().timeline.participants.background.sessionId, 'replacement')
  assert.equal(h.current().timeline.participants.background.syncedRevision, null)
  await task.fail({ sessionId: 'old', boundary: 42 })
  assert.equal(h.current().timeline.participants.background.sessionId, 'replacement')
  assert.equal(h.current().timeline.participants.background.boundary, null)
  assert.equal(h.current().timeline.participants.background.syncedRevision, null)
  for (let n = 0; n < 3; n++) {
    const retry = await h.coordinator.begin(h.current(), 'settlement')
    assert.equal(retry.participantRequest.sessionId, 'replacement')
    await retry.bindSession('replacement')
    await retry.fail({ traceSessionId: 'replacement' })
  }
})

test('replacement identity survives interruption before result and recovery', async () => {
  const h = coordinatorHarness()
  const seed = await h.coordinator.begin(h.current(), 'settlement')
  await seed.commit({ participant: seed.participant({ sessionId: 'old', boundary: 42 }) })
  const task = await h.coordinator.begin(h.current(), 'settlement')
  await task.bindSession('replacement')
  await h.coordinator.recover(h.current())
  const retry = await h.coordinator.begin(h.current(), 'settlement')
  assert.equal(retry.participantRequest.sessionId, 'replacement')
  await assert.rejects(task.bindSession('late-old'), /过期/)
  assert.equal(h.current().timeline.participants.background.sessionId, 'replacement')
})

test('failed background rewind retains its boundary through binding and retries', async () => {
  const h = coordinatorHarness()
  const seed = await h.coordinator.begin(h.current(), 'settlement')
  await seed.commit({ participant: seed.participant({ sessionId: 'background', boundary: 19 }) })
  Object.assign(h.current().timeline.participants.background, { status: 'needs-rewind', rewindTo: -1, boundary: -1 })
  for (let i = 0; i < 2; i++) {
    const task = await h.coordinator.begin(h.current(), 'settlement')
    assert.equal(task.participantRequest.rewindTo, -1)
    await task.bindSession('background')
    await task.fail({ sessionId: 'background', boundary: 19 })
    assert.equal(h.current().timeline.participants.background.status, 'needs-rewind')
  }
  const task = await h.coordinator.begin(h.current(), 'settlement')
  assert.equal(task.participantRequest.rewindTo, -1)
  await task.commit({ participant: task.participant({ sessionId: 'background', boundary: 25 }) })
  assert.equal(h.current().timeline.participants.background.status, 'current')
  assert.equal(h.current().timeline.participants.background.rewindTo, null)
})

for (const conflict of [false,true,'cancel']) test(`narrow background mutations preserve concurrent history: ${conflict}`,async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises')
  const {tmpdir}=await import('node:os')
  const {join}=await import('node:path')
  const {createChatJournalStore}=await import('../tavern-plugin/lib/domain/chat-journal-store.js')
  const root=await mkdtemp(join(tmpdir(),'background-patch-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const p=createChatPersistence({store:createChatJournalStore({dataRoot:root})})
  const timeline=createStoryTimeline()
  await p.write(timeline.apply({chat:{id:'c',messages:[{role:'assistant',text:'keep',variables:[{hp:1}]}]},intent:{kind:'ensure'}}).chat)
  let patches=0,updates=0
  const coordinator=createBackgroundTaskCoordinator({timeline,store:{readChat:p.read,writeChat:p.write,
    readState:p.readSessionState,readSlice:p.readSlice,readSettlementCheckpoint:p.readSettlementCheckpoint,
    updateChat:(...args)=>{updates++;return p.update(...args)},
    patchChat:async(...args)=>{
      patches++
      if(conflict)await p.update('c',chat=>{chat.messages[0].text='concurrent';if(conflict==='cancel')Object.values(chat.timeline.operations).forEach(op=>{op.status='cancelled'});return chat})
      return p.patch(...args)
    }}})
  const task=await coordinator.begin(await p.read('c'),'settlement')
  if(conflict==='cancel') {
    await assert.rejects(task.bindSession('background'),/过期/)
    assert.equal((await p.read('c')).timeline.operations[task.operationId].startedSessionId,undefined)
    return
  }
  await task.bindSession('background')
  await task.checkpointMessage(0,(_chat,message)=>{message.mvu={pendingSubmission:[1]}})
  const saved=await p.read('c')
  assert.equal(saved.timeline.operations[task.operationId].startedSessionId,'background')
  assert.deepEqual(saved.messages[0].variables,[{hp:1}])
  assert.equal(saved.messages[0].text,conflict?'concurrent':'keep')
  assert.deepEqual(saved.messages[0].mvu.pendingSubmission,[1])
  assert.equal(patches,2)
  assert.equal(updates,conflict?2:0)
  await task.commit()
  await assert.rejects(task.checkpointMessage(0,(_chat,message)=>{message.text='stale'}),/过期/)
  const restarted=createChatJournalStore({dataRoot:root})
  assert.equal((await restarted.read('c')).messages[0].text,conflict?'concurrent':'keep')
})

test('settlement checkpoint reads only its target and running operation', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createChatJournalStore } = await import('../tavern-plugin/lib/domain/chat-journal-store.js')
  const root = await mkdtemp(join(tmpdir(), 'settlement-scope-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createChatJournalStore({ dataRoot: root })
  const p = createChatPersistence({ store })
  const timeline = createStoryTimeline()
  const chat = timeline.apply({ chat: { id: 'game', sessionId: 's',
    cardDefinitionSnapshot: { description: 'large card'.repeat(10000) },
    messages: Array.from({ length: 459 }, (_, i) => ({ role: 'assistant', turn: i + 1,
      text: 'story', variables: [{ stat_data: { gold: i } }] })) }, intent: { kind: 'ensure' } }).chat
  await p.write(chat)
  const coordinator = createBackgroundTaskCoordinator({ timeline, store: {
    readChat: p.read, writeChat: p.write, updateChat: p.update, patchChat: p.patch,
    readState: p.readSessionState, readSlice: p.readSlice, readSettlementCheckpoint: p.readSettlementCheckpoint
  } })
  const task = await coordinator.begin(await p.read('game'), 'settlement')
  const selected = await p.readSettlementCheckpoint('game', 458, task.operationId)
  assert.equal(selected.chat.messages.length, 1)
  assert.equal(selected.chat.cardDefinitionSnapshot, undefined)
  assert.equal(selected.chat.timeline.checkpoints, undefined)
  assert.deepEqual(Object.keys(selected.chat.timeline.operations), [task.operationId])
  selected.chat.messages[0].variables[0].stat_data.gold = -1
  await task.checkpointMessage(458, (_draft, target) => {
    target.mvuBaseline = { swipeId: 0, variables: target.variables[0] }
    target.mvu = { pending: true, pendingSubmission: { command: 'saved' } }
  })
  const restored = await createChatJournalStore({ dataRoot: root }).read('game')
  assert.equal(restored.messages.length, 459)
  assert.equal(restored.messages[0].variables[0].stat_data.gold, 0)
  assert.equal(restored.messages[458].mvuBaseline.variables.stat_data.gold, 458)
  assert.equal(restored.messages[458].mvu.pendingSubmission.command, 'saved')
  assert.equal(restored.cardDefinitionSnapshot.description, chat.cardDefinitionSnapshot.description)
  await task.commit()
  await assert.rejects(task.checkpointMessage(458, (_draft, target) => { target.text = 'late' }), /过期/)
})

test('idle recovery uses only detached state and active recovery reloads the full Chat', async () => {
  const timeline = createStoryTimeline()
  let chat = timeline.apply({ chat: { id: 'c', messages: [{ role: 'assistant', text: 'preserve' }] }, intent: { kind: 'ensure' } }).chat
  let reads = 0, writes = 0
  const coordinator = createBackgroundTaskCoordinator({ timeline, store: {
    readState: async () => ({ id: 'c', timeline: structuredClone(chat.timeline), messages: [] }),
    readChat: async () => { reads++; return structuredClone(chat) },
    writeChat: async value => { writes++; chat = value }, updateChat: async () => {}
  } })
  assert.equal((await coordinator.recover({ id: 'c' })).status, 'unchanged')
  assert.equal(reads, 0)
  chat = timeline.apply({ chat, intent: { kind: 'agent.begin', role: 'candidate' } }).chat
  await coordinator.recover({ id: 'c' })
  assert.equal(reads, 1); assert.equal(writes, 1)
  assert.equal(chat.messages[0].text, 'preserve')
})

test('session binding can return task state without reloading story history',async()=>{
 const timeline=createStoryTimeline()
 let chat=timeline.apply({chat:{id:'c',messages:[{role:'assistant',text:'keep'}]},intent:{kind:'ensure'}}).chat
 let fullReads=0
 const store={readChat:async()=>{fullReads++;return structuredClone(chat)},writeChat:async value=>{chat=value},updateChat:async(_id,fn)=>{chat=fn(chat);return chat},
  readState:async()=>({...structuredClone(chat),messages:[]}),
  patchChat:async(_id,_revision,changes)=>{for(const change of changes)chat[change.path[0]]=change.value;return chat}}
 const task=await createBackgroundTaskCoordinator({timeline,store}).begin(chat,'settlement')
 fullReads=0
 const state=await task.bindSession('background',{stateOnly:true})
 assert.equal(fullReads,0)
 assert.equal(state.timeline.operations[task.operationId].startedSessionId,'background')
 assert.equal(chat.messages[0].text,'keep')
})

for(const conflict of [false,true])test(`settlement begin reuses an exact snapshot without full reads; conflict=${conflict}`,async()=>{
 const timeline=createStoryTimeline()
 let chat=timeline.apply({chat:{id:'c',_storageRevision:1,messages:[{role:'assistant',text:'keep'}]},intent:{kind:'ensure'}}).chat
 let reads=0,writes=0,patches=0
 const store={readChat:async()=>{reads++;return structuredClone(chat)},writeChat:async value=>{writes++;chat=value},updateChat:async(_id,fn)=>{chat=fn(chat);return chat},
  patchChat:async(_id,revision,changes)=>{
   patches++
   if(conflict){chat._storageRevision++;chat.messages[0].text='concurrent';return undefined}
   assert.equal(revision,chat._storageRevision)
   const {applyJsonChanges}=await import('../tavern-plugin/lib/domain/json-mutation.js')
   chat=applyJsonChanges(chat,changes);chat._storageRevision++
   return {...chat,messages:[]}
  }}
 const task=await createBackgroundTaskCoordinator({timeline,store}).begin(structuredClone(chat),'settlement',{reuseSnapshot:true})
 assert.equal(patches,1)
 assert.equal(reads,conflict?1:0)
 assert.equal(writes,conflict?1:0)
 assert.equal(task.chat.messages[0].text,conflict?'concurrent':'keep')
 assert.equal(task.chat._storageRevision,chat._storageRevision)
 assert.equal(chat.timeline.operations[task.operationId].status,'running')
})

test('native fast begin retains history and checkpoints in storage and the returned snapshot',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {createChatJournalStore}=await import('../tavern-plugin/lib/domain/chat-journal-store.js')
 const root=await mkdtemp(join(tmpdir(),'native-begin-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const p=createChatPersistence({store:createChatJournalStore({dataRoot:root,newConversations:true})}),timeline=createStoryTimeline()
 const original=timeline.apply({chat:{id:'c',sessionId:'s',messages:[{role:'assistant',text:'keep',variables:[{hp:3}]}]},intent:{kind:'ensure'}}).chat
 original.timeline.checkpoints=[{id:'old',before:{messages:[{text:'historic'}]}}]
 await p.write(original)
 let reads=0,writes=0
 const task=await createBackgroundTaskCoordinator({timeline,store:{readChat:async()=>{reads++;throw Error('unexpected full read')},writeChat:async()=>{writes++;throw Error('unexpected full write')},updateChat:p.update,patchChat:p.patch}}).begin(await p.read('c'),'settlement',{reuseSnapshot:true})
 const disk=await p.read('c')
 assert.equal(reads+writes,0)
 assert.deepEqual(disk.messages,original.messages)
 assert.deepEqual(task.chat.messages,disk.messages)
 assert.deepEqual(task.chat.timeline.checkpoints,original.timeline.checkpoints)
 assert.deepEqual(disk.timeline.checkpoints,original.timeline.checkpoints)
 assert.equal(task.chat._storageRevision,disk._storageRevision)
 assert.equal(disk.timeline.operations[task.operationId].status,'running')
})

test('fast begin rechecks busy guards after a concurrent operation wins the CAS',async()=>{
 const timeline=createStoryTimeline()
 let chat=timeline.apply({chat:{id:'c',_storageRevision:1,messages:[]},intent:{kind:'ensure'}}).chat
 let writes=0
 const coordinator=createBackgroundTaskCoordinator({timeline,store:{readChat:async()=>chat,writeChat:async()=>{writes++},updateChat:async()=>{},patchChat:async()=>{
  chat=timeline.apply({chat,intent:{kind:'agent.begin',role:'candidate'}}).chat
  chat._storageRevision++
  return undefined
 }}})
 await assert.rejects(coordinator.begin(structuredClone(chat),'settlement',{reuseSnapshot:true}),/后台 Agent 正在执行/)
 assert.equal(writes,0)
 assert.equal(Object.values(chat.timeline.operations).filter(op=>op.role==='settlement').length,0)
})
