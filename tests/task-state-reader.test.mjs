import test from 'node:test'
import assert from 'node:assert/strict'
import { createTaskStateReader, taskStateFields } from '../tavern-plugin/lib/domain/task-state-reader.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createBackgroundTaskCoordinator } from '../tavern-plugin/lib/domain/background-task-coordinator.js'
import { createCandidateTasks } from '../tavern-plugin/lib/domain/candidate-tasks.js'

const chat = { id: 'chat', sessionId: 'session', cardPath: 'card', cardName: 'card name', _storageRevision: 9,
  timeline: { schemaVersion: 1, branchId: 'branch', revision: 2, operations: {}, participants: {}, checkpoints: [] },
  candidates: { requestId: 'request', messageId: 'message', operationId: 'candidate', generatedAt: 123 } }
function harness(source = chat) {
  let fullReads = 0
  const headers = () => Object.fromEntries(taskStateFields.filter(key => key in source).map(key => [key, structuredClone(source[key])]))
  const reader = createTaskStateReader({
    readSlice: async (id, indices, fields) => { assert.equal(id, 'chat'); assert.deepEqual(indices, []); assert.equal(fields, taskStateFields); return { chat: headers() } },
    readState: async () => { fullReads++; return source },
    headerForSession: async (id, fields) => { assert.equal(id, 'session'); assert.equal(fields, taskStateFields); return headers() },
    stateForSession: async () => { fullReads++; return source },
  })
  return { reader, fullReads: () => fullReads }
}

test('candidate sync and activity use only header fields while preserving legacy result and timeline status', async () => {
  const source = { ...chat, timeline: { ...chat.timeline, operations: { settlement: { id: 'settlement', kind: 'agent', role: 'settlement', status: 'interrupted', createdAt: 10 } } } }
  Object.defineProperty(source, 'messages', { get() { throw Error('must not read history') } })
  const { reader, fullReads } = harness(source)
  const store = { readChat: async () => { throw Error('must not read full Chat') }, writeChat: async () => {}, updateChat: async () => {} }
  const background = createBackgroundTaskCoordinator({ store, timeline: createStoryTimeline() })
  const tasks = createCandidateTasks({ chats: { read: store.readChat, write: store.writeChat, forSession: store.readChat, readState: reader.read, stateForSession: reader.forSession },
    generator: {}, backgroundTasks: background, sessions: { runtimeGeneration: 'runtime', isLive: () => true, projectionRevision: async () => 3 } })
  const result = await tasks.sync('session', { kind: 'candidate' })
  assert.equal(result.task.status, 'succeeded')
  assert.deepEqual(result.task.result.candidates, chat.candidates)
  assert.equal(result.storageRevision, 9)
  assert.equal(result.activity.phase, 'failed')
  assert.equal(result.activity.reason, 'interrupted')
  assert.equal(fullReads(), 0)
})

test('legacy foreground migration retains full story fallback in both reader routes', async () => {
  const legacy = { ...chat, messages: [{ role: 'assistant', text: 'body' }], timeline: { ...chat.timeline, operations: { old: { kind: 'body', status: 'foreground-completed' } } } }
  const { reader, fullReads } = harness(legacy)
  assert.equal(await reader.read('chat'), legacy)
  assert.equal(await reader.forSession('session'), legacy)
  assert.equal(fullReads(), 2)
})

test('missing slice retains legacy fallback and session header adapter owns alias/adoption', async () => {
  const adopted = { ...chat, backgroundConfigVersion: 1 }
  const reader = createTaskStateReader({ readSlice: async () => undefined, readState: async () => undefined,
    headerForSession: async () => adopted, stateForSession: async () => { throw Error('not needed') } })
  assert.equal(await reader.read('missing'), undefined)
  assert.equal(await reader.forSession('alias'), adopted)
})
