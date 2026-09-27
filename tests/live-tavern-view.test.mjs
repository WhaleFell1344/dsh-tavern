import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadFactory() {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  let descriptor
  const sandbox = { window: { __ModuleLoader__: { load(value) { descriptor = value } }, setInterval, clearInterval }, console, AbortController }
  vm.runInNewContext(source, sandbox)
  return descriptor.factory(function () { return {} }).createLiveTavernViewModule
}

function fakeTimers() {
  const pending = []
  return {
    schedule(run, delay) {
      const timer = { run, delay, cancelled: false }
      pending.push(timer)
      return timer
    },
    cancel(timer) { timer.cancelled = true },
    async runNext() {
      const timer = pending.find(function (item) { return !item.cancelled })
      assert.ok(timer, 'expected a scheduled refresh')
      timer.cancelled = true
      timer.run()
      await new Promise(function (resolve) { setImmediate(resolve) })
      return timer.delay
    },
    dropAll() { pending.forEach(function (item) { item.cancelled = true }) },
    activeDelays() { return pending.filter(function (item) { return !item.cancelled }).map(function (item) { return item.delay }) }
  }
}

function fakeIntervals() {
  const active = []
  return {
    start(run, delay) {
      const interval = { run, delay, cancelled: false }
      active.push(interval)
      return interval
    },
    stop(interval) { interval.cancelled = true },
    async tick() {
      const interval = active.find(function (item) { return !item.cancelled })
      assert.ok(interval, 'expected an active watchdog')
      interval.run()
      await new Promise(function (resolve) { setImmediate(resolve) })
      return interval.delay
    }
  }
}

const createLiveTavernViewModule = await loadFactory()

