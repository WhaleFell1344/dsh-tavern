import { readSettlementInput } from '../tavern-plugin/lib/domain/settlement-input.js'
import {applyJsonChanges} from '../tavern-plugin/lib/domain/json-mutation.js'
import { createSettlementJobs } from '../tavern-plugin/lib/domain/settlement-jobs.js'
import { createSessionStateView, projectChatSessionState, pendingMvuSettlementState } from '../tavern-plugin/lib/domain/chat-session-state.js'
import { collectMvuHelperContext, createMvuSettlementModule } from '../tavern-plugin/lib/domain/mvu-background-settlement.js'
import { createTavernScriptHostAdapter } from '../tavern-plugin/lib/domain/tavern-script-host-adapter.js'
import { createTavernScriptDispatch } from '../tavern-plugin/lib/domain/tavern-script-dispatch.js'
import { normalizeBackgroundTasks } from '../tavern-plugin/lib/domain/tavern-settings.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createBackgroundTaskCoordinator } from '../tavern-plugin/lib/domain/background-task-coordinator.js'
import { createRoundHistory } from '../tavern-plugin/lib/domain/round-history.js'
import { applyMvuSettlementEffect, createMvuSettlementEffect } from '../tavern-plugin/lib/domain/mvu-settlement-effect.js'
import { createMvuSettlementReconciler } from '../tavern-plugin/lib/domain/mvu-settlement-reconciler.js'
import { LEDGER_SUBMIT_TOOL, LEDGER_RULES, ledgerContext, createLedgerSubmission } from '../tavern-plugin/lib/domain/story-ledger.js'
import { POSTURE_SUBMIT_TOOL, POSTURE_SUBMIT_TOOL_NAME, normalizePostureSubmission } from '../tavern-plugin/lib/domain/posture-submission.js'
import { CHARACTER_DESIGN_READ_TOOL, CHARACTER_DESIGN_SAVE_TOOL } from '../tavern-plugin/lib/domain/character-design-document.js'

const server = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
function section(start, end) {
  const from = server.indexOf(start)
  const to = server.indexOf(end, from)
  assert.ok(from >= 0 && to > from)
  return server.slice(from, to)
}

