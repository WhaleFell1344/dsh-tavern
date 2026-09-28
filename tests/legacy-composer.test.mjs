import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { helperClient } from './fixtures/helper-host-harness.mjs'

function mount(send, managed = false) {
  const nodes = []
  function element() {
    return { value: '', append(...items) { nodes.push(...items) }, setAttribute() {}, addEventListener(name, fn) { this[name] = fn } }
  }
  const document = { body: element(), createElement: element, getElementById(id) { return nodes.find(n => n.id === id) } }
  const html = helperClient.buildTavernFrameDocument({ token: 'send', content: '<p>opening</p>', helperContext: { messages: [] } })
  const source = html.match(/<script data-dsh-tavern-legacy-composer>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(source)
  vm.runInNewContext(source, { document, window: managed ? { submitTavernInput: send } : { triggerSlash: send }, console: { error() {} } })
  return { nodes, area: document.getElementById('send_textarea'), button: document.getElementById('send_but') }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('legacy DOM send preserves multiline payload and prevents duplicate submission', async () => {
  const calls = []; let finish
  const { area, button } = mount(line => { calls.push(line); return new Promise(resolve => { finish = resolve }) })
  area.value = '请开始故事\n{"name":"林州","value":"a|b"}'
  button.click(); button.click()
  await tick()
  assert.deepEqual(calls, ['/send ' + area.value + '|/trigger'])
  assert.equal(button.disabled, true)
  finish({ submitted: true }); await tick()
  assert.equal(area.value, '')
  assert.equal(button.disabled, false)
})

test('failed legacy send retains payload, displays failure and permits retry', async () => {
  const { nodes, area, button } = mount(() => Promise.reject(new Error('发送失败')))
  area.value = '开始故事'; button.click(); await tick()
  assert.equal(area.value, '开始故事')
  assert.equal(button.disabled, false)
  assert.ok(nodes.some(n => /开局消息发送失败/.test(n.textContent)))
})

test('preparation composer owns parent controls, submits once and ignores detached controls', async () => {
  const nodes = [], calls = []; let finish
  function element() { return { value: '', append(...items) { nodes.push(...items) }, remove() { this.removed = true }, addEventListener(name, fn) { this[name] = fn } } }
  const document = { body: element(), createElement: element, getElementById: id => nodes.find(n => n.id === id) }
  const release = helperClient.installOpeningHostComposer(document, text => { calls.push(text); return new Promise(resolve => { finish = resolve }) }, assert.fail)
  const area = document.getElementById('send_textarea'), button = document.getElementById('send_but')
  area.value = '建立角色\n名字：旅人 | 中立'; button.click(); button.click(); await tick()
  assert.deepEqual(calls, [area.value])
  finish(); await tick(); button.click(); await tick()
  assert.equal(calls.length, 1)
  release(); area.value = '过期开场'; button.click(); await tick()
  assert.equal(calls.length, 1)
})

test('legacy input event fills the real composer without triggering generation', async () => {
  const calls = []
  const { area } = mount(line => { calls.push(line); return Promise.resolve() })
  area.value = '开场引导\n原样保留 | /trigger'
  area.input(); await tick()
  assert.deepEqual(calls, ['/setinput ' + area.value])
})

test('parent composer routes to the focused card, survives replacement and releases owners', async () => {
  const nodes = [], calls = [], errors = [];
  function element() { return { value: '', append(...items) { nodes.push(...items) }, remove() { this.removed = true }, addEventListener(name, fn) { this[name] = fn } } }
  const doc = { body: element(), createElement: element, getElementById: id => nodes.find(n => n.id === id) };
  const a = {}, b = {};
  let finish;
  const releaseA = helperClient.installFrameHostComposer(doc, n => n === a, text => { calls.push(['A', text]); return new Promise(r => { finish = r }) }, e => errors.push(e.message));
  const releaseB = helperClient.installFrameHostComposer(doc, n => n === b, text => { calls.push(['B', text]); throw new Error('失败可重试') }, e => errors.push(e.message));
  const area = doc.getElementById('send_textarea'), button = doc.getElementById('send_but');
  doc.activeElement = a; area.value = '开始\n姓名 | /trigger'; button.click(); button.click();
  doc.activeElement = b; await tick();
  assert.deepEqual(calls, [['A', '开始\n姓名 | /trigger']]);
  finish(); await tick();
  area.value = 'B 的开局'; button.click(); await tick();
  assert.deepEqual(errors, ['失败可重试']); assert.equal(area.value, 'B 的开局');
  button.click(); await tick(); assert.equal(calls.length, 3);
  releaseB(); assert.throws(() => button.click(), /无法确定/);
  doc.activeElement = a; area.value = '已经卸载'; button.click(); releaseA(); await tick();
  assert.equal(calls.length, 3); assert.ok(errors.includes('卡片已关闭，请重新打开'));
});

test('shared sandbox composer sends exact text once without replacing the user draft', async () => {
  const calls = []; let finish
  const { area, button } = mount(text => { calls.push(text); return new Promise(resolve => { finish = resolve }) }, true)
  area.value = 'A neutral opening\nLiteral | /cut is text.'
  area.input(); await tick(); assert.equal(calls.length, 0)
  button.click(); button.click(); await tick()
  assert.deepEqual(calls, [area.value])
  finish({submitted:true}); await tick()
  assert.equal(area.value, '')
})


test('parent and top DOM composer APIs submit exact text to their own sandbox', async () => {
  const { JSDOM } = await import('jsdom')
  const host = new JSDOM('<p id="host-content">host</p>')
  const calls = []
  for (const [id, script] of [
    ['A', `const arbitraryDocument = parent.document; arbitraryDocument.getElementById('send_textarea').value = 'Neutral A | /cut'; arbitraryDocument.getElementById('send_but').click();`],
    ['B', `const target = window.top.document.querySelector('#send_textarea'); target.value = 'Neutral B'; window.parent.document.querySelectorAll('#send_but')[0].click();`]
  ]) {
    const frame = new JSDOM('<body></body>')
    const w = frame.window
    w.submitTavernInput = async text => calls.push([id, text])
    const html = helperClient.buildTavernFrameDocument({token:'test', content:'', helperContext:{messages:[]}})
    vm.runInNewContext(html.match(/<script data-dsh-tavern-legacy-composer>([\s\S]*?)<\/script>/)[1], {window:w, document:w.document})
    const scope = helperClient.createTavernComposerWindow ? helperClient.createTavernComposerWindow(w, host.window) : {parent:host.window, top:host.window}
    vm.runInNewContext(script, {window:scope, parent:scope.parent})
    assert.equal(scope.parent.document.getElementById('host-content'), host.window.document.getElementById('host-content'))
    await tick()
    frame.window.close()
  }
  assert.deepEqual(calls, [['A', 'Neutral A | /cut'], ['B', 'Neutral B']])
  assert.equal(host.window.document.getElementById('send_but'), null)
  host.window.close()
})

test('jQuery composer selection and parent-document find use the local controls', async () => {
  const { JSDOM } = await import('jsdom')
  const { readFile } = await import('node:fs/promises')
  const host = new JSDOM('<p id="ordinary">host</p>', {runScripts:'outside-only'})
  const frame = new JSDOM('<textarea id="send_textarea"></textarea><button id="send_but"></button>')
  host.window.eval(await readFile(new URL('../tavern-plugin/lib/vendor/runtime-assets/jquery/jquery.min.js', import.meta.url),'utf8'))
  frame.window.jQuery = host.window.jQuery
  const scope = helperClient.createTavernComposerWindow(frame.window,host.window)
  const jq = scope.jQuery
  jq('#send_textarea').val('neutral')
  assert.equal(frame.window.document.querySelector('textarea').value,'neutral')
  assert.equal(jq(scope.parent.document).find('#send_but')[0],frame.window.document.querySelector('button'))
  assert.equal(jq('#ordinary',scope.parent.document)[0],host.window.document.querySelector('p'))
  assert.equal(jq.fn,host.window.jQuery.fn)
  host.window.close(); frame.window.close()
})
