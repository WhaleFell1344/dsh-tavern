import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { initializationFixture } from './fixtures/conversation-initialization.mjs'

const server = await readFile(new URL('../tavern-plugin/lib/index.js', import.meta.url), 'utf8')

const chats = [{ id: 'compat', sessionId: 'compat-session', requestMode: 'sillytavern' }, { id: 'native', sessionId: 'native-session', requestMode: 'dsh' }]

test('实验分支公开兼容会话并声明兼容能力可用', async () => {
  const start = server.indexOf("case 'listSessions': {")
  const context = { readTavernSettings: async () => ({ trustedCardMode: true }), listTavernSessions: async () => chats }
  vm.runInNewContext('this.list = async () => { switch ("listSessions") {' + server.slice(start, server.indexOf("case 'listMobileCardImports'", start)) + '} };', context)
  const result = await context.list()
  assert.deepEqual(Array.from(result.sessions, chat => chat.id), ['compat', 'native'])
  assert.equal(result.capabilities.compatibilityMode, true)
})

test('实验分支可以创建并重新进入兼容会话', async () => {
  const h = initializationFixture()
  const chat = await h.make().start({ ...h.input, requestMode: 'sillytavern' })
  assert.equal(chat.requestMode, 'sillytavern')
  assert.deepEqual(chat.runtimePresetSnapshot, h.state.preset)
  assert.equal(h.state.presetReads, 1, 'compatibility conversations freeze the same selected preset at creation')
  const before = structuredClone(h.session().events)
  const reopened = await h.make().start({ ...h.input, sessionId: chat.sessionId, requestMode: 'sillytavern' })
  assert.equal(reopened.id, chat.id)
  assert.equal(reopened.requestMode, 'sillytavern')
  assert.deepEqual(h.session().events, before)
})

test('启动恢复包含兼容与普通会话', async () => {
  const calls = []
  const context = {
    recoverRegeneration: async () => {}, str: value => String(value || ''),
    chatPersistence: { readWindow: async id => ({ chat: { ...chats.find(chat => chat.id === id), runtimePresetPath: 'preset' } }) },
    readChat: async id => chats.find(chat => chat.id === id),
    presetLibrary: { migrateChat: async chat => { calls.push(chat.id); return false } },
    syncChatSummary: async () => {},
    foregroundHandoff: { recover: async ids => { context.foreground = ids } },
    candidateTasks: { recover: async ids => { context.background = ids } },
    mvuSettlementReconciler: { scan() { assert.ok(context.foreground); assert.ok(context.background); context.scanned = true } }
  }
  const start = server.indexOf('async function recoverRuntimeHistory(')
  vm.runInNewContext(server.slice(start, server.indexOf('// ---------- 重新生成正文', start)) + '; this.recover = recoverRuntimeHistory;', context)
  await context.recover({ chats })
  assert.deepEqual(calls, ['compat', 'native'])
  assert.deepEqual(Array.from(context.foreground), ['compat', 'native'])
  assert.deepEqual(Array.from(context.background), ['compat', 'native'])
  assert.equal(context.scanned, true)
})