test('多个调用者通过同一 interface 订阅时只发出一次加载', async function () {
  const timers = fakeTimers()
  let loads = 0
  const module = createLiveTavernViewModule({
    load: async function () { loads += 1; return { view: { busy: false, marker: loads } } },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const left = []
  const right = []
  const stopLeft = module.subscribe('session-1', function (state) { left.push(state) })
  const stopRight = module.subscribe('session-1', function (state) { right.push(state) })

  await timers.runNext()

  assert.equal(loads, 1)
  assert.equal(module.getSnapshot('session-1').phase, 'ready')
  assert.equal(module.getSnapshot('session-1').view.marker, 1)
  assert.equal(left.at(-1).view.marker, 1)
  assert.equal(right.at(-1).view.marker, 1)
  stopLeft(); stopRight()
})

test('后台 Activity busy 时由 module 统一快速轮询，完成后停止', async function () {
  const timers = fakeTimers()
  const statuses = [true, false]
  const module = createLiveTavernViewModule({
    load: async function () { return { view: { busy: statuses.shift() || false } } },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-2', function () {})

  await timers.runNext()
  assert.deepEqual(timers.activeDelays(), [200])
  await timers.runNext()
  assert.equal(module.getSnapshot('session-2').view.busy, false)
  assert.deepEqual(timers.activeDelays(), [])
  stop()
})

test('生成期完整视图不自动轮询，只在状态事件失效后重读', async function () {
  const timers = fakeTimers()
  let loads = 0
  const module = createLiveTavernViewModule({
    load: async function () { loads += 1; return { view: { activity: { busy: loads === 1 } } } },
    shouldPoll(view) { return !!(view && view.activity && view.activity.busy) },
    pollWhileBusy: false,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-event-driven', function () {})

  await timers.runNext()
  assert.equal(loads, 1)
  assert.deepEqual(timers.activeDelays(), [])

  module.invalidate('session-event-driven')
  await timers.runNext()
  assert.equal(loads, 2)
  assert.equal(module.getSnapshot('session-event-driven').view.activity.busy, false)
  stop()
})

test('后台已空闲但主轮询定时器丢失时，watchdog 会恢复权威查询并解除 busy', async function () {
  const timers = fakeTimers()
  const watchdog = fakeIntervals()
  const statuses = [true, false]
  const module = createLiveTavernViewModule({
    load: async function () { return { view: { busy: statuses.shift() || false } } },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel,
    startWatchdog: watchdog.start,
    stopWatchdog: watchdog.stop,
    watchdogIntervalMs: 1000
  })
  const stop = module.subscribe('session-watchdog', function () {})

  await timers.runNext()
  assert.equal(module.getSnapshot('session-watchdog').view.busy, true)
  timers.dropAll()

  assert.equal(await watchdog.tick(), 1000)
  assert.equal(module.getSnapshot('session-watchdog').view.busy, false)
  stop()
})

test('客户端先投影 busy 时立即开始权威轮询，服务端 idle 后解除门控', async function () {
  const timers = fakeTimers()
  const module = createLiveTavernViewModule({
    load: async function () { return { view: { busy: false, phase: 'idle' } } },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-optimistic', function () {})
  await timers.runNext()

  const release = module.setView('session-optimistic', { busy: true, phase: 'running' })
  assert.deepEqual(timers.activeDelays(), [0])
  await timers.runNext()

  assert.equal(module.getSnapshot('session-optimistic').view.busy, true, '服务端尚未登记 Operation 时不能用旧 idle 提前解锁')
  assert.deepEqual(timers.activeDelays(), [200])
  release()
  assert.deepEqual(timers.activeDelays(), [0])
  await timers.runNext()

  assert.equal(module.getSnapshot('session-optimistic').view.busy, false)
  assert.equal(module.getSnapshot('session-optimistic').view.phase, 'idle')
  assert.deepEqual(timers.activeDelays(), [])
  stop()
})

test('失效通知在加载中到达时只排队一次后续刷新', async function () {
  const timers = fakeTimers()
  let resolveLoad
  let loads = 0
  const module = createLiveTavernViewModule({
    load: function () {
      loads += 1
      if (loads === 1) return new Promise(function (resolve) { resolveLoad = resolve })
      return Promise.resolve({ view: { busy: false, marker: loads } })
    },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-3', function () {})
  const first = timers.runNext()
  module.invalidate('session-3')
  module.invalidate('session-3')
  resolveLoad({ view: { busy: false, marker: 1 } })
  await first

  assert.deepEqual(timers.activeDelays(), [0])
  await timers.runNext()
  assert.equal(loads, 2)
  assert.equal(module.getSnapshot('session-3').view.marker, 2)
  stop()
})

test('结算轮询请求悬挂时按时取消，并继续轮询直到完成', async function () {
  const timers = fakeTimers()
  let loads = 0
  let aborted = false
  const module = createLiveTavernViewModule({
    loadTimeoutMs: 2000,
    load: async function (_sessionId, request) {
      loads += 1
      if (loads === 1) return { view: { busy: true } }
      if (loads === 2) {
        return await new Promise(function (_resolve, reject) {
          request.signal.addEventListener('abort', function () {
            aborted = true
            reject(new Error('aborted'))
          })
        })
      }
      return { view: { busy: false } }
    },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-stalled', function () {})

  await timers.runNext()
  assert.deepEqual(timers.activeDelays(), [200])
  await timers.runNext()
  assert.deepEqual(timers.activeDelays(), [2000])
  await timers.runNext()
  assert.equal(aborted, true)
  assert.equal(module.getSnapshot('session-stalled').error, '')
  assert.deepEqual(timers.activeDelays(), [300])
  await timers.runNext()

  assert.equal(loads, 3)
  assert.equal(module.getSnapshot('session-stalled').view.busy, false)
  assert.deepEqual(timers.activeDelays(), [])
  stop()
})

test('状态请求超时后较长退避，避免服务端旧请求未结束时再次堆积', async function () {
  const timers = fakeTimers()
  const module = createLiveTavernViewModule({
    loadTimeoutMs: 2000,
    timeoutRetryDelayMs: 5000,
    load: async function (_sessionId, request) {
      return await new Promise(function (_resolve, reject) {
        request.signal.addEventListener('abort', function () { reject(new Error('aborted')) })
      })
    },
    shouldPoll() { return false },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-timeout-backoff', function () {})

  await timers.runNext()
  assert.deepEqual(timers.activeDelays(), [2000])
  await timers.runNext()

  assert.equal(module.getSnapshot('session-timeout-backoff').phase, 'retrying')
  assert.deepEqual(timers.activeDelays(), [5000])
  stop()
})

test('候选 Agent 长时间生成时状态查询只在内部重试，不产生超时错误', async function () {
  const timers = fakeTimers()
  let generating = false
  let loads = 0
  const module = createLiveTavernViewModule({
    loadTimeoutMs: 2000,
    load: async function (_sessionId, request) {
      loads += 1
      if (!generating) return { view: { busy: false } }
      return await new Promise(function (_resolve, reject) {
        request.signal.addEventListener('abort', function () { reject(new Error('aborted')) })
      })
    },
    shouldPoll(view) { return view && view.busy === true },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-generating', function () {})

  await timers.runNext()
  generating = true
  module.invalidate('session-generating')
  await timers.runNext()

  for (let cycle = 0; cycle < 3; cycle += 1) {
    await timers.runNext()
    assert.equal(module.getSnapshot('session-generating').phase, 'retrying')
    assert.equal(module.getSnapshot('session-generating').error, '')
    assert.deepEqual(timers.activeDelays(), [1500])
    if (cycle < 2) await timers.runNext()
  }

  generating = false
  await timers.runNext()
  assert.equal(loads, 5)
  assert.equal(module.getSnapshot('session-generating').phase, 'ready')
  assert.equal(module.getSnapshot('session-generating').view.busy, false)
  assert.equal(module.getSnapshot('session-generating').error, '')
  stop()
})

test('人物卡删除后的状态错误进入不可用终态，不再自动重试并重复弹错', async function () {
  const timers = fakeTimers()
  let loads = 0
  const module = createLiveTavernViewModule({
    load: async function () { loads += 1; throw new Error('人物卡不存在: cards/Erin.json') },
    shouldPoll() { return false },
    isTerminalError(error) { return /人物卡不存在:/.test(String(error && error.message || error || '')) },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('deleted-card-session', function () {})

  await timers.runNext()
  const snapshot = module.getSnapshot('deleted-card-session')
  const delays = timers.activeDelays()
  stop()

  assert.equal(loads, 1)
  assert.equal(snapshot.phase, 'unavailable')
  assert.match(snapshot.error, /人物卡不存在: cards\/Erin\.json/)
  assert.deepEqual(delays, [])
})

test('协调快照空闲时保持低频探测，发现 Session 失联后切换为快速探测', async function () {
  const timers = fakeTimers()
  const snapshots = [
    { liveSession: true, activity: { busy: false } },
    { liveSession: false, activity: { busy: false } }
  ]
  const module = createLiveTavernViewModule({
    load: async function () { return { view: snapshots.shift() } },
    shouldPoll(view) { return !view || view.liveSession === false || (view.activity && view.activity.busy === true) },
    idlePollIntervalMs: 2000,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-coordination', function () {})

  await timers.runNext()
  assert.deepEqual(timers.activeDelays(), [2000])
  await timers.runNext()
  assert.equal(module.getSnapshot('session-coordination').view.liveSession, false)
  assert.deepEqual(timers.activeDelays(), [200])
  stop()
})

test('协调快照首次请求永久挂起时会超时并继续下一次权威探测', async function () {
  const timers = fakeTimers()
  let loads = 0
  const module = createLiveTavernViewModule({
    loadTimeoutMs: 2000,
    idlePollIntervalMs: 2000,
    load: async function () {
      loads += 1
      if (loads === 1) return await new Promise(function () {})
      return { view: { liveSession: true, activity: { busy: false } } }
    },
    shouldPoll(view) { return !view || view.liveSession === false || (view.activity && view.activity.busy === true) },
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-lost-response', function () {})

  await timers.runNext()
  assert.deepEqual(timers.activeDelays(), [2000])
  await timers.runNext()
  assert.equal(module.getSnapshot('session-lost-response').phase, 'retrying')
  assert.deepEqual(timers.activeDelays(), [300])
  await timers.runNext()
  assert.equal(loads, 2)
  assert.equal(module.getSnapshot('session-lost-response').view.liveSession, true)
  assert.deepEqual(timers.activeDelays(), [2000])
  stop()
})

test('逐层挂载历史消息共享已有视图，不为每层重新请求', async () => {
  const create = await loadFactory()
  const timers = fakeTimers()
  let loads = 0
  const view = create({ load: async () => { loads++; return { view: { settleStatus: 'idle' } } },
    schedule: timers.schedule, cancel: timers.cancel, startWatchdog: () => null, stopWatchdog() {} })
  const disposers = [view.subscribe('history', () => {})]
  await timers.runNext()
  for (let i = 0; i < 40; i++) {
    disposers.push(view.subscribe('history', () => {}))
    if (timers.activeDelays().length) await timers.runNext()
  }
  disposers.forEach(dispose => dispose())
  assert.equal(loads, 1)
})

test('历史消息 hook 首次挂载不强制刷新，后续修订仍刷新', async () => {
  const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
  const start = source.indexOf('function useLiveTavernView(')
  const end = source.indexOf('function useTavernCoordination(', start)
  let previous
  let effects = []
  const invalidated = []
  const context = { React: {
    useState: init => [init(), () => {}],
    useCallback: fn => fn, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useRef: initial => (previous ||= { current: initial }),
    useEffect: effect => effects.push(effect)
  }, liveTavernView: { getSnapshot: () => ({}), subscribe: () => () => {}, invalidate: id => invalidated.push(id) } }
  vm.runInNewContext(source.slice(start, end) + ';this.render=useLiveTavernView;', context)
  function render(id, revision) { effects = []; context.render(id, revision); effects.forEach(effect => effect()) }
  render('game', 'closed:1')
  render('game', 'closed:1')
  assert.deepEqual(invalidated, [])
  render('game', 'closed:2')
  assert.deepEqual(invalidated, ['game'])
  render('other', 'closed:5')
  assert.deepEqual(invalidated, ['game'])
})

test('切换会话的首次渲染不能返回旧会话快照', async () => {
  const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
  const start = source.indexOf('function useLiveTavernView('), end = source.indexOf('function useTavernCoordination(', start)
  let saved
  const snapshots = { A: { view: { card: 'A' } }, B: { view: { card: 'B' } } }
  const context = { React: {
    useState(init) { saved ??= init(); return [saved, value => { saved = value }] },
    useEffect() {}, useRef: value => ({ current: value }), useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot()
  }, liveTavernView: { getSnapshot: id => snapshots[id] } }
  vm.runInNewContext(source.slice(start, end) + ';this.render=useLiveTavernView;', context)
  assert.equal(context.render('A', 0), snapshots.A)
  assert.equal(context.render('B', 0), snapshots.B)
})

test('快照回收保护订阅者；过期请求不能复活旧快照；返回重新加载', async () => {
  const timers = fakeTimers(); let resolve
  const module = createLiveTavernViewModule({ load: () => new Promise(r => { resolve = r }),
    schedule: timers.schedule, cancel: timers.cancel, pollWhileBusy: false })
  const stop = module.subscribe('A', () => {})
  await timers.runNext()
  assert.equal(module.evict('A'), false)
  stop()
  assert.equal(module.evict('A'), true)
  const fresh = module.getSnapshot('A')
  resolve({ view: { old: true } }); await new Promise(r => setImmediate(r))
  assert.equal(module.getSnapshot('A'), fresh)
  assert.equal(fresh.view, null)
  const stopAgain = module.subscribe('A', () => {})
  await timers.runNext(); resolve({ view: { fresh: true } })
  await new Promise(r => setImmediate(r))
  assert.equal(module.getSnapshot('A').view.fresh, true)
  stopAgain(); module.evict('A')
})

test('无订阅快照十分钟回收，返回取消回收；事件驱动视图不启动空转看门狗', async () => {
  const timers = fakeTimers(); let watchdogs = 0
  const module = createLiveTavernViewModule({ load: async () => ({ view: { value: 1 } }),
    schedule: timers.schedule, cancel: timers.cancel, pollWhileBusy: false,
    cacheRetentionMs: 600000, startWatchdog: () => { watchdogs++; return 1 } })
  let stop = module.subscribe('A', () => {})
  await timers.runNext()
  const cached = module.getSnapshot('A')
  stop(); assert.deepEqual(timers.activeDelays(), [600000])
  stop = module.subscribe('A', () => {})
  assert.equal(module.getSnapshot('A'), cached)
  assert.deepEqual(timers.activeDelays(), [0])
  await timers.runNext()
  stop(); await timers.runNext()
  assert.equal(module.getSnapshot('A').view, null)
  assert.equal(watchdogs, 0)
})

test('冷启动 messagesPending 先发布骨架再补水，脚本门控前消息已满', async () => {
  const timers = fakeTimers()
  const phases = []
  let hydrateCalls = 0
  const module = createLiveTavernViewModule({
    load: async function () {
      return {
        view: {
          tavernHelper: {
            messages: [{ message_id: 0, message: '', stub: true }, { message_id: 1, message: 'recent' }],
            messagesPending: { from: 0, to: 0 }
          }
        }
      }
    },
    hydrateHelperMessages: async function (_sessionId, view) {
      hydrateCalls += 1
      const messages = view.tavernHelper.messages.slice()
      messages[0] = { message_id: 0, message: 'hydrated', variables: { hp: 1 } }
      const next = Object.assign({}, view.tavernHelper, { messages })
      delete next.messagesPending
      return Object.assign({}, view, { tavernHelper: next })
    },
    shouldPoll() { return false },
    pollWhileBusy: false,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-hydrate', function (state) { phases.push({ phase: state.phase, pending: !!(state.view && state.view.tavernHelper && state.view.tavernHelper.messagesPending), message: state.view && state.view.tavernHelper && state.view.tavernHelper.messages[0].message }) })
  await timers.runNext()
  await new Promise(function (resolve) { setImmediate(resolve) })
  stop()
  assert.equal(hydrateCalls, 1)
  assert.ok(phases.some(function (row) { return row.phase === 'ready' && row.pending === true && row.message === '' }))
  assert.equal(phases.at(-1).phase, 'ready')
  assert.equal(phases.at(-1).pending, false)
  assert.equal(phases.at(-1).message, 'hydrated')
  assert.equal(module.getSnapshot('session-hydrate').view.tavernHelper.messagesPending, undefined)
})

test('补水失败进入 retrying 并保留骨架，稍后可再试', async () => {
  const timers = fakeTimers()
  let hydrateCalls = 0
  const module = createLiveTavernViewModule({
    load: async function () {
      return {
        view: {
          tavernHelper: {
            messages: [{ message_id: 0, message: '', stub: true }],
            messagesPending: { from: 0, to: 0 }
          }
        }
      }
    },
    hydrateHelperMessages: async function () {
      hydrateCalls += 1
      throw new Error('补水失败')
    },
    shouldPoll() { return false },
    pollWhileBusy: false,
    schedule: timers.schedule,
    cancel: timers.cancel
  })
  const stop = module.subscribe('session-hydrate-fail', function () {})
  await timers.runNext()
  await new Promise(function (resolve) { setImmediate(resolve) })
  const snapshot = module.getSnapshot('session-hydrate-fail')
  assert.equal(hydrateCalls, 1)
  assert.equal(snapshot.phase, 'retrying')
  assert.match(snapshot.error, /补水失败/)
  assert.equal(snapshot.view.tavernHelper.messagesPending.from, 0)
  assert.deepEqual(timers.activeDelays(), [1500])
  stop()
})

test('脚本会话在 messagesPending 期间不同步 execution', async () => {
  const source = await readFile(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
  assert.match(source, /messagesPending/)
  assert.match(source, /hydrateTavernHelperMessages/)
  assert.match(source, /wait for hydration before scripts/)
})

test('opening window publishes recent content before full compatibility hydration even without Helper', async () => {
  const timers = fakeTimers(), seen = []
  let finish
  const full = new Promise(resolve => { finish = resolve })
  const module = createLiveTavernViewModule({
    load: async () => ({view:{historyWindow:{from:100,to:147,messageCount:148},text:'recent'}}),
    hydrateHelperMessages: async () => full,
    shouldPoll: () => false, pollWhileBusy:false,
    schedule:timers.schedule,cancel:timers.cancel
  })
  const stop = module.subscribe('window-no-helper', state => { if(state.phase==='ready')seen.push(state.view) })
  await timers.runNext()
  assert.equal(seen.at(-1).text,'recent')
  assert.ok(seen.at(-1).historyWindow)
  finish({text:'complete'})
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(seen.at(-1).text,'complete')
  assert.equal(seen.at(-1).historyWindow,undefined)
  stop()
})

test('on-demand history publishes ready without automatic complete hydration',async()=>{
 const timers=fakeTimers();let hydrations=0
 const module=createLiveTavernViewModule({load:async()=>({view:{historyWindow:{from:100},tavernHelper:{historyAccess:{token:'cap'}}}}),hydrateHelperMessages:async()=>{hydrations++;throw Error('full read forbidden')},shouldPoll:()=>false,pollWhileBusy:false,schedule:timers.schedule,cancel:timers.cancel})
 const stop=module.subscribe('lazy',()=>{})
 await timers.runNext()
 assert.equal(hydrations,0)
 assert.equal(module.getSnapshot('lazy').phase,'ready')
 stop()
})

test('native on-demand view without Helper also stays bounded',async()=>{
 const timers=fakeTimers()
 const module=createLiveTavernViewModule({load:async()=>({view:{historyWindow:{onDemand:true,from:100}}}),hydrateHelperMessages:async()=>{throw Error('unexpected complete read')},shouldPoll:()=>false,pollWhileBusy:false,schedule:timers.schedule,cancel:timers.cancel})
 const stop=module.subscribe('no-helper-demand',()=>{})
 await timers.runNext()
 assert.equal(module.getSnapshot('no-helper-demand').phase,'ready')
 stop()
})
