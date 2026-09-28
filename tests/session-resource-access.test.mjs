import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionResourceAccess } from '../tavern-plugin/lib/domain/session-resource-access.js'
import { helperHostHarness } from './fixtures/helper-host-harness.mjs'

test('capabilities read only their issued revision, deduplicate reads and reject tampering before storage', async () => {
  const calls = []
  const resources = createSessionResourceAccess({ read: async scope => { calls.push(scope); return { name: 'saved' } } })
  const access = resources.issue('chat', 7, 'card')
  assert.equal(calls.length, 0)
  const results = await Promise.all([resources.read(access.token), resources.read(access.token)])
  assert.equal(results[0], results[1])
  await resources.read(access.token)
  assert.deepEqual(calls, [{ chatId: 'chat', revision: 7, kind: 'card' }])
  const parts = access.token.split('.')
  parts[0] = Buffer.from(JSON.stringify({ chatId: 'other', revision: 8, kind: 'card' })).toString('base64url')
  await assert.rejects(resources.read(parts.join('.')), /capability/)
  await assert.rejects(createSessionResourceAccess({read: async () => assert.fail()}).read(access.token), /capability/)
  assert.equal(calls.length, 1)
})

test('unavailable resources retry and oversized results are not retained', async () => {
  let calls = 0
  const resources = createSessionResourceAccess({ maxBytes: 1, read: async () => ++calls === 1 ? undefined : {name: 'large'} })
  const access = resources.issue('chat', 3, 'worldbook')
  await assert.rejects(resources.read(access.token), /unavailable/)
  await resources.read(access.token)
  await resources.read(access.token)
  assert.equal(calls, 3)
})

test('script startup and card metadata stay light; legacy complete card APIs load once and isolate mutations', () => {
  let calls = 0
  const card = {name: '大卡', character_book: { entries: [{ content: 'setting' }] }}
  const run = helperHostHarness({character: {name: '大卡'}, characterResourceAccess: {token:'card',kind:'card',revision:1}}, {
    XMLHttpRequest: class {
      open(method, url, async) { assert.equal(method, 'GET'); assert.equal(new URL(url).searchParams.get('cap'), 'card'); assert.equal(async, false) }
      send() { calls++; this.status = 200; this.responseText = JSON.stringify({kind:'card',revision:1,value:card}) }
    }
  })
  assert.equal(calls, 0)
  assert.equal(run.window.SillyTavern.characterId, 0)
  const first = run.window.getCharData()
  assert.equal(first.character_book.entries[0].content, 'setting')
  first.character_book.entries[0].content = 'mutated'
  assert.equal(run.window.SillyTavern.characters[0].data.character_book.entries[0].content, 'setting')
  assert.equal(run.window.SillyTavern.getCharacterCardFields().character_book.entries[0].content, 'setting')
  assert.equal(calls, 1)
})

test('worldbook names need no download; concurrent explicit reads share a download and return isolated entries', async () => {
  let calls = 0
  const run = helperHostHarness({worldbook:{name:'书',resourceAccess:{token:'book',kind:'worldbook',revision:2}}}, {
    fetch: async () => { calls++; return {ok:true,json:async () => ({kind:'worldbook',revision:2,value:{name:'书',entries:[{uid:1,content:'saved'}]}})} }
  })
  assert.equal(run.window.getCharWorldbookNames().primary, '书')
  assert.equal(calls, 0)
  const [a, b] = await Promise.all([run.window.getWorldbook('current'), run.window.getWorldbook('书')])
  a[0].content = 'modified'
  assert.equal(b[0].content, 'saved')
  assert.equal((await run.window.getWorldbook('书'))[0].content, 'saved')
  assert.equal(calls, 1)
})

test('an old worldbook download cannot overwrite a newly installed context', async () => {
  let finish
  const run = helperHostHarness({worldbook:{name:'书',resourceAccess:{token:'old',kind:'worldbook',revision:1}}}, {
    fetch: async () => ({ok:true,json:() => new Promise(resolve => { finish = resolve })})
  })
  const pending = run.window.getWorldbook('书')
  await new Promise(resolve => setImmediate(resolve))
  run.receive({type:'dsh-tavern-helper-context',context:{worldbook:{name:'书',entries:[{uid:1,content:'new'}]}}})
  finish({kind:'worldbook',revision:1,value:{name:'书',entries:[{uid:1,content:'old'}]}})
  assert.equal((await pending)[0].content, 'old')
  assert.equal((await run.window.getWorldbook('书'))[0].content, 'new')
})
