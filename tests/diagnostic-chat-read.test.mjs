import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatJournalStore } from '../tavern-plugin/lib/domain/chat-journal-store.js'
import { sanitizeMvuLoadDiagnostic, sanitizeModuleFailure, redactMvuLoadError } from '../tavern-plugin/lib/domain/mvu-diagnostics.js'

for (const method of ['recordMvuRuntimeDiagnostic', 'recordTavernCompatibilityCalls']) {
  test(`${method} does not clone historical variable snapshots`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'diagnostic-chat-read-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const store = createChatJournalStore({ dataRoot: root })
    await store.update('chat', () => ({ id: 'chat', sessionId: 'canonical', _storageRevision: 1,
      messages: Array.from({ length: 458 }, (_, turn) => ({ role: 'assistant', turn,
        variables: [{ stat_data: { entries: Array.from({ length: 100 }, () => ({ value: 'saved variable' })) } }] })) }))
    const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
    const start = source.indexOf(`case '${method}':`)
    const end = source.indexOf('\n      case ', start + 1)
    const rows = []
    let fullCopies = 0
    const clone = globalThis.structuredClone
    t.mock.method(globalThis, 'structuredClone', value => {
      if (value?.messages?.some(message => message.variables)) fullCopies++
      return clone(value)
    })
    const context = { str: String, sanitizeMvuLoadDiagnostic, sanitizeModuleFailure, redactMvuLoadError,
      chatHeaderForSession: id => id === 'missing' ? undefined : store.readSessionState('chat'),
      chatForSession: id => id === 'missing' ? undefined : store.read('chat'),
      sessionStateForSession: id => id === 'missing' ? undefined : store.readSessionState('chat'),
      mvuDiagnostics: { record: async (...args) => rows.push(args) },
      compatibilityDiagnostics: { record: async (...args) => rows.push(args) } }
    const invoke = vm.runInNewContext(`(async function(args){switch('${method}'){${source.slice(start, end)}}})`, context)
    for (let i = 0; i < 6; i++) {
      assert.equal((await invoke({ sessionId: 'alias', runtimeId: 'runtime', calls: [],
        diagnostic: { kind: 'mvu-load', phase: 'initialization-waiting' } })).recorded, true)
    }
    assert.equal(rows.length, 6)
    assert.ok(rows.every(row => row[0] === 'canonical'))
    await assert.rejects(invoke({ sessionId: 'missing' }), /没有绑定/)
    assert.equal(fullCopies, 0, 'diagnostics must not clone the full chat')
  })
}

test('deferred MVU retries read flags without cloning saved submissions or variables', async t => {
  const { createMvuSettlementReconciler } = await import('../tavern-plugin/lib/domain/mvu-settlement-reconciler.js')
  const { projectChatSessionState, pendingMvuSettlementState } = await import('../tavern-plugin/lib/domain/chat-session-state.js')
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const target = source.slice(source.indexOf('  function pendingMvuTarget('), source.indexOf('  async function mvuUpdateRules('))
  const start = source.indexOf('  const mvuSettlementReconciler = ')
  const end = source.indexOf('  const unsubscribeMvuRuntimeReady', start)
  const chat = { id: 'chat', sessionId: 's', messages: [{ role: 'assistant', mvu: {
    pending: true, pendingSubmission: { command: 'saved' }, delivery: { prepared: false }
  } }] }
  let fullReads = 0, resumes = 0, scheduled
  const reconciler = vm.runInNewContext(`(function(){${target}${source.slice(start, end)}return mvuSettlementReconciler})()`, {
    createMvuSettlementReconciler: options => createMvuSettlementReconciler({ ...options,
      schedule: callback => { scheduled = callback; return 1 }, cancel() {} }),
    conversationRegistry: { list: async () => [{ sessionId: 's' }] },
    chatForSession: async () => { fullReads++; return structuredClone(chat) },
    taskStateReader: { forSession: async () => projectChatSessionState(chat) },
    sessionStateForSession: async () => projectChatSessionState(chat),
    backgroundTasks: { activity: () => ({ phase: 'pending' }) },
    tavernScriptDispatch: { status: () => ({ ready: false }) },
    queueSettlement: async () => { resumes++; chat.messages[0].mvu.pending = false },
    structuredClone, pendingMvuSettlementState, console, str: String
  })
  t.after(() => reconciler.dispose())
  await reconciler.scan()
  assert.equal(resumes, 0)
  assert.equal(typeof scheduled, 'function', 'unready durable work must keep retrying')
  await scheduled()
  chat.messages[0].mvu.delivery.prepared = true
  await scheduled()
  assert.equal(resumes, 1, 'prepared effects can resume without the browser')
  assert.equal(fullReads, 0, 'periodic reconciliation must not copy full history')
})


