import assert from 'node:assert/strict'
import test from 'node:test'

import { createCandidateGenerator } from '../tavern-plugin/lib/domain/candidate-generation.js'
import { createScriptContinuity } from '../tavern-plugin/lib/domain/script-continuity.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { prompt } from '../tavern-plugin/lib/prompt-catalog.js'

const storyChoices = [
  { type: 'action', text: '走到窗边仔细观察街上的动静' },
  { type: 'action', text: '压低声音询问阿芙拉钟楼的线索' },
  { type: 'action', text: '检查桌上残留的泥水和脚印痕迹' },
  { type: 'action', text: '推开后门沿着雨中的马蹄印追踪' },
  { type: 'scene', text: '场景切换到午夜钟楼下的狭窄石巷' }
]

function script() {
  return {
    title: '银铃', importedAt: 1,
    chunks: [
      { id: 'chunk-00001', order: 0, text: '旅店相遇。' },
      { id: 'chunk-00002', order: 1, text: '雨夜追踪。' },
      { id: 'chunk-00003', order: 2, text: '钟楼对峙。' }
    ]
  }
}

function harness({ mode = 'story', outputs, initialCandidates, initialCandidateAgent, initialSettleStatus, messages, initialScriptCursor = 0, initialScriptEnded = false, scriptData, cardData, macroState, waitUntilSettled, writeChatHook, modelSelection, planHook, worldBookContext }) {
  const continuity = createScriptContinuity()
  const activeScript = scriptData || script()
  let scriptState = mode === 'script' ? continuity.start(activeScript, initialScriptCursor) : null
  if (initialScriptEnded) scriptState = continuity.transition({ script: activeScript, state: scriptState, event: { kind: 'end' } }).state
  let chat = {
    id: 'chat-1', cardId: 'card-1', mode, messages: messages || [{ role: 'assistant', text: '雨水敲着窗。' }],
    scriptState,
    settleStatus: initialSettleStatus || 'idle',
    macroState: macroState || { userName: 'User', local: {}, global: {} }
  }
  if (initialCandidates !== undefined) chat.candidates = structuredClone(initialCandidates)
  if (initialCandidateAgent !== undefined) chat.candidateAgent = structuredClone(initialCandidateAgent)
  const card = cardData || { id: 'card-1', name: '阿芙拉', description: '银发佣兵', tags: [] }
  let modelCalls = 0
  const modelRequests = []
  function remember(options) {
    modelRequests.push({
      preparedWorldbook: options.preparedWorldbook,
      system: options.system,
      backgroundContext: options.backgroundContext,
      systemPromptText: options.systemPromptText,
      postHistoryText: options.postHistoryText,
      turnContext: options.turnContext,
      messages: structuredClone(options.messages),
      tools: structuredClone(options.tools || []),
      maxTokens: options.maxTokens,
      persistent: options.persistent,
      persistentSessionId: options.persistentSessionId,
      rewindTo: Number.isSafeInteger(options.rewindTo) ? options.rewindTo : null,
      webSearchEnabled: options.webSearchEnabled === true
    })
  }
  async function nextOutput(options) {
    remember(options)
    const call = ++modelCalls
    const output = outputs[Math.min(call - 1, outputs.length - 1)]
    const text = typeof output === 'function' ? await output(options) : output
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed.choices)) {
        await options.onToolCall({
          name: 'candidate_submit_choices',
          arguments: {
            actions: parsed.choices.filter(item => item && item.type === 'action').map(item => item.text),
            scene: parsed.choices.find(item => item && item.type === 'scene')?.text || ''
          }
        })
      }
    } catch (_error) {}
    return { text, traceSessionId: options.persistentSessionId || 'candidate-trace-' + call }
  }
  const store = {
    async chatForSession() { return structuredClone(chat) },
    async readChat() { return structuredClone(chat) },
    async readCard(_path, snapshot) { assert.equal(snapshot.id, chat.id, 'candidate preparation reuses the current chat resource snapshot'); return structuredClone(card) },
    async readScript() { return mode === 'script' ? structuredClone(activeScript) : undefined },
    async writeChat(next) {
      if (typeof writeChatHook === 'function') await writeChatHook(next, chat)
      chat = structuredClone(next)
    },
    async updateChat(_id, update) {
      const next = await update(structuredClone(chat))
      if (next !== undefined) {
        if (typeof writeChatHook === 'function') await writeChatHook(next, chat)
        chat = structuredClone(next)
      }
      return structuredClone(chat)
    }
  }
  const model = {
    selection(selectedChat) { return modelSelection ? modelSelection(selectedChat) : { provider: 'test', model: 'scripted' } },
    async runCandidate(options) { return await nextOutput(options) }
  }
  const plannerCalls = []
  const warnings = []
  const planner = {
    async plan(input) {
      plannerCalls.push(input)
      await planHook?.()
      return { text: '候选项上下文', stableText: '稳定候选上下文', taskText: '候选格式规则', systemPromptText: '本轮系统提示', postHistoryText: '本轮历史后指令', dynamicText: '本轮游标、Guide 与姿势', audit: { included: [], omitted: [], warnings: [], totalChars: 7 } }
    }
  }
  const candidates = createCandidateGenerator({
    store, model, planner, prompt, scripts: continuity, worldBookContext,
    characterDesign: { async execute() { return JSON.stringify({ ok: true }) } },
    async stableWorldBookContext(currentChat, currentCard) {
      assert.equal(currentChat.id, chat.id)
      assert.equal(currentCard.name, card.name)
      return '常驻世界设定'
    },
    timeline: createStoryTimeline({ id: (prefix) => prefix + '-' + Math.random().toString(36).slice(2), now: () => 123456 }),
    waitUntilSettled: waitUntilSettled || (async () => {}), sleep: async () => {}, now: () => 123456,
    logger: { error() {}, warn(message) { warnings.push(String(message)) } }
  })
  return {
    candidates, continuity, plannerCalls, modelRequests, warnings, modelCalls: () => modelCalls,
    chat: () => structuredClone(chat),
    setMessages(next) {
      chat.messages = structuredClone(next)
      if (chat.timeline) chat.timeline.revision++
    },
    mutateChat(change) { change(chat) }
  }
}

