import { helperLoaderSource, helperLoaderBootstrap } from './fixtures/helper-loader-source.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

let descriptor
vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(value) { descriptor = value } } }, console
})
const client = descriptor.factory(() => ({}))

function loader(scripts) {
  const html = client.buildTavernHelperScriptDocument({ token: 'test', scripts, context: {} })
  return helperLoaderSource(html)
}

test('脚本宿主的固定运行时依赖全部使用随包本地资源', () => {
  const html = client.buildTavernHelperScriptDocument({ token: 'test', scripts: [], context: {} })
  for (const path of [
    'vue/vue.runtime.global.prod.js', 'vue-router/vue-router.global.prod.js',
    'jquery/jquery.min.js', 'lodash/lodash.min.js', 'zod/index.mjs', 'yaml/index.mjs'
  ]) assert.ok(html.includes('/api/dsh-tavern/vendor/runtime-assets/' + path), path)
  assert.match(html, /window\.YAML\s*=\s*modules\[1\]/)
  assert.doesNotMatch(html, /(?:testingcf\.)?cdn\.jsdelivr\.net\/npm\/(?:zod|yaml|vue|vue-router|jquery|lodash)@/)
})

function harness(scripts, onAppend, ready = Promise.resolve()) {
  const listeners = new Set(), events = [], elements = []
  let context
  const window = {
    __dshTavernHelperReady: ready,
    // Use the production wait wrapper without arming diagnostic timers in this harness.
    __dshTavernInitializationTiming: client.createTavernInitializationTiming({ schedule: () => null, cancel: () => {} }),
    __dshTavernHelperSetCurrentScript(id) { events.push(['start', id]) },
    __dshTavernHelperSubscriptionsReady(id) { events.push(['ready', id]) },
    __dshTavernHelperSubscriptionsFailed(id, error) { events.push(['failed', id, error.message, ...(error.dshTavernModuleFailure ? [error.dshTavernModuleFailure] : [])]) },
    __dshTavernResolveCompanionScriptsReady() { events.push(['done']) },
    waitGlobalInitialized: async name => { events.push(['global', name]) },
    addEventListener(name, handler) { assert.equal(name, 'error'); listeners.add(handler) },
    removeEventListener(name, handler) { listeners.delete(handler) }
  }
  const document = {
    // Composer controls are preinstalled; this harness exercises module loading.
    getElementById(id) { return ['send_textarea', 'send_but'].includes(id) ? {} : null },
    createElement(tag) {
      assert.equal(tag, 'script')
      const element = { remove() { this.removed = true } }
      elements.push(element)
      return element
    },
    body: { appendChild(element) {
      assert.equal(element.type, 'module')
      assert.equal(element.src, undefined, 'Card module must inherit the document base, not data/blob URL')
      const footer = element.textContent.split("\n").find(line => line.startsWith(";window["))
      const complete = () => vm.runInContext(footer, context)
      onAppend({ element, complete, listeners, events })
    } }
  }
  context = vm.createContext({ window, document, console, URL })
  return { window, events, elements, listeners,
    run: () => vm.runInContext('(async()=>{' + loader(scripts) + '})()', context) }
}

test('卡片 import 原文进入页面模块，支持具名、动态、重导出且不改字符串和注释', async () => {
  const source = `import value, { registerMvuSchema as register } from '/api/dsh-tavern/remote-assets/hash/mvu_zod.js';
import * as namespace from '/api/dsh-tavern/remote-assets/hash/mvu_zod.js';
export { x } from '/api/dsh-tavern/remote-assets/hash/child.js';
const path = '/api/dsh-tavern/remote-assets/hash/child.js'; await import(path);
const text = "import '/api/dsh-tavern/remote-assets/not-code.js'";
// import '/api/dsh-tavern/remote-assets/not-code.js'
// Unicode and markup must survive: 玩家 </script>`
  const run = harness([{ id: 'schema', content: source }], ({ element, complete }) => {
    assert(element.textContent.includes('\n' + source + '\n;window['))
    complete()
  })
  await run.run()
  assert.deepEqual(run.events, [['start', 'schema'], ['ready', 'schema'], ['done']])
  assert.equal(run.listeners.size, 0)
  assert(run.elements.every(element => element.removed))
  assert(!Object.keys(run.window).some(key => key.startsWith('__dshTavernModuleComplete_')))
})