async function harness({ beginRunning = true, mvu = true } = {}) {
  let current = { backgroundTasks: { posture: true, characterDesign: true, variables: true }, id: 'chat', sessionId: 'session', mode: 'story', messages: [], mvu: { enabled: mvu, owner: mvu ? 'official' : null } }
  let sequence = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + ++sequence, now: () => 1000 + sequence })
  const store = {
    readChat: async () => structuredClone(current),
    writeChat: async chat => { current = structuredClone(chat) },
    updateChat: async (_id, fn) => { current = await fn(structuredClone(current)); return structuredClone(current) }
  }
  const tasks = createBackgroundTaskCoordinator({ timeline, store })
  const body = timeline.apply({ chat: current, intent: { kind: 'body.begin', turn: 2, userText: '开门' } })
  current = timeline.complete({ chat: body.chat, operationId: body.value.operationId, basedOn: body.value.basedOn,
    outcome: { status: 'success' }, apply(chat) {
      chat.messages.push({ role: 'user', text: '开门', turn: 2 },
        { role: 'assistant', text: '门开了', turn: 2, variables: [{ stat_data: { hp: 10 } }], mvu: { pending: true } })
    }
  }).chat
  const running = beginRunning ? await tasks.begin(current, 'settlement') : null
  const sandbox = vm.createContext({
    readSettlementInput, chatPersistence: { readWindow: async () => null }, readOpeningWindow: async () => null,
    taskStateReader: { forSession: async () => projectChatSessionState(await store.readChat()) },
    collectMvuHelperContext, normalizeBackgroundTasks, pendingMvuSettlementState, structuredClone, Date, AbortController, console: { log() {}, error() {} },
    str: value => value == null ? '' : String(value),
    backgroundTasks: tasks, storyTimeline: timeline,
    readChat: store.readChat, chatForSession: store.readChat, writeChat: store.writeChat,
    patchChat: async (_id,revision,changes)=>{
      if(current._storageRevision!==revision)return undefined
      current=applyJsonChanges(current,changes)
      current._storageRevision=(current._storageRevision||0)+1
      current.updatedAt=Date.now()
      return {...structuredClone(current),messages:[]}
    },
    sessionStateForSession: async () => projectChatSessionState(await store.readChat()),
    prepareNextWorldBookContext: async chat => chat, readChatCard: async () => ({}),
    view: async chat => chat, settlementTurn: () => 2,
    projectAgentMessageText: message => message.text, mvuUpdateRules: async () => [],
    readTavernSettings: async () => ({ backgroundTasks: { posture: true, characterDesign: true } }),
    backgroundModelSelection: () => ({}), runtimePrompt: () => '',
    settleUserText: () => '【本轮正文】\n门开了',
    applySettlement: () => ({ postureUpdated: false }), applyMvuSettlementEffect, createMvuSettlementReconciler,
    backgroundAgentRunner: { async run() { throw new Error('backgroundAgentRunner not configured') } },
    characterDesignDocuments: { async execute() { return JSON.stringify({ ok: true }) } },
    CHARACTER_DESIGN_READ_TOOL, CHARACTER_DESIGN_SAVE_TOOL,
    POSTURE_SUBMIT_TOOL, POSTURE_SUBMIT_TOOL_NAME, normalizePostureSubmission,
    LEDGER_SUBMIT_TOOL, LEDGER_RULES, ledgerContext, createLedgerSubmission,
    conversationRegistry: { list: async () => [] }, ctx: { effect() {} },
    mvuSettlement: { settleVariables: async () => ({ receipt: { version: 1, status: 'unchanged', changes: [] } }) }
  })
  sandbox.mvuReceiptsOf = createSessionStateView({activity:chat=>tasks.activity(chat),evidence:()=>({})}).receipts
  vm.runInContext(section('  function pendingMvuTarget(', '  async function mvuUpdateRules('), sandbox)
  vm.runInContext(section('  async function runSettlement(', '  const mvuSettlementReconciler'), sandbox)
  sandbox.settlementJobs = createSettlementJobs({run:(...args)=>sandbox.runSettlement(...args),onSettled:(...args)=>sandbox.onSettlementSettled(...args)})
  vm.runInContext(section('  async function retrySettlement(', '  async function pullBackgroundCycle('), sandbox)
  let onReady
  sandbox.tavernScriptDispatch = { subscribeSettled(fn) { onReady = fn }, status() { return { ready: true } } }
  vm.runInContext(section('  const mvuSettlementReconciler', '  async function retrySettlement'), sandbox)
  const history = createRoundHistory({ chats: { read: store.readChat, forSession: store.readChat, readCard: async () => ({}) },
    sessions: { get: () => undefined }, scripts: {}, timeline, queueSettlement: async () => {}, present() {} })
  return { tasks, timeline, store, running, body, sandbox, history, onReady, reconciler: vm.runInContext('mvuSettlementReconciler', sandbox), get: () => structuredClone(current) }
}

test('普通卡忽略旧人物设计开关，只执行姿势结算', async () => {
  const run = await harness({ beginRunning: false, mvu: false })
  run.sandbox.backgroundAgentRunner.run = async input => {
    assert.deepEqual(Array.from(input.tools, tool => tool.name), [POSTURE_SUBMIT_TOOL_NAME])
    assert.doesNotMatch(input.system, /skill 加载 character-design/)
    await input.onToolCall({ name: POSTURE_SUBMIT_TOOL_NAME, arguments: { posture: '站在门边' } })
    return { text: '', traceSessionId: 'background-settlement', traceBoundary: 4 }
  }

  await run.sandbox.queueSettlement('chat')

  const saved = run.get()
  assert.equal(saved.characterDesignDocument, undefined)
  assert.equal(saved.settleStatus, 'done')
  assert.equal(saved.timeline.operations[run.body.value.operationId].status, 'completed')
})

test('普通卡姿势未提交时 Round 失败，人物设计不能替代姿势结算', async () => {
  const run = await harness({ beginRunning: false, mvu: false })
  run.sandbox.backgroundAgentRunner.run = async () => ({ text: '' })

  await run.sandbox.queueSettlement('chat')

  const saved = run.get()
  assert.equal(saved.characterDesignDocument, undefined)
  assert.equal(saved.settleStatus, 'failed')
  assert.match(saved.settleError, /未调用 posture_submit/)
})

test('人物设计工具失败不阻止当前后台 Agent 继续提交姿势', async () => {
  const run = await harness({ beginRunning: false, mvu: false })
  run.sandbox.backgroundAgentRunner.run = async input => {
    const failed = JSON.parse(await input.onToolCall({ name: 'character_design_save', arguments: {} }))
    assert.equal(failed.ok, false)
    await input.onToolCall({ name: POSTURE_SUBMIT_TOOL_NAME, arguments: { posture: '坐在窗边' } })
    return { text: '', traceSessionId: 'background-settlement', traceBoundary: 5 }
  }
  run.sandbox.characterDesignDocuments.execute = async () => JSON.stringify({ ok: false, retryable: true, error: '人物档案保存失败' })

  await run.sandbox.queueSettlement('chat')

  const saved = run.get()
  assert.equal(saved.settleStatus, 'done')
  assert.equal(saved.timeline.operations[run.body.value.operationId].status, 'completed')
})