test('开场白后的首次候选会先等待完整后台结算，再规划候选', async () => {
  const order = []
  const run = harness({
    outputs: [JSON.stringify({ choices: storyChoices })],
    messages: [{ role: 'assistant', text: '雨水敲着窗。', greeting: true }],
    async waitUntilSettled(chat) {
      assert.equal(chat.messages[0].greeting, true)
      order.push('settlement')
    }
  })
  const originalPlan = run.plannerCalls
  await run.candidates.generate({ sessionId: 'session-1', messageId: 'opening' })
  if (originalPlan.length > 0) order.push('candidate')

  assert.deepEqual(order, ['settlement', 'candidate'])
})

test('Story Timeline 后台 operation 运行时立即拒绝候选生成，不相信重复的 settleStatus', async () => {
  let waits = 0
  const run = harness({
    outputs: [JSON.stringify({ choices: storyChoices })],
    initialSettleStatus: 'done',
    async waitUntilSettled() { waits++ }
  })
  const timeline = createStoryTimeline({ id: (prefix) => prefix + '-busy', now: () => 123456 })
  run.mutateChat(function (chat) {
    const begun = timeline.apply({ chat, intent: { kind: 'agent.begin', role: 'settlement' } })
    Object.assign(chat, begun.chat)
  })

  await assert.rejects(
    run.candidates.generate({ sessionId: 'session-1', messageId: 'message-running' }),
    /后台 Agent 正在执行 settlement/
  )
  assert.equal(waits, 0)
  assert.equal(run.modelCalls(), 0)
})

test('候选 prepare 只持久化 Operation，模型 Promise 由响应结束后再创建', async () => {
  const run = harness({ outputs: [JSON.stringify({ choices: storyChoices })] })

  const prepared = await run.candidates.prepare({ sessionId: 'session-1', messageId: 'message-prepared' })
  assert.match(prepared.operationId, /^operation-/)
  assert.equal(run.modelCalls(), 0)

  const result = await prepared.execute()
  assert.equal(run.modelCalls(), 1)
  assert.equal(result.messageId, 'message-prepared')
})

test('模型成功但 chat 提交失败时明确报告候选已经生成但保存失败', async () => {
  const run = harness({
    outputs: [JSON.stringify({ choices: storyChoices })],
    async writeChatHook(next) {
      if (next.candidates && next.candidates.messageId === 'message-save-failure') {
        const error = new Error('模拟 chat 文件写入失败')
        error.code = 'EIO'
        throw error
      }
    }
  })

  await assert.rejects(
    () => run.candidates.generate({ sessionId: 'session-1', messageId: 'message-save-failure' }),
    function (error) {
      return error && error.stage === 'committing' && /候选已经生成，但保存失败/.test(error.message)
    }
  )
  assert.equal(run.modelCalls(), 1)
  assert.equal(run.chat().candidates, undefined)
})

