import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
const create = vm.runInNewContext(readFileSync(new URL('../tavern-plugin/src/client/modules/session-resource-retention.js', import.meta.url), 'utf8') + ';createTavernSessionRetention')
function fixture() {
  let now = 0, sequence = 0
  const timers = new Map(), released = []
  const cache = create({ now: () => now, window: {
    setTimeout(fn, ms) { timers.set(++sequence, { fn, at: now + ms }); return sequence }, clearTimeout(id) { timers.delete(id) },
  } })
  return { cache, timers, released, hold(id, type) { return cache.hold(id, type, () => released.push(id + ':' + type)) },
    advance(ms) { now += ms; for (const [id,timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() } } }
}
test('会话切走保留10分钟，返回取消旧计时，下次离开重新计时', () => {
  const h = fixture(); h.cache.select('A'); h.hold('A','iframe'); h.hold('A','scripts')
  h.cache.select('B'); h.advance(599999); assert.equal(h.released.length,0)
  h.cache.select('A'); h.advance(600000); assert.equal(h.released.length,0)
  h.cache.select('B'); h.advance(599999); assert.equal(h.released.length,0)
  h.advance(1); assert.deepEqual(h.released,['A:iframe','A:scripts']); assert.equal(h.timers.size,0)
})
test('生成或结算跨过10分钟时不释放，完成后才释放；活动会话始终保留', () => {
  const h = fixture(); h.cache.select('A'); h.hold('A','scripts'); h.cache.busy('A',true)
  h.cache.select('B'); h.advance(600000); assert.equal(h.released.length,0)
  h.cache.busy('A',false); h.advance(0); assert.deepEqual(h.released,['A:scripts'])
  h.hold('B','iframe'); h.advance(600000); assert.equal(h.released.length,1)
})
test('React卸载不释放页面，离开后新建其他资源不能延后原截止时间', () => {
  const h = fixture(), unmount = h.cache.mount('A'); h.hold('A','iframe'); unmount()
  h.advance(500000); h.hold('A','status'); h.advance(100000)
  assert.deepEqual(h.released,['A:iframe','A:status'])
})
test('显式清理释放全部资源和定时器，旧清理回调不影响同名新会话', () => {
  const h = fixture(), forget = h.hold('A','iframe')
  h.cache.clear(); h.hold('A','iframe'); forget()
  h.advance(600000); assert.deepEqual(h.released,['A:iframe','A:iframe']); assert.equal(h.timers.size,0)
})

test('到期回调重新检查刚开始的脚本任务，不用上次空闲快照回收它', () => {
  const h = fixture(); let busy = false
  h.cache.select('A'); h.hold('A','scripts'); h.cache.busy('A', () => busy)
  h.cache.select('B'); busy = true; h.advance(600000)
  assert.equal(h.released.length,0)
  busy = false; h.cache.busy('A', () => busy); h.advance(0)
  assert.deepEqual(h.released,['A:scripts'])
})

const source = readFileSync(new URL('../tavern-plugin/src/client/main.js', import.meta.url), 'utf8')
const scopeSource = source.slice(source.indexOf('function createTavernHostArtifactScope(options)'), source.indexOf('const TAVERN_CARD_PHONE_HOST'))
test('后台手机脚本延迟查询仍能绑定事件和设置样式，不操作前台同名按钮', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(readFileSync(new URL('../tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js', import.meta.url), 'utf8'))
    dom.window.eval(scopeSource + ';window.makeScope=createTavernHostArtifactScope')
    const a = dom.window.makeScope({ document: dom.window.document })
    const $a = a.bindJQuery(dom.window.jQuery)
    a.setVisible(false)
    $a('body').append($a('<button>', { id: 'mobile-trigger-btn', text: 'A' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    // mobile-phone.js binds at 0 ms and resets the position at 100 ms.
    let clicks = 0
    $a('#mobile-trigger-btn')[0].addEventListener('click', () => clicks++)
    $a('#mobile-trigger-btn')[0].style.removeProperty('left')
    assert.equal(dom.window.document.querySelector('#mobile-trigger-btn'), null)
    const b = dom.window.makeScope({ document: dom.window.document })
    const $b = b.bindJQuery(dom.window.jQuery)
    assert.equal($b('#mobile-trigger-btn').length, 0)
    $b('body').append('<button id="mobile-trigger-btn">B</button>')
    assert.equal($a('#mobile-trigger-btn').text(), 'A')
    assert.equal($a('body').find('#mobile-trigger-btn').text(), 'A')
    assert.equal($a('body #mobile-trigger-btn').text(), 'A')
    assert.equal($b('#mobile-trigger-btn').text(), 'B')
    b.setVisible(false); a.setVisible(true)
    $a('#mobile-trigger-btn').trigger('click')
    assert.equal(clicks, 1)
    assert.equal(dom.window.document.querySelector('#mobile-trigger-btn').textContent, 'A')
    a.setVisible(false)
    $a('#mobile-trigger-btn').remove()
    a.setVisible(true)
    assert.equal(dom.window.document.querySelector('#mobile-trigger-btn'), null)
    a.dispose(); b.dispose()
  } finally { dom.window.close() }
})
test('native host nodes created after the script scope are never parked or removed', async () => {
  const {JSDOM}=await import('jsdom')
  const dom=new JSDOM('<body></body>',{runScripts:'outside-only'})
  try {
    dom.window.eval(scopeSource+';window.makeScope=createTavernHostArtifactScope')
    const scope=dom.window.makeScope({document:dom.window.document})
    const menu=dom.window.document.createElement('div');menu.id='native-navigation-menu'
    dom.window.document.body.append(menu)
    scope.setVisible(false)
    assert.equal(menu.isConnected,true)
    scope.setVisible(true);scope.dispose()
    assert.equal(menu.isConnected,true)
  }finally{dom.window.close()}
})

test('切走后异步创建或重新插入的卡片悬浮窗保持隔离，返回保留事件与状态', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><body><main id="app"></main></body>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(readFileSync(new URL('../tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js', import.meta.url), 'utf8'))
    dom.window.eval(scopeSource + ';window.makeScope=createTavernHostArtifactScope')
    const a = dom.window.makeScope({ document: dom.window.document })
    const $ = a.bindJQuery ? a.bindJQuery(dom.window.jQuery) : dom.window.jQuery
    a.setVisible(false)
    // Same host-jQuery mounting pattern as the card's external-status-bar.js,
    // after an asynchronous import finishes in the retained background runtime.
    const button = $('<button id="rpg_status_bar-toggle">A</button>')
    let clicks = 0
    button.on('click', () => clicks++)
    $('body').append(button)
    const other = dom.window.document.createElement('button'); other.id = 'other-card'
    dom.window.document.body.append(other)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(dom.window.document.querySelector('#rpg_status_bar-toggle'), null)
    assert.equal(other.isConnected, true)
    a.setVisible(true)
    button.trigger('click'); assert.equal(clicks, 1)
    assert.equal(dom.window.document.querySelector('#rpg_status_bar-toggle'), button[0])
    a.setVisible(false)
    dom.window.document.body.append(button[0])
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(button[0].isConnected, false)
    a.dispose(); assert.equal(other.isConnected, true)
    $("body").append("<button id=retired>late</button>")
    assert.equal(dom.window.document.querySelector("#retired"), null)
  } finally { dom.window.close() }
})


test('explicitly created host nodes are parked before observer delivery and on delayed mount', async () => {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(scopeSource + ';window.makeScope=createTavernHostArtifactScope')
    const scope = dom.window.makeScope({ document: dom.window.document })
    const button = scope.trackNode(dom.window.document.createElement('button'))
    dom.window.document.body.append(button)
    scope.setVisible(false)
    assert.equal(button.isConnected, false)
    const delayed = scope.trackNode(dom.window.document.createElement('div'))
    dom.window.document.body.append(delayed)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(delayed.isConnected, false)
    scope.setVisible(true)
    assert.equal(button.isConnected, true)
    assert.equal(delayed.isConnected, true)
    scope.dispose()
    assert.equal(button.isConnected, false)
    assert.equal(delayed.isConnected, false)
  } finally { dom.window.close() }
})