test('retry flags select the latest pending assistant without copying its payloads', async () => {
  const { projectChatSessionState, pendingMvuSettlementState } = await import('../tavern-plugin/lib/domain/chat-session-state.js')
  const heavy = new Proxy({}, { ownKeys() { throw Error('payload traversed') } })
  const chat = { messages: [
    { role: 'assistant', mvu: { pending: true, pendingSubmission: heavy, delivery: { prepared: heavy } } },
    { role: 'user', mvu: { pending: true } }
  ] }
  assert.deepEqual(pendingMvuSettlementState(chat), { hasSubmission: true, prepared: true })
  assert.deepEqual(projectChatSessionState(chat).pendingMvuSettlement, { hasSubmission: true, prepared: true })
  chat.messages.push({ role: 'assistant', mvu: { pending: true } })
  assert.deepEqual(projectChatSessionState(chat).pendingMvuSettlement, { hasSubmission: false, prepared: false })
  chat.messages.forEach(message => { message.mvu.pending = false })
  assert.equal(projectChatSessionState(chat).pendingMvuSettlement, null)
})

test('background task configuration keeps model overrides without copying archived variables', async t => {
  const { resolveChatBackgroundModel } = await import('../tavern-plugin/lib/domain/background-model-selection.js')
  const { normalizeBackgroundTasks } = await import('../tavern-plugin/lib/domain/tavern-settings.js')
  const root = await mkdtemp(join(tmpdir(), 'background-config-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createChatJournalStore({ dataRoot: root })
  const selection = { provider: 'custom', model: 'background', reasoningEffort: 'high' }
  await store.update('chat', () => ({ id: 'chat', sessionId: 's', _storageRevision: 1,
    backgroundModelSelection: selection, webSearchEnabled: true, cardContextRevision: 7,
    backgroundTasks: { variables: false, posture: false },
    timeline: { participants: { background: { status: 'needs-session' } }, operations: { saved: { payload: 'operation history'.repeat(1000) } } },
    messages: Array.from({ length: 459 }, (_, turn) => ({ role: 'assistant', turn,
      variables: { stat_data: { payload: 'historical state'.repeat(1000) } } })) }))
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const names = ['resolveModelSelection', 'resolveWebSearch', 'resolveBackgroundTasks', 'resolveStablePrefixRevision']
  const options = names.map(name => source.split('\n').find(line => line.trim().startsWith(name + ':'))).join('\n')
  const callbacks = vm.runInNewContext(`({${options}})`, {
    chatForSession: () => store.read('chat'),
    sessionStateForSession: () => store.readSessionState('chat'),
    backgroundConfigForSession: () => store.readBackgroundConfig('chat'),
    backgroundModelSelection: chat => resolveChatBackgroundModel(chat, { provider: 'default', model: 'foreground' }),
    normalizeBackgroundTasks
  })
  let historicalCopies = 0, unrelatedCopies = 0
  const clone = globalThis.structuredClone
  t.mock.method(globalThis, 'structuredClone', value => {
    if (value?.messages?.some(message => message.variables)) historicalCopies++
    if (value?.messages || value?.timeline?.operations) unrelatedCopies++
    return clone(value)
  })
  const input = { sessionId: 's' }
  assert.deepEqual(await callbacks.resolveModelSelection(input), selection)
  assert.equal(await callbacks.resolveWebSearch(input), true)
  assert.equal(await callbacks.resolveStablePrefixRevision(input), 7)
  assert.deepEqual(await callbacks.resolveBackgroundTasks(input), normalizeBackgroundTasks({ variables: false, posture: false }))
  const override = { variables: true }
  assert.equal(await callbacks.resolveBackgroundTasks({ ...input, backgroundTasks: override }), override)
  assert.equal(historicalCopies, 0)
  assert.equal(unrelatedCopies, 0, 'configuration reads must not copy messages or operation history')
  const state = await store.readBackgroundConfig('chat')
  state.backgroundModelSelection.model = 'accidental mutation'
  state.backgroundTasks.variables = true
  assert.deepEqual(await callbacks.resolveModelSelection(input), selection)
  assert.deepEqual(await callbacks.resolveBackgroundTasks(input), normalizeBackgroundTasks({ variables: false, posture: false }))
  assert.equal((await store.read('chat')).messages.length, 459, 'archive remains complete')
})

test('skill visibility and compaction polling preserve settings without cloning full history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'metadata-chat-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = createChatJournalStore({ dataRoot: root })
  const compaction = { phase: 'running', foreground: { status: 'pending' } }
  await store.update('chat', () => ({ id: 'chat', sessionId: 's', mode: 'story',
    disabledWritingSkills: ['disabled'], contextCompaction: compaction,
    messages: Array.from({ length: 459 }, (_, turn) => ({ role: 'assistant', turn,
      variables: [{ stat_data: { payload: 'historical variable'.repeat(1000) } }] })) }))
  const source = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('  async function skillRoleFor(')
  const end = source.indexOf('  let invalidateTavernSkills', start)
  const statusStart = source.indexOf("case 'compactionStatus':")
  const statusEnd = source.indexOf('\n      case ', statusStart + 1)
  let fullCopies = 0
  const clone = globalThis.structuredClone
  t.mock.method(globalThis, 'structuredClone', value => {
    if (value?.messages?.some(message => message.variables)) fullCopies++
    return clone(value)
  })
  const api = vm.runInNewContext(`(function(){${source.slice(start, end)}
    return { skillRoleFor, skillEnabledFor, status: async args => {
      switch ('compactionStatus') { ${source.slice(statusStart, statusEnd)} }
    } } })()`, {
    backgroundConfigForSession: id => id === 's' ? store.readBackgroundConfig('chat') : undefined,
    chatHeaderForSession: id => id === 's' ? store.readSessionState('chat') : undefined,
    chatForSession: id => id === 's' ? store.read('chat') : undefined,
    sessionStateForSession: id => id === 's' ? store.readSessionState('chat') : undefined,
    backgroundAgentRunner: { owns: id => id === 'background', requestContext: () => ({ task: 'variables' }) },
    canonicalTavernSkillName: value => value
  })
  const agent = { session: { id: 's' } }
  for (let i = 0; i < 10; i++) {
    assert.equal(await api.skillRoleFor(agent), 'foreground')
    assert.equal(await api.skillEnabledFor({ name: 'disabled' }, agent), false)
    assert.equal(await api.skillEnabledFor({ name: 'enabled' }, agent), true)
    assert.deepEqual((await api.status({ sessionId: 's' })).state, compaction)
  }
  const detached = (await api.status({ sessionId: 's' })).state
  detached.phase = 'corrupted'
  assert.deepEqual((await api.status({ sessionId: 's' })).state, compaction)
  assert.equal(await api.skillRoleFor({ session: { id: 'background' } }), 'background')
  assert.equal(await api.skillRoleFor({ session: { id: 'missing' } }), null)
  assert.equal((await api.status({ sessionId: 'missing' })).state, null)
  assert.equal(fullCopies, 0, 'enumerating skills and polling compression must not clone variable history')
})