test('重启丢失 MVU 回执：显示中断、保留正文变量、可从真实重试入口完成同一 Round', async () => {
  const run = await harness()
  const before = run.get()
  await run.tasks.recover(run.get())
  const recovered = run.get()
  assert.equal(run.tasks.activity(recovered).phase, 'failed')
  assert.deepEqual(recovered.messages, before.messages)
  assert.equal(recovered.timeline.revision, before.timeline.revision)
  assert.equal(run.sandbox.mvuReceiptsOf(recovered)[0].receipt.status, 'interrupted')
  await assert.rejects(run.history.regenerate('chat', '', 'session'), /无法访问 DSH 会话/,
    '中断的旧结算不再阻止重生成，继续访问原生会话')
  let calls = 0
  run.sandbox.mvuSettlement.settleVariables = async () => {
    calls++
    return { receipt: { version: 1, status: 'unchanged', changes: [] } }
  }
  await run.sandbox.retrySettlement('session', 2)
  await run.sandbox.queueSettlement('chat')
  assert.equal(calls, 1)
  assert.equal(run.get().timeline.operations[run.body.value.operationId].status, 'completed')
  assert.equal(run.get().timeline.checkpoints.length, 1)
  assert.equal(run.sandbox.mvuReceiptsOf(run.get())[0].receipt.status, 'unchanged')
  assert.equal(run.get().messages[1].text, before.messages[1].text)
  assert.deepEqual(run.get().messages[1].variables, before.messages[1].variables)
  await assert.rejects(run.history.regenerate('chat', '', 'session'), /无法访问 DSH 会话/, '结算完成后已通过保护，继续访问原生会话')
})

test('变量 effect 与 receipt 提交时不重复推进正文 checkpoint 和 revision', async () => {
  const run = await harness({ beginRunning: false })
  const commits = []
  const originalUpdate = run.store.updateChat
  run.store.updateChat = async function (...args) {
    const saved = await originalUpdate(...args)
    commits.push({ source: args[2]?.source, chat: structuredClone(saved) })
    return saved
  }
  run.sandbox.mvuSettlement.settleVariables = async input => {
    const before = run.get()
    const after = structuredClone(before)
    after.messages[1].variables[0].stat_data.hp = 9
    return {
      effect: createMvuSettlementEffect({
        operationId: input.operationId,
        chatId: before.id, sessionId: before.sessionId,
        branchId: input.branchId, basedOnRevision: input.basedOnRevision,
        expectedLifecycleRevision: 0, messageId: 1, swipeId: 0,
        before, after
      }),
      receipt: { version: 1, status: 'updated', changes: [{ path: '/hp', before: 10, after: 9 }] }
    }
  }

  await run.sandbox.queueSettlement('chat')

  const saved = run.get()
  assert.equal(commits.filter(row => row.source === 'background.settlement.commit').length, 1)
  for (const { chat } of commits) {
    assert.equal(chat.timeline.revision, 1)
    assert.equal(chat.timeline.checkpoints.length, 1)
  }
  assert.equal(saved.messages[1].variables[0].stat_data.hp, 9)
  assert.equal(saved.messages[1].mvu.receipt.status, 'updated')
  assert.equal(saved.timeline.operations[run.body.value.operationId].status, 'completed')
  assert.equal(saved.timeline.revision, 1)
  assert.equal(saved.timeline.checkpoints.length, 1)
})

test('旧版已恢复成 pending 但没有待执行提交的存档也能恢复，重复恢复幂等', async () => {
  const run = await harness()
  const legacy = run.get()
  legacy.timeline.operations[run.running.operationId].status = 'interrupted'
  legacy.timeline.operations[run.body.value.operationId].background.phase = 'pending'
  await run.store.writeChat(legacy)
  await run.tasks.recover(legacy)
  assert.equal(run.sandbox.mvuReceiptsOf(run.get())[0].receipt.status, 'interrupted')
  const again = await run.tasks.recover(run.get())
  assert.equal(again.status, 'unchanged')
})

test('已安全挂起且保存了提交的任务仍等待执行器，不误报中断', async () => {
  const run = await harness()
  await run.running.defer({ apply(chat) { chat.messages[1].mvu.pendingSubmission = { operations: [] } } })
  await run.tasks.recover(run.get())
  assert.equal(run.tasks.activity(run.get()).phase, 'pending')
  assert.equal(run.sandbox.mvuReceiptsOf(run.get())[0].receipt.status, 'pending')
  let resumed = 0
  run.sandbox.mvuSettlement.resumeVariables = async () => {
    resumed++
    return { receipt: { version: 1, status: 'unchanged', changes: [] } }
  }
  run.onReady('session')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resumed, 1)
  assert.equal(run.tasks.activity(run.get()).phase, 'idle')
})

