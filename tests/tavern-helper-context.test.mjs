import assert from 'node:assert/strict'
import test from 'node:test'
import { projectOpeningCommit, projectRuntimeReplyHistory } from '../tavern-plugin/lib/domain/runtime-content-projection.js'

import {
  appendTavernHelperMessages,
  HELPER_MESSAGE_COLD_WINDOW,
  hydrateTavernHelperMessages,
  lastTavernHelperVariables,
  projectTavernHelperContext,
  projectTavernHelperMessage,
  replaceTavernHelperMessages,
  replaceTavernHelperVariables
} from '../tavern-plugin/lib/domain/tavern-helper-context.js'

function macroOpeningChat() {
  const source = '{{incvar::visits}}{{User}}看向{{Char}}。'
  const projection = projectOpeningCommit(source, { charName: '角色', macroState: { userName: '玩家', local: { visits: 0 } } })
  return {
    cardName: '角色', macroState: projection.macroState,
    messages: [{ role: 'assistant', greeting: true, turn: 1, swipeId: 0,
      swipes: [source, '{{USER}}离开{{char}}。'], variables: [{}, {}],
      sourceText: source, projectionText: projection.renderedText,
      text: projection.sessionText, sessionText: projection.sessionText,
      displayText: projection.displayText, displayMode: projection.displayMode }]
  }
}

test('MVU 数据写回不覆盖已解析正文，也不重新执行有副作用的宏', () => {
  for (const patch of [
    { data: { stat_data: { hp: 9 } } },
    { swipes_data: [{ stat_data: { hp: 9 } }, {}] },
    { swipe_id: 0, data: { stat_data: { hp: 9 } } }
  ]) {
    const chat = macroOpeningChat()
    const before = structuredClone(chat)
    replaceTavernHelperMessages(chat, [{ message_id: 0, ...patch }])
    assert.deepEqual(projectRuntimeReplyHistory(chat.messages), projectRuntimeReplyHistory(before.messages))
    assert.deepEqual(chat.macroState, before.macroState)
    assert.deepEqual({ ...chat.messages[0], variables: [] }, { ...before.messages[0], variables: [] })
    assert.equal(chat.messages[0].variables[0].stat_data.hp, 9)
  }
})

test('真正切换开场或编辑正文时才重新解析宏，保留原始 swipe', () => {
  const chat = macroOpeningChat()
  replaceTavernHelperMessages(chat, [{ message_id: 0, swipe_id: 1 }])
  assert.equal(chat.messages[0].text, '玩家离开角色。')
  assert.equal(chat.messages[0].sourceText, '{{USER}}离开{{char}}。')
  assert.equal(chat.messages[0].swipes[1], '{{USER}}离开{{char}}。')
  replaceTavernHelperMessages(chat, [{ message_id: 0, message: '{{incvar::visits}}{{User}}回来。' }])
  assert.equal(chat.messages[0].text, '2玩家回来。')
  assert.equal(chat.macroState.local.visits, 2)
  assert.equal(projectRuntimeReplyHistory(chat.messages).projections[0].text, '2玩家回来。')
  replaceTavernHelperMessages(chat, [{ message_id: 0, message: '' }])
  assert.equal(chat.messages[0].text, '')
})

test('Helper 变量写入只修改指定楼层 swipe 或聊天变量', () => {
  const chat = {
    variables: {},
    messages: [{ role: 'assistant', swipeId: 1, variables: [{ hp: 1 }, { hp: 2 }] }]
  }

  assert.deepEqual(replaceTavernHelperVariables(chat, { option: { type: 'message', message_id: 0 }, variables: { hp: 4 } }), { type: 'message', messageId: 0, swipeId: 1 })
  assert.deepEqual(chat.messages[0].variables, [{ hp: 1 }, { hp: 4 }])
  assert.deepEqual(replaceTavernHelperVariables(chat, { option: { type: 'chat' }, variables: { cache: true } }), { type: 'chat' })
  assert.deepEqual(chat.variables, { cache: true })
})

test('Helper 脚本变量按脚本 ID 独立持久化并进入同步上下文', () => {
  const chat = { messages: [], tavernHelperScriptVariables: { existing: { enabled: true } } }
  assert.deepEqual(
    replaceTavernHelperVariables(chat, { option: { type: 'script', script_id: 'dynamic-worldbook' }, variables: { auto_apply: false } }),
    { type: 'script', scriptId: 'dynamic-worldbook' }
  )
  assert.deepEqual(projectTavernHelperContext(chat).scriptVariables, {
    existing: { enabled: true },
    'dynamic-worldbook': { auto_apply: false }
  })
  assert.throws(function () {
    replaceTavernHelperVariables(chat, { option: { type: 'script' }, variables: {} })
  }, /script_id/)
})

test('Helper 创建的新楼层只进入脚本历史，不冒充剧情回合', () => {
  const chat = macroOpeningChat()
  const storyProjection = projectRuntimeReplyHistory(chat.messages)
  assert.deepEqual(appendTavernHelperMessages(chat, [{
    role: 'assistant', message: '<chat_history>手机记录</chat_history>',
    name: '手机', is_hidden: false, data: { phone: true }
  }]), [{ messageId: 1 }])

  assert.equal(chat.messages[1].role, 'tavern-helper')
  assert.equal(chat.messages[1].tavernRole, 'assistant')
  assert.equal(chat.messages[1].turn, undefined)
  const projected = projectTavernHelperContext(chat).messages[1]
  assert.equal(projected.role, 'assistant')
  assert.equal(projected.name, '手机')
  assert.equal(projected.is_hidden, false)
  assert.equal(projected.message, '<chat_history>手机记录</chat_history>')
  assert.deepEqual(projected.variables, { phone: true })
  assert.deepEqual(projectRuntimeReplyHistory(chat.messages), storyProjection)
  assert.deepEqual(lastTavernHelperVariables(chat.messages), {})

  assert.throws(() => appendTavernHelperMessages(chat, [{ role: 'assistant', message: '插入' }], { insert_before: 0 }), /只支持追加/)
})

