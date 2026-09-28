import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectCardExtensions } from '../tavern-plugin/lib/domain/card-extension-reading.js'

test('读取人物卡正则和 Tavern Helper 脚本，但不执行脚本', () => {
  const card = {
    spec: 'chara_card_v3',
    data: {
      name: '灯火阑珊',
      extensions: {
        regex_scripts: [{
          id: 'regex-1', scriptName: '状态栏', findRegex: '/<status>(.*?)<\\/status>/s', replaceString: '<aside>$1</aside>',
          placement: [2], disabled: false, markdownOnly: true, minDepth: 1, maxDepth: 8
        }],
        tavern_helper: {
          scripts: [{ id: 'script-1', name: '开场白索引', type: 'script', enabled: true, content: "import 'https://example.test/opening.js'", data: { auto_apply: true }, button: [{ name: '刷新' }] }]
        }
      }
    }
  }

  const result = inspectCardExtensions(card)
  assert.equal(result.extensionCount, 2)
  assert.deepEqual(result.regexScripts[0], {
    ref: 'regex:0', id: 'regex-1', name: '状态栏', findRegex: '/<status>(.*?)<\\/status>/s', replaceString: '<aside>$1</aside>', trimStrings: [],
    placement: [2], enabled: true, markdownOnly: true, promptOnly: false, runOnEdit: false, substituteRegex: null, minDepth: 1, maxDepth: 8
  })
  assert.equal(result.helperScripts[0].name, '开场白索引')
  assert.equal(result.helperScripts[0].content, "import 'https://example.test/opening.js'")
  assert.deepEqual(result.helperScripts[0].data, { auto_apply: true })
  assert.equal(result.helperScripts[0].dataText, '{\n  "auto_apply": true\n}')
  assert.deepEqual(result.helperScripts[0].buttons, [])
  assert.equal(result.helperScripts[0].buttonCount, 1)
  assert.deepEqual(result.variables, {})
})

test('读取包装式 TavernHelper_scripts，保留配置并进入实际运行投影', async () => {
  const { projectTavernHelperScripts } = await import('../tavern-plugin/lib/domain/tavern-helper-scripts.js')
  const value = { id:'wizard', name:'开场白向导', enabled:true, content:'window.wizard = true', data:{page:2}, info:'说明', button:{buttons:[{name:'重开'}]}, export_with:true }
  const extensions = { TavernHelper_scripts:[
    {type:'script',value},
    {type:'script',value:{id:'off',enabled:false,content:'throw Error()'}},
    {type:'folder',value:{id:'folder',content:'must not run'}},
    null, {type:'script',value:null}
  ] }
  const card = {spec:'chara_card_v3',data:{extensions}}
  const before = structuredClone(card), result = inspectCardExtensions(card)
  assert.equal(result.helperScripts.length, 2)
  assert.equal(result.otherExtensions.length, 0)
  const scripts = projectTavernHelperScripts(result.helperScripts).scripts
  assert.equal(scripts.length, 1)
  assert.equal(scripts[0].id, 'wizard')
  assert.equal(scripts[0].name, value.name)
  assert.equal(scripts[0].content, value.content)
  assert.deepEqual(scripts[0].data, value.data)
  assert.deepEqual(scripts[0].buttons, value.button.buttons)
  assert.equal(scripts[0].info, value.info)
  assert.equal(result.helperScripts[0].exportWith, true)
  result.helperScripts[0].data.page = 9
  assert.deepEqual(card, before)
})

test('两种格式并存时以 tavern_helper.scripts 为准，避免重复执行或重新启用已删除脚本', () => {
  for (const scripts of [[], [{id:'same',type:'script',enabled:false,content:'current'}]]) {
    const result = inspectCardExtensions({extensions:{tavern_helper:{scripts},TavernHelper_scripts:[{type:'script',value:{id:'same',content:'old'}}]}})
    assert.equal(result.helperScripts.length, scripts.length)
    if (scripts.length) { assert.equal(result.helperScripts[0].content,'current'); assert.equal(result.helperScripts[0].enabled,false) }
  }
})