test('执行中断即使留有旧提交也不会在浏览器就绪时自动重放', async () => {
  const run = await harness()
  const chat = run.get()
  chat.messages[1].mvu.pendingSubmission = { operations: [{ op: 'delta', path: '/hp', value: -1 }] }
  await run.store.writeChat(chat)
  await run.tasks.recover(chat)
  let queued = 0
  run.sandbox.queueSettlement = async () => { queued++ }
  run.onReady('session')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(queued, 0)
  assert.equal(run.tasks.activity(run.get()).reason, 'interrupted')
})

test('MVU 已加载失败直接结束，不永久等待或重开模型', async () => {
  const run = await harness()
  await run.tasks.recover(run.get())
  let generated = 0, resumed = 0
  run.sandbox.tavernScriptDispatch.status = () => ({ ready: false, initializationError: 'MVU 模块加载失败：bundle.js' })
  run.sandbox.mvuSettlement.settleVariables = async () => {
    generated++
    return { submission: { operations: [] }, receipt: { status: 'pending', changes: [] } }
  }
  run.sandbox.mvuSettlement.resumeVariables = async () => {
    resumed++
    return { receipt: { status: 'error', failures: [{ message: 'MVU 模块加载失败：bundle.js' }] } }
  }
  await run.sandbox.retrySettlement('session', 2)
  await run.sandbox.queueSettlement('chat')
  assert.equal(generated, 1)
  assert.equal(resumed, 0)
  assert.equal(run.tasks.activity(run.get()).phase, 'failed')
  assert.match(run.get().settleError, /MVU 模块加载失败/)
  assert.equal(run.get().timeline.checkpoints.length, 1)
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 10)
})

test('MVU 执行超时保留已提交正文 checkpoint，仍能重试结算', async () => {
  const run = await harness()
  await run.tasks.recover(run.get())
  run.sandbox.mvuSettlement.settleVariables = async () => ({
    receipt: { status: 'error', summary: 'MVU 脚本执行回执超时', failures: [{ message: '回执超时' }] }
  })
  await run.sandbox.retrySettlement('session', 2)
  await run.sandbox.queueSettlement('chat')
  assert.equal(run.tasks.activity(run.get()).phase, 'failed')
  assert.equal(run.get().timeline.checkpoints.length, 1)
  assert.equal(run.get().timeline.operations[run.body.value.operationId].status, 'completed')
  assert.equal(run.sandbox.mvuReceiptsOf(run.get())[0].receipt.status, 'error')
})


test('普通卡全部自动任务关闭时不请求模型，仍完成原生结算', async () => {
  const run = await harness({ beginRunning: false, mvu: false })
  await run.store.updateChat('chat', chat => ({ ...chat, backgroundTasks: { posture: false, characterDesign: false } }))
  run.sandbox.backgroundModelSelection = () => { throw new Error('关闭后不应选择模型') }
  await run.sandbox.queueSettlement('chat')
  assert.equal(run.get().settleStatus, 'done')
  assert.equal(run.get().timeline.operations[run.body.value.operationId].status, 'completed')
})

test('旧设置只开人物设计时不再自动请求后台模型', async () => {
  const run = await harness({ beginRunning: false, mvu: false })
  await run.store.updateChat('chat', chat => ({ ...chat, backgroundTasks: { posture: false, characterDesign: true } }))
  let calls = 0
  run.sandbox.backgroundAgentRunner.run = async () => { calls++; return { text: '' } }
  await run.sandbox.queueSettlement('chat')
  assert.equal(calls, 0)
  assert.equal(run.get().settleStatus, 'done')
})

test('MVU 变量关闭后跳过本轮且不留待重放，姿势仍可独立结算', async () => {
  const run = await harness({ beginRunning: false, mvu: true })
  await run.store.updateChat('chat', chat => ({ ...chat, backgroundTasks: { posture: true, characterDesign: false, variables: false } }))
  run.sandbox.mvuSettlement.settleVariables = async () => { throw new Error('不应派发变量结算') }
  let calls = 0
  run.sandbox.backgroundAgentRunner.run = async input => {
    calls++
    assert.deepEqual(Array.from(input.tools, tool => tool.name), [POSTURE_SUBMIT_TOOL_NAME])
    await input.onToolCall({ name: POSTURE_SUBMIT_TOOL_NAME, arguments: { posture: '门边站立' } })
    return { text: '', traceSessionId: 'background' }
  }
  await run.sandbox.queueSettlement('chat')
  const saved = run.get()
  assert.equal(calls, 1)
  assert.equal(saved.settleStatus, 'done')
  assert.equal(saved.messages.at(-1).mvu.pending, false)
  assert.equal(saved.messages.at(-1).mvu.receipt.status, 'skipped')
  assert.equal(run.sandbox.pendingMvuTarget(saved), null)
})