test('自由故事只保存完整的 4 action + 1 scene', async () => {
  const run = harness({ outputs: [async function (options) {
    await options.onToolCall({
      name: 'candidate_submit_choices',
      arguments: { actions: storyChoices.slice(0, 4).map(item => item.text), scene: storyChoices[4].text }
    })
    return '<|DSML|tool_calls>不应被当作候选结果的普通文字'
  }] })
  let started = null

  const result = await run.candidates.generate({ sessionId: 'session-1', messageId: 'message-1', guidance: '多写动作', onStarted(operation) { started = operation } })
  assert.match(started.operationId, /^operation-/)
  assert.equal(started.basedOn.revision, 0)
  assert.deepEqual(result.basedOn, started.basedOn, 'durable task result must already match the committed candidate record')
  assert.equal(run.modelCalls(), 1)
  assert.equal(result.choices.length, 5)
  assert.equal(result.choices.filter((item) => item.type === 'action').length, 4)
  assert.equal(result.choices.filter((item) => item.type === 'scene').length, 1)
  assert.equal(result.traceSessionId, 'candidate-trace-1')
  assert.equal(result.traceMode, 'continuable')
  assert.equal(run.modelRequests[0].persistent, true)
  assert.equal(run.modelRequests[0].maxTokens, undefined)
  assert.equal(run.plannerCalls[0].purpose, 'candidate')
  assert.match(run.plannerCalls[0].task, /剧情候选项生成器/)

  const saved = await run.candidates.find({ sessionId: 'session-1', messageId: 'message-1' })
  assert.deepEqual(saved, result)
  assert.equal(await run.candidates.find({ sessionId: 'session-1', messageId: 'old-message' }), null)
})

test('候选生成期间时间线变化，迟到候选与 point 都不会落盘', async () => {
  let run
  run = harness({ mode: 'script', outputs: [async function (options) {
    await options.onToolCall({ name: 'tavern_point_script', arguments: { position: 3 } })
    run.mutateChat(function (chat) { chat.timeline.revision++ })
    return JSON.stringify({ choices: [{ type: 'action', text: '这是已经过期的候选' }] })
  }] })

  await assert.rejects(
    () => run.candidates.generate({ sessionId: 'session-1', messageId: 'stale-candidate' }),
    /剧情状态已变化/
  )
  assert.equal(run.chat().candidates, undefined)
  assert.equal(run.continuity.inspect({ script: script(), state: run.chat().scriptState, request: { kind: 'progress' } }).cursor, 0)
})

test('剧本候选可按数字自由读取远处剧本并直接定位游标', async () => {
  const researched = []
  const run = harness({ mode: 'script', outputs: [async function (options) {
    researched.push(JSON.parse(await options.onToolCall({
      name: 'tavern_read_script',
      arguments: { position: 2 }
    })))
    researched.push(JSON.parse(await options.onToolCall({
      name: 'tavern_read_script',
      arguments: { position: 3 }
    })))
    researched.push(JSON.parse(await options.onToolCall({
      name: 'tavern_point_script',
      arguments: { position: 3 }
    })))
    return JSON.stringify({
      choices: [{ type: 'action', text: '沿着钟楼石阶谨慎地向上追去' }]
    })
  }] })

  const result = await run.candidates.generate({ sessionId: 'session-1', messageId: 'message-2' })
  assert.equal(result.choices.length, 1)
  assert.deepEqual(researched.slice(0, 2).map((item) => item.chunks[0].id), ['chunk-00002', 'chunk-00003'])
  assert.equal(researched[2].pointedAt, 3)
  assert.match(run.plannerCalls[0].task, /剧本候选项生成器/)
  assert.match(run.plannerCalls[0].task, /tavern_point_script/)
  const savedChat = run.chat()
  const progress = run.continuity.inspect({ script: script(), state: savedChat.scriptState, request: { kind: 'progress' } })
  assert.equal(progress.cursor, 2)
  assert.equal(run.plannerCalls[0].scriptWindow.chunks[0].id, 'chunk-00001')
  assert.deepEqual(run.modelRequests[0].tools.map((tool) => tool.name), ['tavern_read_script', 'tavern_point_script', 'character_design_read', 'character_design_save', 'candidate_submit_choices'])
  assert.equal(run.modelRequests[0].tools[0].parameters.properties.position.minimum, 1)
  assert.equal(run.modelRequests[0].tools[0].parameters.properties.point, undefined)
  assert.equal(run.modelRequests[0].tools[1].parameters.properties.position.minimum, 1)
  assert.equal(run.modelRequests[0].tools[1].parameters.properties.query, undefined)
  assert.equal(run.modelRequests[0].tools[1].countsTowardLimit, false)
  assert.equal(result.traceSessionId, 'candidate-trace-1')
  assert.deepEqual(savedChat.messages, [{ role: 'assistant', text: '雨水敲着窗。' }])
})

test('剧本候选 JSON 中的旧 scriptCursor 字段不能再移动游标', async () => {
  const blind = JSON.stringify({
    choices: [{ type: 'action', text: '直接前往钟楼顶层寻找最终的真相' }],
    scriptCursor: 3
  })
  const run = harness({ mode: 'script', outputs: [blind] })

  await run.candidates.generate({ sessionId: 'session-1', messageId: 'message-blind' })
  const progress = run.continuity.inspect({ script: script(), state: run.chat().scriptState, request: { kind: 'progress' } })
  assert.equal(progress.cursor, 0)
})