test('冷启动只对窗口外楼层出骨架，补水后与全量投影一致', () => {
  const count = HELPER_MESSAGE_COLD_WINDOW + 3
  const chat = {
    id: 'cold',
    messages: Array.from({ length: count }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: '正文' + index,
      variables: [{ hp: index, blob: 'x'.repeat(200) }]
    }))
  }
  const skeletonUntil = count - HELPER_MESSAGE_COLD_WINDOW
  const cold = projectTavernHelperContext(chat, { skeletonUntil })
  assert.deepEqual(cold.messagesPending, { from: 0, to: skeletonUntil - 1 })
  assert.equal(cold.messages[0].stub, true)
  assert.equal(cold.messages[0].message, '')
  assert.deepEqual(cold.messages[0].variables, {})
  assert.equal(cold.messages[skeletonUntil].stub, undefined)
  assert.equal(cold.messages[skeletonUntil].message, '正文' + skeletonUntil)
  assert.equal(cold.messages[skeletonUntil].variables.hp, skeletonUntil)

  const hydrated = hydrateTavernHelperMessages(chat, cold.messagesPending.from, cold.messagesPending.to)
  assert.equal(hydrated.messages.length, skeletonUntil)
  const merged = cold.messages.slice()
  for (const message of hydrated.messages) merged[message.message_id] = message
  const full = projectTavernHelperContext(chat)
  assert.deepEqual(merged, full.messages)
  assert.deepEqual(hydrated.messages[0], projectTavernHelperMessage(chat.messages[0], 0))
})

test('verified tail append visits only appended floors and preserves turn mappings', () => {
  for (const length of [1000, 10000]) {
    const rows = Array.from({length}, (_, i) => ({role:'assistant', turn:i + 1, text:'old', variables:[{hp:i}]}))
    const previous = projectTavernHelperContext({id:'append',messages:rows},{indexed:true})
    rows.push({role:'user',turn:length + 1,text:'input'}, {role:'assistant',turn:length + 1,text:'new',variables:[{hp:7}]})
    let reads = 0
    const messages = new Proxy(rows,{get(target,key,receiver){if(typeof key === 'string' && /^\d+$/.test(key)) reads++;return Reflect.get(target,key,receiver)}})
    const next = projectTavernHelperContext({id:'append',messages},{indexed:true,previousContext:previous,previousMessages:previous.messages,dirtyIndices:new Set([length,length + 1]),layoutChanged:true,layoutFrom:length})
    assert.ok(reads <= 4, `append visited ${reads} floors of ${length}`)
    assert.equal(next.messages[0],previous.messages[0])
    assert.equal(next.turnMessageIds[String(length + 1)],length + 1)
    assert.equal(previous.turnMessageIds[String(length + 1)],undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(next)),JSON.parse(JSON.stringify(projectTavernHelperContext({id:'append',messages:rows}))))
  }
})

test('dirty 局部投影复用未脏楼层，只重建脏索引与新增尾段', () => {
  const chat = {
    id: 'dirty',
    messages: [
      { role: 'assistant', text: '甲', variables: [{ hp: 1 }] },
      { role: 'user', text: '乙' },
      { role: 'assistant', text: '丙', variables: [{ hp: 3 }] }
    ]
  }
  const previous = projectTavernHelperContext(chat)
  const kept = previous.messages[0]
  chat.messages[2].variables = [{ hp: 9 }]
  chat.messages.push({ role: 'user', text: '丁' })
  const next = projectTavernHelperContext(chat, {
    previousMessages: previous.messages,
    dirtyIndices: new Set([2])
  })
  assert.equal(next.messages[0], kept)
  assert.equal(next.messages[1], previous.messages[1])
  assert.notEqual(next.messages[2], previous.messages[2])
  assert.equal(next.messages[2].variables.hp, 9)
  assert.equal(next.messages[3].message, '丁')
  assert.deepEqual(next.messages, projectTavernHelperContext(chat).messages.map((message, index) => (
    index === 0 || index === 1 ? previous.messages[index] : message
  )))
})

test('含 stub 的 previous 不作 dirty 复用，结构回退全量投影', () => {
  const chat = {
    messages: [
      { role: 'assistant', text: '旧', variables: [{ hp: 1, heavy: 'y'.repeat(50) }] },
      { role: 'assistant', text: '新', variables: [{ hp: 2 }] }
    ]
  }
  const cold = projectTavernHelperContext(chat, { skeletonUntil: 1 })
  assert.equal(cold.messages[0].stub, true)
  const rebuilt = projectTavernHelperContext(chat, {
    previousMessages: cold.messages,
    dirtyIndices: new Set([1])
  })
  assert.equal(rebuilt.messages[0].stub, undefined)
  assert.equal(rebuilt.messages[0].variables.hp, 1)
  assert.deepEqual(rebuilt.messages, projectTavernHelperContext(chat).messages)
})
