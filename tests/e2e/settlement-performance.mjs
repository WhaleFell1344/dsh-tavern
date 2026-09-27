import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createChatJournalStore } from '../../tavern-plugin/lib/domain/chat-journal-store.js'
import { createChatPersistence } from '../../tavern-plugin/lib/domain/chat-persistence.js'
import { encodeMigratedSessionLog, parseSessionLog } from '../../tavern-plugin/lib/domain/legacy-session-migration.js'

// Avoid Playwright's iframe element preview: a srcdoc containing a complete
// compatibility context can be hundreds of MB and preview formatting dominates
// the very performance this probe measures. Still inspect the real status DOM.
async function statusFrame(page) {
  const handle = await page.waitForFunction(() => document.querySelector('.dsh-tavern-status-runtime iframe.dsh-tavern-message-frame'), null, {timeout:120000})
  const frame = await handle.asElement().contentFrame(); await handle.dispose()
  assert.ok(frame, 'the mounted status frame must exist')
  return frame
}

export function settlementPerformanceInitialVariables() {
  const state = { gold: 0 }
  for (let i = 0; i < Number(process.env.TAVERN_PERF_FIELDS || 20); i++) state['perfField' + i] = { value: i, label: '合成长档状态'.repeat(6), enabled: true }
  return state
}