test('单次输出无效时不覆盖旧候选，也不改变剧本游标', async () => {
  const invalid = '{"choices":[{"type":"unknown","text":"有文本但类型无效"}]}'
  const oldCandidates = { messageId: 'old', choices: [{ type: 'action', text: '保留这一份旧的有效候选内容' }], generatedAt: 1 }
  const stageThenFail = async function (options) {
    await options.onToolCall({ name: 'tavern_read_script', arguments: { position: 2 } })
    return invalid
  }
  const run = harness({ mode: 'script', outputs: [stageThenFail], initialCandidates: oldCandidates })

  await assert.rejects(() => run.candidates.generate({ sessionId: 'session-1', messageId: 'message-3' }), /有效候选项/)
  assert.equal(run.modelCalls(), 1)
  const after = run.chat()
  assert.deepEqual(after.candidates, oldCandidates)
  assert.equal(run.continuity.inspect({ script: script(), state: after.scriptState, request: { kind: 'progress' } }).cursor, 0)
})

test('卡片模式拒绝生成候选项', async () => {
  const run = harness({ mode: 'card', outputs: ['{}'] })
  await assert.rejects(() => run.candidates.generate({ sessionId: 'session-1', messageId: 'message-4' }), /卡片模式不生成剧情候选项/)
})

test('候选 Agent 使用宏解析后的 Session 正文而不是原始 sourceText', async () => {
  const run = harness({
    outputs: [JSON.stringify({ choices: storyChoices })],
    macroState: { userName: '叶天邪', local: {}, global: {} },
    messages: [{ role: 'assistant', text: '叶天邪走进白伊甸校园。', sourceText: '{{user}}走进白伊甸校园。' }]
  })
  await run.candidates.generate({ sessionId: 'session-1', messageId: 'message-projected' })

  assert.match(JSON.stringify(run.modelRequests[0].messages), /叶天邪走进白伊甸校园/)
  assert.doesNotMatch(JSON.stringify(run.modelRequests[0].messages), /\{\{user\}\}/)
})

test('first candidate interrupted before a result keeps its bound session for retry', async () => {
  const run = harness({ outputs: [async input => {
    await input.onPersistentSessionReady('background-bound-before-result');
    throw new Error('interrupted');
  }, JSON.stringify({ choices: storyChoices })] });
  await assert.rejects(run.candidates.generate({ sessionId: 'session-1', messageId: 'first' }));
  await run.candidates.generate({ sessionId: 'session-1', messageId: 'first' });
  assert.equal(run.modelRequests[1].persistentSessionId, 'background-bound-before-result');
});

test('候选准备期间人工移动游标，旧上下文不得开始模型任务或覆盖游标', async () => {
  let run
  run = harness({ mode: 'script', outputs: [], planHook: () => {
    run.mutateChat(chat => { chat.scriptState = createScriptContinuity().transition({ script: script(), state: chat.scriptState, event: { kind: 'manual-focus', cursor: 3 } }).state })
  } })
  await assert.rejects(run.candidates.generate({ sessionId: 'session-1', messageId: 'manual-cursor' }), /剧本游标已变化/)
  assert.equal(run.modelRequests.length, 0)
  assert.equal(run.chat().scriptState.cursor, 2)
  assert.equal(run.chat().candidates, undefined)
})

test('候选准备期间修改切片字数，即使游标未变也不能继续使用旧上下文', async () => {
  let run
  run = harness({ mode: 'script', outputs: [], planHook: () => {
    run.mutateChat(chat => { chat.scriptState = createScriptContinuity().transition({ script: script(), state: chat.scriptState, event: { kind: 'set-chunk-size', chunkSize: 1000 } }).state })
  } })
  await assert.rejects(run.candidates.generate({ sessionId: 'session-1', messageId: 'new-budget' }), /剧本游标已变化/)
  assert.equal(run.modelRequests.length, 0)
})


test('one request shares its prepared worldbook with the runner and the next request resolves afresh', async () => {
  let count = 0
  const app = harness({outputs:[JSON.stringify({choices:storyChoices})],worldBookContext:async()=>({context:'context-'+(++count),prefixContext:'prefix-'+count})})
  const first = await app.candidates.prepare({sessionId:'s',messageId:'m',requestId:'one'})
  await first.execute()
  const second = await app.candidates.prepare({sessionId:'s',messageId:'m',requestId:'two'})
  await second.execute()
  assert.equal(count,2)
  assert.equal(app.plannerCalls[0].constantWorldBookContext,'context-1')
  assert.equal(app.modelRequests[0].preparedWorldbook.prefixContext,'prefix-1')
  assert.equal(app.modelRequests[1].preparedWorldbook.prefixContext,'prefix-2')
})