test('MVU 三项全关不会发起任何后台模型请求', async () => {
  const run = await harness({ beginRunning: false, mvu: true })
  await run.store.updateChat('chat', chat => ({ ...chat, backgroundTasks: { posture: false, characterDesign: false, variables: false } }))
  run.sandbox.mvuSettlement.settleVariables = async () => { throw new Error('不应派发变量结算') }
  run.sandbox.backgroundModelSelection = () => { throw new Error('不应选择模型') }
  await run.sandbox.queueSettlement('chat')
  assert.equal(run.get().settleStatus, 'done')
  assert.equal(run.get().messages.at(-1).mvu.receipt.status, 'skipped')
})

test('non-MVU settlement binds session before first response so interruption can reuse it', async () => {
  const h = await harness({ beginRunning: false, mvu: false });
  let bound = false;
  h.sandbox.backgroundAgentRunner.run = async input => {
    await input.onPersistentSessionReady('background-first-interrupted');
    bound = true;
    throw new Error('first request interrupted before response');
  };
  await h.sandbox.queueSettlement('chat');
  assert.equal(bound, true);
  const restarted = createBackgroundTaskCoordinator({ timeline: h.timeline, store: h.store });
  const next = await restarted.begin(h.get(), 'candidate');
  assert.equal(next.participantRequest.sessionId, 'background-first-interrupted');
});


test('已有游戏读取本局联网开关，忽略全局变化', async () => {
  const stored = { id: 'chat', mode: 'story', webSearchEnabled: false }
  let enabled = false
  const sandbox = vm.createContext({
    chatPersistence: { read: async () => structuredClone(stored) },
    readTavernSettings: async () => ({ webSearchEnabled: enabled })
  })
  vm.runInContext(section('  async function readChat(chatId)', '  async function readChatRevision'), sandbox)
  assert.equal((await sandbox.readChat('chat')).webSearchEnabled, false)
  enabled = true
  assert.equal((await sandbox.readChat('chat')).webSearchEnabled, false)
  enabled = false
  assert.equal((await sandbox.readChat('chat')).webSearchEnabled, false)
  assert.equal(stored.webSearchEnabled, false)
})


test('成功后带意见重新结算：复用原始快照，只更新变量，失败保留上次结果', async () => {
  const run = await harness({ beginRunning: false })
  let calls = 0
  run.sandbox.mvuSettlement.settleVariables = async input => {
    calls++
    assert.equal(input.currentVariables.stat_data.hp, 10)
    if (calls > 1) {
      assert.equal(input.guidance, '只扣一点生命')
      assert.equal(input.backgroundTasks.posture, false)
      assert.equal(input.backgroundTasks.characterDesign, false)
      assert.equal(run.get().messages[1].variables[0].stat_data.hp, 7)
      if (calls === 2) throw new Error('模拟模型失败')
    }
    return { receipt: { version: 1, status: 'updated', changes: [] }, effect: {
      version: 1, operationId: input.operationId, chatId: input.chatId, sessionId: input.sessionId,
      branchId: input.branchId, basedOnRevision: input.basedOnRevision,
      expectedLifecycleRevision: input.expectedLifecycleRevision, messageId: 1, swipeId: 0,
      changes: [{ op: 'set', path: ['messages', 1, 'variables', 0, 'stat_data', 'hp'], value: calls === 1 ? 7 : 9 }]
    } }
  }
  await run.sandbox.queueSettlement('chat')
  assert.equal(run.get().messages[1].mvuBaseline.variables.stat_data.hp, 10)
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 7)
  await run.sandbox.retrySettlement('session', 2, '只扣一点生命')
  await run.sandbox.queueSettlement('chat')
  assert.equal(calls, 2)
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 7)
  assert.equal(run.get().messages[1].text, '门开了')
  assert.equal(run.get().settleStatus, 'failed')
  await run.sandbox.retrySettlement('session', 2, '只扣一点生命')
  await run.sandbox.queueSettlement('chat')
  assert.equal(calls, 3)
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 9)
  assert.equal(run.get().messages[1].mvuBaseline.variables.stat_data.hp, 10)
  assert.equal(run.get().messages[1].text, '门开了')
  assert.equal(run.get().settleStatus, 'done')
  await assert.rejects(run.sandbox.retrySettlement('session', 1), /只能重试当前最新正文/)
})