test('模块等待 bootstrap 与前一个脚本完成，官方核心就绪后才开始配套脚本', async () => {
  let releaseReady, completeCore
  const ready = new Promise(resolve => { releaseReady = resolve })
  const run = harness([{ id: 'core', system: 'official-mvu', content: 'await core()' }, { id: 'schema', content: 'register()' }], ({ complete }) => {
    if (!completeCore) completeCore = complete
    else complete()
  }, ready)
  const pending = run.run()
  assert.equal(run.elements.length, 0)
  releaseReady()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(run.elements.length, 1)
  assert.deepEqual(run.events, [['start', 'core']])
  completeCore()
  await pending
  assert.deepEqual(run.events, [['start', 'core'], ['global', 'Mvu'], ['ready', 'core'], ['start', 'schema'], ['ready', 'schema'], ['done']])
})

test('官方核心执行失败停止配套脚本，不能部分初始化后继续写入', async () => {
  const run = harness([{ id: 'core', system: 'official-mvu', content: 'bad' }, { id: 'schema', content: 'write()' }], ({ element }) => {
    element.onerror({ message: 'partial execution' })
  })
  await run.run()
  assert.equal(run.elements.length, 1)
  assert.deepEqual(run.events, [['start', 'core'], ['failed', 'core', 'partial execution'], ['done']])
})

test('模块加载、执行和插入失败均清理监听并继续下一脚本', async () => {
  for (const kind of ['load', 'execute', 'append']) {
    let index = 0
    const run = harness([{ id: 'bad', content: 'bad' }, { id: 'good', content: 'good' }], ({ element, complete, listeners }) => {
      if (index++ > 0) return complete()
      if (kind === 'load') element.onerror({ message: 'missing dependency' })
      else if (kind === 'execute') for (const listener of listeners) listener({ error: new Error('bad script') })
      else throw new Error('append failed')
    })
    await run.run()
    assert.equal(run.events[1][0], 'failed')
    assert.deepEqual(run.events.slice(2), [['start', 'good'], ['ready', 'good'], ['done']])
    assert.equal(run.listeners.size, 0)
    assert(run.elements.every(element => element.removed))
    assert(!Object.keys(run.window).some(key => key.startsWith('__dshTavernModuleComplete_')))
  }
})

test('前一个脚本的迟到异常不使正在加载的样式模块失败', async () => {
  const run = harness([{ id: 'style', content: 'await style()' }], ({ complete, listeners }) => {
    for (const listener of [...listeners]) listener({ filename: 'dsh-tavern-script:previous', error: new Error('previous callback') })
    assert.doesNotThrow(complete)
  })
  await run.run()
  assert.deepEqual(run.events, [['start', 'style'], ['ready', 'style'], ['done']])
})


test('不透明模块加载失败给出行动提示和脱敏详情，不冒充网络故障', async () => {
  const run = harness([{id:'schema',content:"import 'https://cdn.example/schema.js?token=PRIVATE';"}], ({element}) => element.onerror({}));
  await run.run();
  const failure=run.events.find(e=>e[0]==='failed');
  assert.match(failure[2], /检查网络|查看详情/);
  assert.equal(failure[3].reason, 'unknown');
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE/);
  assert.equal(run.elements.length, 1, '不得自动重跑模块');
});

test('离线仅在模块下载错误时提示检查网络，执行错误保持原义', async () => {
  const run = harness([{id:'schema',content:'import "https://cdn.example/a.js";'}], ({element}) => element.onerror({}));
  run.window.navigator={onLine:false};
  await run.run();
  const failure=run.events.find(e=>e[0]==='failed');
  assert.equal(failure[3].reason,'offline');
  assert.match(failure[2], /离线/);
  const executed = harness([{id:'schema',content:'throw Error()'}], ({listeners}) => {
    for(const fn of listeners) fn({error:new Error('schema invalid')});
  });
  executed.window.navigator={onLine:false};
  await executed.run();
  assert.equal(executed.events[1][2],'schema invalid');
});


