import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const source = await readFile(new URL('../tavern-plugin/src/client/helper-model.js', import.meta.url), 'utf8')
const install = vm.runInNewContext(source + '; installTavernBackgroundModel', { URL, Object, Promise, JSON, Proxy, WeakSet })
function setup(request = async () => ({ text: 'neutral reply' })) {
  const dom = new JSDOM('<body></body>', { url: 'https://host.invalid' })
  const window = dom.window
  window.Response = Response
  let forwarded = 0
  window.fetch = async () => { forwarded++; return new Response('asset') }
  install({ window, request })
  return { window, close: () => window.close(), forwarded: () => forwarded }
}
test('completion fetch routes messages to host, returns JSON/SSE, and leaves asset fetch alone', async () => {
  const calls = []
  const env = setup(async (...args) => { calls.push(args); return { text: 'neutral reply' } })
  try {
    for (const stream of [false, true]) {
      const response = await env.window.fetch('https://external.invalid/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer private' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], stream }) })
      if (stream) assert.match(await response.text(), /data: \[DONE\]/)
      else assert.equal((await response.json()).choices[0].message.content, 'neutral reply')
    }
    assert.equal(calls.length, 2)
    assert.equal(calls[0][0], 'generateTavernHelperRaw')
    assert.ok(!JSON.stringify(calls).includes('private'))
    assert.equal(await (await env.window.fetch('https://external.invalid/image.png')).text(), 'asset')
    assert.equal(env.forwarded(), 1)
    const abort = new AbortController(); abort.abort()
    await assert.rejects(env.window.fetch('https://external.invalid/v1/chat/completions', { signal: abort.signal }), { name: 'AbortError' })
    assert.equal(calls.length, 2)
  } finally { env.close() }
})
test('legacy channel connection is automatic while stored settings and feature switches survive', async () => {
  const env = setup()
  try {
    const original = { apiUrl: 'https://old.invalid', apiKey: 'saved', model: 'old', enabled: false, autoGen: { enabled: false } }
    const channel = { settings: structuredClone(original) }
    env.window.phoneAPI = { chat: channel }
    assert.equal(channel.settings.model, '本局后台模型')
    assert.equal(channel.settings.enabled, false)
    assert.deepEqual(JSON.parse(JSON.stringify(channel.settings)), original)
    channel.settings.apiKey = 'host-managed'
    assert.deepEqual(JSON.parse(JSON.stringify(channel.settings)), original)
    channel.settings.enabled = true
    assert.equal(channel.settings.enabled, true)
    assert.equal(channel.settings.autoGen.enabled, false)
    channel.settings = { ...original, temperature: 0.6 }
    assert.equal(channel.settings.model, '本局后台模型')
    env.window.document.body.innerHTML = '<div><div><input id="yq-api-url"></div><div><input id="yq-api-key"></div><div><input id="yq-api-model"></div><input id="yq-api-autogen" type="checkbox"></div>'
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(env.window.document.querySelector('#yq-api-url').parentElement.hidden, true)
    assert.equal(env.window.document.querySelectorAll('[data-dsh-background-model]').length, 0)
    assert.equal(env.window.document.querySelector('#yq-api-autogen').hidden, false)
  } finally { env.close() }
})
