import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createServerTemplateSync} from '../tavern-plugin/lib/domain/server-template-sync.js'

test('failed display work is not retried on repeated reads of the same revision',async t=>{
 let runs=0,errors=0
 const sync=createServerTemplateSync({delayMs:1,run:async()=>{runs++;throw Error('template failed')},onError:()=>errors++})
 t.after(()=>sync.dispose());sync.schedule('s',1);await delay(10)
 sync.schedule('s',1);await delay(10);assert.equal(runs,1);assert.equal(errors,1)
 sync.schedule('s',2);await delay(10);assert.equal(runs,2)
})
test('deferred settlement work retries, disposal cancels pending timers',async()=>{
 let runs=0
 const sync=createServerTemplateSync({delayMs:1,run:async()=>({deferred:++runs===1})})
 sync.schedule('s',1);await delay(20);assert.equal(runs,2)
 sync.schedule('s',2);sync.dispose();await delay(10);assert.equal(runs,2)
})

test('settlement blocks display polling until a new idle revision arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0
  const sync = createServerTemplateSync({ run: async () => { runs++ } })
  t.after(() => sync.dispose())
  sync.schedule('s', 1, { blocked: true })
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(250); await Promise.resolve() }
  assert.equal(runs, 0, 'settlement must not repeatedly enter the template reader')
  sync.schedule('s', 2, { blocked: false })
  t.mock.timers.tick(250); await Promise.resolve()
  assert.equal(runs, 1)
})

test('entering settlement cancels a pending retry and blocks a running callback from rearming', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0, release
  const sync = createServerTemplateSync({ run: () => { runs++; return new Promise(resolve => { release = resolve }) } })
  t.after(() => sync.dispose())
  sync.schedule('s', 1)
  t.mock.timers.tick(250)
  sync.schedule('s', 2, { blocked: true })
  release({ deferred: true }); await Promise.resolve()
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(250); await Promise.resolve() }
  assert.equal(runs, 1)
  sync.schedule('s', 3)
  t.mock.timers.tick(250)
  release({ deferred: true }); await Promise.resolve()
  sync.schedule('s', 4, { blocked: true })
  t.mock.timers.tick(5000); await Promise.resolve()
  assert.equal(runs, 2)
  sync.schedule('s', 4, { blocked: false })
  t.mock.timers.tick(250)
  assert.equal(runs, 3, 'unblocking the same revision still wakes work')
  release({}); await Promise.resolve()
})

test('disabling a conversation prevents an in-flight deferral from resurrecting its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0, release
  const sync = createServerTemplateSync({ run: () => { runs++; return new Promise(resolve => { release = resolve }) } })
  t.after(() => sync.dispose())
  sync.schedule('s', 1); t.mock.timers.tick(250)
  sync.schedule('s', 2, { enabled: false })
  release({ deferred: true }); await Promise.resolve()
  t.mock.timers.tick(10000); await Promise.resolve()
  assert.equal(runs, 1)
})

test('metadata-only revisions do not requeue display from subsequent views or discard pending work',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let runs=0
 const sync=createServerTemplateSync({run:async()=>{runs++}})
 t.after(()=>sync.dispose())
 sync.schedule('s',1);sync.unchanged('s',2)
 t.mock.timers.tick(250);await Promise.resolve()
 assert.equal(runs,1)
 sync.unchanged('s',3);sync.schedule('s',3)
 t.mock.timers.tick(250);await Promise.resolve()
 assert.equal(runs,1)
 sync.unchanged('s',5);sync.schedule('s',5)
 t.mock.timers.tick(250);await Promise.resolve()
 assert.equal(runs,2,'a gap may hide a real edit and must refresh')
})