test('浏览器可见的入口 HTTP 错误保留状态，过滤历史资源与秘密查询参数', async () => {
 const run=harness([{id:'schema',content:"import 'https://cdn.example/schema.js?token=PRIVATE';"}],({element})=>element.onerror({}));
 run.window.performance={now:()=>10,getEntriesByType:()=>[
  {name:'https://cdn.example/schema.js?token=PRIVATE',startTime:11,initiatorType:'script',responseStatus:503},
  {name:'https://cdn.example/old.js',startTime:1,initiatorType:'script',responseStatus:404}
 ]};
 await run.run();
 const failure=run.events.find(e=>e[0]==='failed')[3];
 assert.equal(failure.reason,'http');
 assert.equal(failure.resources.length,1);
 assert.equal(failure.resources[0].status,503);
 assert.equal(failure.references[0],'https://cdn.example/schema.js');
 assert.doesNotMatch(JSON.stringify(failure),/PRIVATE|old.js/);
});


test('动态 import 网络错误保留行动提示，原始地址查询参数不泄漏', async () => {
 const run=harness([{id:'schema',content:'await import(url)'}],({listeners})=>{
  for(const fn of listeners) fn({error:new TypeError('Failed to fetch dynamically imported module: https://cdn.example/a.js?token=PRIVATE')});
 });
 await run.run();
 const failure=run.events.find(e=>e[0]==='failed');
 assert.equal(failure[3].phase,'module-load');
 assert.match(failure[2],/查看详情/);
 assert.doesNotMatch(JSON.stringify(failure),/PRIVATE/);
});

test('large Unicode script loading stays within a bounded heap and preserves source', async () => {
  const {execFile} = await import('node:child_process')
  const {promisify} = await import('node:util')
  const result = await promisify(execFile)(process.execPath, ['--max-old-space-size=256', new URL('./fixtures/helper-large-script-loading.mjs', import.meta.url).pathname], {timeout:30000,maxBuffer:4096})
  assert.match(result.stdout,/PASS large Unicode script roundtrip/)
})

test('Blob loader preserves Unicode and script-closing text', () => {
  const content='😀中文\u2028\u2029</script><script>throw Error("escaped")</script>'
  const html=client.buildTavernHelperScriptDocument({scripts:[{id:'unicode',content}],context:{}})
  const source=helperLoaderSource(html)
  assert.equal(JSON.parse(source.match(/const scripts=([\s\S]*);\nconst token=/)[1])[0].content,content)
  assert.doesNotMatch(html, /data:text\/javascript;base64/)
  assert.doesNotMatch(helperLoaderBootstrap(html), /<script>/)
})

test('Blob loader releases its URL on success, failure and frame disposal', async () => {
  for (const outcome of ['success','failure','dispose']) {
    let settle, listener, blob, created=0, released=0
    const pending=new Promise((resolve,reject)=>{settle=()=>outcome==='failure'?reject(new Error('module failed')):resolve()})
    const html=client.buildTavernHelperScriptDocument({scripts:[],context:{}})
    const result=vm.runInNewContext(helperLoaderBootstrap(html).replace('import(url)', 'load(url)'), {
      Blob, URL:{createObjectURL(value){blob=value;created++;return 'blob:test'},revokeObjectURL(url){assert.equal(url,'blob:test');released++}},
      window:{addEventListener(type,fn){assert.equal(type,'pagehide');listener=fn},removeEventListener(type,fn){assert.equal(fn,listener)}},
      load(url){assert.equal(url,'blob:test');return pending}
    })
    assert.equal(created,1)
    assert.equal(await blob.text(),helperLoaderSource(html))
    assert.equal(released,0)
    if(outcome==='dispose')listener()
    settle()
    if(outcome==='failure')await assert.rejects(result,/module failed/)
    else await result
    assert.equal(released,1)
  }
})