export async function settlementPerformanceChecks({ page, step, savedChat, output, report, restartServer, root, data, readLog }) {
  const rounds = Number(process.env.TAVERN_PERF_ROUNDS || 1000)
  const fields = Number(process.env.TAVERN_PERF_FIELDS || 20)
  const runs = Number(process.env.TAVERN_PERF_RUNS || 5)
  const append = process.env.TAVERN_PERF_APPEND === '1'
  const requireCompact = process.env.TAVERN_PERF_REQUIRE_COMPACT !== '0'
  const bodyRepeats = Number(process.env.TAVERN_PERF_BODY_REPEATS || 60)
  assert.ok(Number.isInteger(bodyRepeats) && bodyRepeats >= 1 && bodyRepeats <= 1000)
  assert.ok(Number.isInteger(rounds) && rounds >= 2 && rounds <= 10000)
  assert.ok(Number.isInteger(fields) && fields >= 0 && fields <= 2000)
  assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 100)
  const historyReady = process.env.TAVERN_PERF_HISTORY_READY === '1'
  let fixture = await savedChat()
  if (historyReady) {
    // Use flags produced by the real template engine for these exact bodies.
    // A copied flag for a different synthetic body creates a repair backlog.
    const deadline=Date.now()+60000
    while (!fixture.messages.every(row=>row.tavernPluginData?.template_rendered)) {
      assert.ok(Date.now()<deadline,'initial historical template displays must finish before cloning')
      await page.waitForTimeout(250)
      fixture=await savedChat()
    }
  }
  const chatId = fixture.id
  let size
  report.settlementPerformance = { scope: 'isolated full DSH + native Session + official MVU + active storage + React; synthetic history, fixed model; tracing disabled', requireCompact, size: { rounds, fields }, samples: [] }
  await step(`构造 ${rounds} 轮隔离长档并重新打开`, async () => {
    const reopening = await restartServer(async () => {
      const next = structuredClone(fixture), greeting = next.messages[0], user = next.messages.find(m => m.role === 'user'), assistant = next.messages.at(-1)
      const state = structuredClone(assistant.variables[0])
      assert.equal(Object.keys(state.stat_data).length, fields + 1, 'large variable schema must come from real card initialization')
      const body = historyReady ? assistant.text : '这是性能测试的合成剧情，不对应真实存档。'.repeat(bodyRepeats) + '\n\n<StatusPlaceHolderImpl/>'
      const userBody = turn => historyReady ? user.text : '性能测试输入 ' + turn
      next.messages = [{ ...greeting, variables: [structuredClone(state)] }]
      const rows = []
      const event = (type, d, surfaceOp) => rows.push({ seq: rows.length, time: 1, type, data: d, ...(surfaceOp ? { surfaceOp } : {}) })
      for (let turn = 1; turn <= rounds; turn++) {
        event('turn/start', { turn }); event('step/start', { turn, step: 1 })
        if (turn > 1) {
          next.messages.push({ ...structuredClone(user), turn, text: userBody(turn), sourceText: userBody(turn) })
          event('user/message', { id: 'perf-u-' + turn, role: 'user', content: [{ type: 'text', text: userBody(turn) }], source: { kind: 'user' } }, 'append')
          const message = { ...structuredClone(assistant), turn, text: body, sourceText: body, swipes: [body], variables: [structuredClone(state)] }
          message.mvuBaseline = { swipeId: 0, variables: structuredClone(state) }
          next.messages.push(message)
        }
        event('assistant/message', { turn, step: 1, message: { id: 'perf-a-' + turn, role: 'assistant', content: [{ type: 'text', text: turn === 1 ? greeting.text : body }], source: { kind: 'model', provider: 'tavern-e2e', model: 'fixed' } } }, 'append')
        event('step/end', { turn, step: 1 }); event('turn/end', { turn, reason: { kind: 'completed' } })
      }
      size = { rounds, bodyRepeats, historyReady, messages: next.messages.length, variableFields: fields + 1, bytes: Buffer.byteLength(JSON.stringify(next)), snapshotBytes: Buffer.byteLength(JSON.stringify(state)) }
      report.settlementPerformance.size = size
      const estimate = value => {
        if (typeof value === 'string') return 24 + value.length * 2
        if (!value || typeof value !== 'object') return 8
        return 64 + Object.keys(value).reduce((sum, key) => sum + 24 + key.length * 2 + estimate(value[key]), 0)
      }
      size.approximateChatBytes = estimate(next)
      console.log('Long archive fixture: ' + JSON.stringify(size))
      const persistence = createChatPersistence({ store: createChatJournalStore({ dataRoot: data }) })
      await persistence.write(next)
      const sessions = join(root, 'profile-data/tavern/sessions')
      let found = false
      for (const file of (await readdir(sessions, { recursive: true })).filter(x => x.endsWith('session.v3.jsonl.zstd'))) {
        const path = join(sessions, file), saved = parseSessionLog(await readFile(path))
        if (saved.header.id !== fixture.sessionId) continue
        const header = { type: 'session', delegationDepth: 0, version: 0, id: fixture.sessionId, createdAt: saved.header.createdAt, cwd: saved.header.cwd }
        await writeFile(join(dirname(path), 'session.jsonl.zstd'), encodeMigratedSessionLog(JSON.stringify(header), rows))
        await rm(path)
        found = true; break
      }
      assert.ok(found, 'synthetic Chat and native Session must have matching turn coordinates')
    })
    await (await statusFrame(page)).locator('#e2e-gold').filter({ hasText: /^金币：10$/ }).waitFor({ timeout: 120000 })
    if (reopening) {
      size.runtimeBootMs = reopening.bootMs
      size.coldOpenToStatusMs = Date.now() - reopening.openStarted
    }
    // Exclude cold initialization and allow snapshot maintenance to settle.
    await page.waitForTimeout(3000)
  })
  const samples = []
  report.settlementPerformance = { scope: 'isolated full DSH + native Session + official MVU + active storage + React; synthetic history, fixed model; tracing disabled', requireCompact, size, samples }
  for (let run = 0; run < runs; run++) await step(`长档结算采样 ${run + 1}/${runs}`, async () => {
    const gold = 100 + run
    await writeFile(join(output, 'performance-control.json'), JSON.stringify({ id: run, gold }))
    const offset = readLog().length
    const clickedAt = Date.now()
    report.settlementPerformance.activeSample = {run, clickedAt, requireCompact}
    await page.evaluate(() => {
      window.__perfSettlementObserver?.disconnect()
      window.__perfSettlement = { events: [] }
      window.__perfSettlementObserver = new MutationObserver(() => {
        const receipt = [...document.querySelectorAll('.dsh-tavern-mvu-receipt')].filter(node => node.getClientRects().length).at(-1)
        if (!receipt) return
        if (receipt.dataset.status !== 'updated') window.__perfSettlement.pendingSeen = true
        if (receipt.dataset.status === 'updated' && window.__perfSettlement.pendingSeen && !window.__perfSettlement.receiptAt) window.__perfSettlement.receiptAt = performance.timeOrigin + performance.now()
      })
      window.__perfSettlementObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-status'] })
      if (!window.__perfSettlementListening) {
        window.__perfSettlementListening = true
        addEventListener('message', event => { if (event.data?.type === 'dsh-tavern-helper-event-complete' && String(event.data.eventId).startsWith('mvu-work:')) window.__perfSettlement.events.push({ stage: 'browser-event-complete', eventId: event.data.eventId, at: performance.timeOrigin + performance.now() }) })
      }
    })
    if (append) {
      const composer = page.getByRole('textbox', {name:/发消息|Message/})
      await composer.fill('性能测试继续游玩 ' + run)
      await composer.press('Enter')
    } else {
    const receipt = page.locator('.dsh-tavern-mvu-receipt').filter({ visible: true }).last()
    if (await receipt.getAttribute('open') === null) await receipt.locator('summary').click()
    await receipt.getByRole('button', { name: '重新结算变量', exact: true }).click()
    await page.getByPlaceholder('例如：这轮还没有交付物品，不要扣除库存。').fill('性能测试：本次金币更新为 ' + gold)
    await page.getByRole('button', { name: '重新结算', exact: true }).click()
    }
    const frame = await statusFrame(page)
    const visiblePromise = frame.evaluate(gold => new Promise(resolve => {
      const node = document.querySelector('#e2e-gold')
      const check = () => { if (node.textContent === '金币：' + gold) { observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now()))) } }
      const observer = new MutationObserver(check); observer.observe(node, { subtree: true, characterData: true, childList: true }); check()
    }), gold).then(value => ({ value }), error => ({ error }))
    await frame.locator('#e2e-gold').filter({ hasText: new RegExp('^金币：' + gold + '$') }).waitFor({ timeout: 120000 })
    const observation = await visiblePromise
    if (observation.error) throw observation.error
    const visibleAt = observation.value
    await page.locator('.dsh-tavern-mvu-receipt[data-status="updated"]').filter({ visible: true }).last().waitFor()
    const receiptAt = await page.evaluate(() => window.__perfSettlement.receiptAt || null)
    // Fresh store, independent of the running server's hot cache. Read only target.
    const readStart = performance.now()
    const disk = await createChatJournalStore({ dataRoot: data }).readSlice(chatId, [size.messages - 1 + (append ? 2 * (run + 1) : 0)], 'settlement')
    assert.equal(disk.messageCount, size.messages + (append ? 2 * (run + 1) : 0), 'append must add exactly one user/assistant pair')
    const saved = disk.chat.messages[0]
    assert.equal(saved.variables[0].stat_data.gold, gold)
    assert.equal(Object.keys(saved.variables[0].stat_data).length, fields + 1)
    for (let i = 0; i < fields; i++) assert.deepEqual(saved.variables[0].stat_data['perfField' + i], { value: i, label: '合成长档状态'.repeat(6), enabled: true })
    assert.equal(saved.mvu.receipt.status, 'updated')
    assert.equal(saved.mvu.pending, false)
    const diskReadMs = performance.now() - readStart
    const events = [...readLog().slice(offset).matchAll(/\[settlement-perf\](\{[^\n]+\})/g)].map(match => JSON.parse(match[1]))
    const at = stage => events.find(x => x.stage === stage)?.at
    const submitted = at('submitted'), runtime = at('runtime-return')
    const commitStart = events.find(x=>x.stage==='commit-start' && x.at>=runtime)?.at
    const commitAt = events.find(x=>x.stage==='commit-return' && x.at>=commitStart)?.at
    assert.ok(submitted && runtime && commitStart && commitAt, 'all real settlement boundaries must be measured')
    const persisted = events.filter(x => ['journal-appended','native-head-published'].includes(x.stage) && x.source === 'background.settlement.commit' && x.at >= commitStart && x.at <= commitAt).at(-1)
    assert.ok(persisted, 'final commit must publish native head or append legacy journal')
    const persistedAt=persisted.at
    const browserEvents = await page.evaluate(() => window.__perfSettlement.events)
    const eventId = events.find(x => x.stage === 'dispatch-start')?.eventId
    const browserCompleteAt = browserEvents.find(x => x.eventId === eventId)?.at
    assert.ok(browserCompleteAt, 'observe completion of the exact MVU browser event')
    const round = n => Math.round(n * 10) / 10
    const sample = { run, append, gold, clickedAt, submittedAt: submitted, runtimeReturnedAt: runtime, commitStartedAt: commitStart, persistenceCompletedAt:persistedAt, persistenceKind:persisted.stage, ...(persisted.stage==='journal-appended'?{journalAppendedAt:persistedAt}:{}), commitAt, visibleAt, receiptAt, browserCompleteAt,
      browserToPersistenceMs: round(persistedAt - browserCompleteAt), ...(persisted.stage==='journal-appended'?{browserToJournalMs:round(persistedAt-browserCompleteAt)}:{}), browserToCommitMs: round(commitAt - browserCompleteAt), browserToVisibleMs: round(visibleAt - browserCompleteAt),
      inputToSubmitMs: round(submitted - clickedAt), inputToVisibleMs: round(visibleAt - clickedAt),
      submitToCommitMs: round(commitAt - submitted), submitToVisibleMs: round(visibleAt - submitted), runtimeToCommitMs: round(commitAt - runtime),
      runtimeToVisibleMs: round(visibleAt - runtime), commitMs: round(commitAt - commitStart), commitToVisibleMs: round(visibleAt - commitAt),
      diskReadMs: round(diskReadMs), events, browserEvents }
    samples.push(sample)
    delete report.settlementPerformance.activeSample
    console.log('PERF ' + JSON.stringify({ ...size, ...Object.fromEntries(Object.entries(sample).filter(([key]) => key.endsWith('Ms'))) }))
    await writeFile(join(output, 'settlement-performance.json'), JSON.stringify(report.settlementPerformance, null, 2))
    if (append && requireCompact) {
      const contexts = events.filter(event => event.stage === 'execution-context')
      assert.ok(contexts.length > 0 && contexts.every(event => event.compact && event.messages <= 5),
        'warm append settlement must keep a bounded context without full recovery')
    }
    await page.waitForTimeout(500)
  })
  await page.screenshot({ path: join(output, 'long-archive-settled.png') })
}