test('MVU 执行器失联保留持久任务，恢复后自动续办且不重开模型', async () => {
  const run = await harness({ beginRunning: false })
  const before = run.get().messages[1]
  let generated = 0, resumed = 0
  run.sandbox.tavernScriptDispatch.status = () => ({ ready: false })
  run.sandbox.mvuSettlement.settleVariables = async input => {
    generated++
    const submission = { operations: [] }
    await input.onSubmission(submission)
    return { submission, receipt: { status: 'pending', changes: [] } }
  }
  await run.sandbox.queueSettlement('chat')
  const pending = run.get()
  assert.equal(pending.settleStatus, 'pending')
  assert.equal(pending.messages[1].mvu.pending, true)
  assert.equal(pending.messages[1].text, before.text)
  assert.deepEqual(pending.messages[1].variables, before.variables)
  assert.equal(run.tasks.activity(pending).phase, 'pending')
  assert.equal(pending.messages[1].mvu.delivery.version, 1)
  run.sandbox.mvuSettlement.resumeVariables = async () => { resumed++; return { receipt: { status: 'unchanged', changes: [] } } }
  // Complete the independent onSettled offline check before reconnecting.
  await new Promise(resolve => setImmediate(resolve))
  run.sandbox.tavernScriptDispatch.status = () => ({ ready: true })
  await run.reconciler.wake('session')
  assert.equal(run.get().settleStatus, 'done')
  assert.equal(generated, 1)
  assert.equal(resumed, 1)
  assert.equal(run.get().messages[1].mvu.delivery, undefined)
})

test('旧版安全挂起任务离线时保留提交，不丢弃为失败', async () => {
  const run = await harness()
  await run.running.defer({ apply(chat) { chat.messages[1].mvu.pendingSubmission = { operations: [] } } })
  run.sandbox.tavernScriptDispatch.status = () => ({ ready: false })
  let resumed = 0
  run.sandbox.mvuSettlement.resumeVariables = async () => { resumed++; return { receipt: { status: 'pending', changes: [] } } }
  await run.reconciler.wake('session')
  assert.equal(resumed, 0)
  assert.equal(run.get().messages[1].mvu.pending, true)
  assert.deepEqual(run.get().messages[1].mvu.pendingSubmission, { operations: [] })
})

for (const prepared of [false, true]) test(`进程在${prepared ? '结果保存后' : '任务保存后'}退出，重启自动完成同一变量提交`, async () => {
  const run = await harness({ beginRunning: false })
  let release, saved
  const wait = new Promise(resolve => { release = resolve })
  const checkpoint = new Promise(resolve => { saved = resolve })
  let generated = 0, executions = 0
  const resultFor = input => {
    const before = run.get(), after = structuredClone(before)
    after.messages[1].variables[0].stat_data.hp = 9
    return { submission: { operations: [{ op: 'delta', path: '/hp', value: -1 }] },
      effect: createMvuSettlementEffect({ ...input, before, after }),
      receipt: { status: 'updated', changes: [] } }
  }
  run.sandbox.mvuSettlement.settleVariables = async input => {
    generated++
    const result = resultFor(input)
    await input.onSubmission(result.submission)
    if (prepared) { executions++; await input.onPrepared(result) }
    saved(); await wait
    return result
  }
  const abandoned = run.sandbox.queueSettlement('chat')
  await checkpoint
  const persisted = run.get()
  assert.equal(persisted.messages[1].variables[0].stat_data.hp, 10)
  assert.equal(persisted.messages[1].mvu.delivery.version, 1)
  await run.tasks.recover(persisted)
  assert.equal(run.tasks.activity(run.get()).phase, 'pending')
  run.sandbox.settlementJobs.dispose()
  run.sandbox.settlementJobs = createSettlementJobs({run:(...args)=>run.sandbox.runSettlement(...args),onSettled:(...args)=>run.sandbox.onSettlementSettled(...args)})
  run.sandbox.mvuSettlement.resumeVariables = async input => { executions++; return resultFor(input) }
  await run.sandbox.queueSettlement('chat')
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 9)
  assert.equal(run.get().messages[1].mvu.pending, false)
  assert.equal(generated, 1)
  assert.equal(executions, 1)
  release(); await abandoned
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 9, 'abandoned worker cannot commit twice')
})

 test('用户停止持久任务后不自动接续', async () => {
  const run = await harness()
  await run.running.checkpoint(chat => {
    chat.messages[1].mvu.pendingSubmission = { operations: [] }
    chat.messages[1].mvu.delivery = { version: 1, operationId: run.running.operationId,
      branchId: run.running.basedOn.branchId, revision: run.running.basedOn.revision, lifecycleRevision: 0 }
  })
  await run.tasks.recover(run.get(), { operationId: run.running.operationId })
  assert.equal(run.tasks.activity(run.get()).phase, 'failed')
  let resumed = 0
  run.sandbox.mvuSettlement.resumeVariables = async () => { resumed++ }
  await run.reconciler.wake('session')
  assert.equal(resumed, 0)
})

test('手动重新投递保留待提交操作与投递记录，不重新生成变量计划', async () => {
  const run = await harness()
  await run.running.defer({ apply(chat) {
    chat.messages[1].mvu = {
      pending: true, pendingSubmission: { operations: [{ op: 'delta', path: '/hp', value: -1 }] },
      delivery: { version: 1, marker: 'preserved' }, receipt: { status: 'pending' }
    }
  } })
  const before = structuredClone(run.get())
  let queued = 0
  run.sandbox.queueSettlement = async id => { assert.equal(id, 'chat'); queued++ }
  await run.sandbox.retrySettlement('session', 2)
  assert.equal(queued, 1)
  assert.deepEqual(run.get(), before)
  await assert.rejects(run.sandbox.retrySettlement('session', 2, '重新生成计划'), /等待.*重新投递|指导意见/)
  run.reconciler.dispose()
})

for (const recovery of ['自动恢复', '手动重新投递']) test('正式模型工具、调度器、草稿与剧情提交链路：漏领后' + recovery + '完成 delta 一次', async () => {
  const run = await harness({ beginRunning: false })
  const gate = createTavernScriptDispatch({ claimTimeoutMs: 100 })
  const adapter = createTavernScriptHostAdapter({ resolveChat: run.store.readChat, writeChat: run.store.writeChat,
    readCard: async () => ({}), worldBooks: { bound: async () => null }, scriptDispatch: gate })
  let models = 0
  run.sandbox.tavernScriptDispatch.status = gate.status
  run.sandbox.mvuSettlement = createMvuSettlementModule({ runtime: adapter, model: { async run(input) {
    models++
    await input.onToolCall({ name: 'posture_submit', arguments: { posture: '门边' } })
    await input.onToolCall({ name: 'mvu_submit_update', arguments: { operations: [{ op: 'delta', path: '/hp', value: -1 }] } })
    return {}
  } } })
  gate.claim('session', 'browser', true)
  // Deliberately deliver no notification and no claim for the first attempt.
  await run.sandbox.queueSettlement('chat')
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 10)
  assert.equal(run.get().messages[1].mvu.pendingSubmission.operations[0].value, -1)
  assert.equal(run.tasks.activity(run.get()).phase, 'pending')
  assert.equal(run.get().messages[1].mvu.receipt.deferredReason, 'claim-timeout')
  // onSettled starts its own reconciliation check after the model job resolves.
  await new Promise(resolve => setImmediate(resolve))
  gate.claim('session', 'browser', true)
  if (recovery === '手动重新投递') await run.sandbox.retrySettlement('session', 2)
  const resumed = recovery === '自动恢复'
    ? run.reconciler.wake('session')
    : run.sandbox.queueSettlement('chat') // Coalesce a concurrent delivery request.
  let offer
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setImmediate(resolve))
    offer = gate.claim('session', 'browser', true)
    if (offer.event) break
  }
  assert.ok(offer.event)
  assert.equal(gate.start('session', offer.event.id, offer.leaseToken, 'browser').started, true)
  await adapter.updateMessages('session', [{ message_id: 1, data: { stat_data: { hp: 9 } } }], 0, offer.event.id)
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 10, 'script writes remain isolated')
  assert.equal(gate.complete('session', offer.event.id, [1], 'browser', offer.leaseToken), true)
  await resumed
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 9)
  assert.equal(run.get().settleStatus, 'done')
  assert.equal(models, 1)
  assert.equal(gate.complete('session', offer.event.id, [1], 'browser', offer.leaseToken), true, 'duplicate receipt acknowledges the original execution without committing twice')
  await assert.rejects(adapter.updateMessages('session', [{ message_id: 1, data: { stat_data: { hp: 8 } } }], 0, offer.event.id), { code: 'MVU_SETTLEMENT_EVENT_MISMATCH' })
  assert.equal(run.get().messages[1].variables[0].stat_data.hp, 9)
  run.reconciler.dispose()
})

test('接续刚创建新 operation 再次崩溃，仍能从原持久任务恢复', async () => {
  const run = await harness()
  await run.running.checkpoint(chat => {
    chat.messages[1].mvu.pendingSubmission = { operations: [] }
    chat.messages[1].mvu.delivery = { version: 1, operationId: run.running.operationId,
      branchId: run.running.basedOn.branchId, revision: run.running.basedOn.revision, lifecycleRevision: 0, swipeId: 0 }
  })
  await run.tasks.recover(run.get())
  const resumed = await run.tasks.begin(run.get(), 'settlement')
  assert.notEqual(resumed.operationId, run.running.operationId)
  await run.tasks.recover(run.get())
  assert.equal(run.tasks.activity(run.get()).phase, 'pending')
  const target = run.get()
  target.tavernHelperLifecycleRevision = 1
  await run.store.writeChat(target)
  await run.tasks.begin(run.get(), 'settlement')
  await run.tasks.recover(run.get())
  assert.equal(run.tasks.activity(run.get()).phase, 'failed', 'changed target cannot reuse the old task')
})

test('等待执行器的任务可从正式停止入口取消，重连不重启', async () => {
  const run = await harness()
  await run.running.defer({ apply(chat) { chat.messages[1].mvu.pendingSubmission = { operations: [] } } })
  run.sandbox.backgroundAgentRunner.cancel = () => {}
  const activity = run.tasks.activity(run.get())
  await run.sandbox.stopBackground('session', activity.operationId)
  assert.equal(run.tasks.activity(run.get()).phase, 'failed')
  let resumes = 0
  run.sandbox.mvuSettlement.resumeVariables = async () => { resumes++ }
  await run.reconciler.wake('session')
  assert.equal(resumes, 0)
})

test('正式结算入口将当前正文之前的建角 Helper 消息交给 MVU', async () => {
  const run = await harness({ beginRunning: false })
  const setup = '第一轮变量更新要求：根据已写入属性初始化生命值。'
  await run.store.updateChat('chat', chat => {
    chat.messages.unshift({ role: 'tavern-helper', text: setup })
    return chat
  })
  let received
  run.sandbox.mvuSettlement.settleVariables = async input => {
    received = input.helperContext
    return { receipt: { version: 1, status: 'unchanged', changes: [] } }
  }
  await run.sandbox.queueSettlement('chat')
  assert.deepEqual(received, [setup])
  assert.equal(run.get().settleStatus, 'done')
})

for (const stage of ['read', 'prepare']) test(`销毁期间结束的 ${stage} 不能再启动后台结算`, async () => {
  const run = await harness({ beginRunning: false })
  let release, entered
  const held = new Promise(resolve => { release = resolve })
  const reading = new Promise(resolve => { entered = resolve })
  run.sandbox[stage === 'read' ? 'readChat' : 'prepareNextWorldBookContext'] = async () => {
    const snapshot = await run.store.readChat()
    entered(); await held; return snapshot
  }
  let begins = 0
  const begin = run.tasks.begin
  run.sandbox.backgroundTasks = { ...run.tasks, begin: (...args) => { begins++; return begin(...args) } }
  const pending = run.sandbox.queueSettlement('chat')
  await reading
  run.sandbox.settlementJobs.dispose()
  release()
  await pending.catch(error => { assert.equal(error.name, 'AbortError') })
  assert.equal(begins, 0)
  run.reconciler.dispose()
})

for(const storyChanged of [false,true])test(`retry CAS revalidates concurrent ${storyChanged?'body change':'display backfill'}`,async()=>{
 const run=await harness({beginRunning:false})
 const chat=run.get()
 chat._storageRevision=1
 await run.store.writeChat(chat)
 let attempts=0,queued=0
 const patch=run.sandbox.patchChat
 run.sandbox.patchChat=async(...args)=>{
  if(++attempts===1){
   await run.store.updateChat('chat',current=>{
    current._storageRevision++
    current.messages[0].tavernPluginData={template_rendered:true}
    if(storyChanged)current.messages[1].turn=3
    return current
   })
  }
  return patch(...args)
 }
 run.sandbox.queueSettlement=async()=>{queued++}
 if(storyChanged){
  await assert.rejects(run.sandbox.retrySettlement('session',2),/只能重试当前最新正文/)
  assert.equal(queued,0)
 }else{
  await run.sandbox.retrySettlement('session',2)
  assert.equal(attempts,2);assert.equal(queued,1)
  assert.equal(run.get().messages[0].tavernPluginData.template_rendered,true)
  assert.equal(run.get().messages[1].mvu.variableRetry,true)
 }
})
