import assert from 'node:assert/strict'
import test from 'node:test'
import {buildMvuArtifacts} from '../tavern-plugin/lib/domain/mvu-conversion-artifacts.js'
import {UpstreamTemplateRuntime} from './fixtures/upstream-template-runtime.mjs'
import {projectReplyHistory} from '../tavern-plugin/lib/domain/reply-presentation.js'
import {projectPersistentStatusView} from '../tavern-plugin/lib/domain/persistent-status-view.js'
const runtime=await UpstreamTemplateRuntime.create()
const settings={preload_worldinfo_enabled:false,raw_message_evaluation_enabled:true}
const transcript=state=>state.chat.map(m=>({...m,content:m.mes}))
const display=(state,regexScripts)=>{
 const messages=state.chat.map(m=>({role:m.is_user?'user':'assistant',turn:1,text:m.mes,sourceText:m.mes,swipeId:m.swipe_id,tavernPluginData:m}))
 return projectPersistentStatusView(messages,projectReplyHistory(messages,{regexScripts}).projections,{regexScripts})
}
test('显示正则先于 EJS，独立侧栏保留模板结果且正文不重复面板',async()=>{
 const source='正文\n<StatusPlaceHolderImpl/>'
 const regexScripts=[{enabled:true,placement:[2],markdownOnly:true,findRegex:'/<StatusPlaceHolderImpl\\s*\\/>/g',replaceString:'```html\n<html><body><p>数值=<%= 1+2 %></p><script>const value=<%- 1+2 %>;function loadStatus(){window.mounts=(window.mounts||0)+1;window.value=value}loadStatus()</script></body></html>\n```'}]
 const result=await runtime.lifecycle({settings,charName:'状态组合',regexScripts,transcript:[{role:'assistant',content:source}],worldBookEntries:[{uid:1,enabled:false,constant:true,content:'@@render_before\n显示前缀'}]})
 assert.equal(result.first.chat[0].mes,source)
 const view=display(result.first,regexScripts)
 assert.equal(view.statusViews.length,1)
 assert.match(view.statusView.content,/>3</)
 assert.match(view.statusView.content,/const value=3;/)
 assert.doesNotMatch(view.statusView.content,/<%|&lt;%/)
 assert.match(JSON.stringify(view.projections),/显示前缀/)
 assert.doesNotMatch(JSON.stringify(view.projections),/loadStatus/)
 assert.deepEqual(result.second.chat,result.first.chat)
 assert.equal(await runtime.page.evaluate(()=>window.mounts),undefined)
 await runtime.page.evaluate(content=>{const frame=document.createElement('iframe');frame.id='chain-status';frame.srcdoc=content;document.body.append(frame)},view.statusView.content)
 await runtime.page.waitForFunction(()=>document.querySelector('#chain-status')?.contentWindow.mounts===1)
 assert.equal(await runtime.page.evaluate(()=>document.querySelector('#chain-status').contentWindow.value),3)
 await runtime.page.locator('#chain-status').evaluate(frame=>frame.remove())
})
test('聊天和全局变量变化保留历史展示，不重复永久模板副作用',async()=>{
 const context={settings,charName:'变量刷新',worldBookEntries:[{uid:2,enabled:false,constant:true,content:'@@render_before\n地点=<%= getvar("place") %>，全局=<%= getGlobalVar("weather") %>'}]}
 const a=await runtime.lifecycle({...context,chatVariables:{place:'甲'},globalVariables:{weather:'晴'},transcript:[{role:'assistant',content:'<% setMessageVar("count", (getMessageVar("count") || 0)+1) %>正文'}]})
 const b=await runtime.lifecycle({...context,chatVariables:{place:'乙'},globalVariables:{weather:'雨'},transcript:transcript(a.first)})
 assert.match(b.first.chat[0].template_display.html,/甲/)
 assert.match(b.first.chat[0].template_display.html,/晴/)
 assert.equal(b.first.chat[0].variables[0].count,1)
 assert.deepEqual(b.second.chat,b.first.chat)
})
test('用户输入显示正则与模板串联，不改变提交的输入',async()=>{
 const r=await runtime.renderInput('输入[面板]',{settings,regexScripts:[{enabled:true,placement:[1],markdownOnly:true,findRegex:'/\\[面板\\]/g',replaceString:'<div>结果=<%= 2+3 %></div>'}]})
 assert.equal(r.message.mes,'输入[面板]')
 assert.match(r.message.template_display.html,/>5</)
 assert.doesNotMatch(r.message.template_display.html,/<%|&lt;%/)
})
test('修改显示正则只影响新消息，旧展示保留当时结果',async()=>{
 const rule={enabled:true,placement:[2],markdownOnly:true,findRegex:'/标记/g',replaceString:'<b>标记第一版</b>'}
 const context={settings,charName:'规则刷新'}
 const a=await runtime.lifecycle({...context,regexScripts:[rule],transcript:[{role:'assistant',content:'标记'}]})
 const b=await runtime.lifecycle({...context,regexScripts:[{...rule,replaceString:'<b>第二版</b>'}],transcript:transcript(a.first)})
 assert.match(b.first.chat[0].template_display.html,/第一版/)
 assert.doesNotMatch(b.first.chat[0].template_display.html,/第二版/)
 assert.equal(b.first.chat[0].mes,'标记')
 const c=await runtime.lifecycle({...context,regexScripts:[{...rule,enabled:false}],transcript:transcript(b.first)})
 assert.deepEqual(c.first.chat[0].template_display,a.first.chat[0].template_display)
})
test('新增楼层后，旧消息展示不受新的深度影响',async()=>{
 const rule={enabled:true,placement:[2],markdownOnly:true,maxDepth:0,findRegex:'/标记/g',replaceString:'<b>面板</b>'}
 const context={settings,charName:'深度刷新',regexScripts:[rule]}
 const a=await runtime.lifecycle({...context,transcript:[{role:'assistant',content:'标记'}]})
 const b=await runtime.lifecycle({...context,transcript:[...transcript(a.first),{role:'user',content:'继续'}]})
 assert.deepEqual(b.first.chat[0].template_display,a.first.chat[0].template_display)
})

test('card-to-mvu named status survives reordered rules and updates only its persistent template',async()=>{
 const source='正文\n<mvu-status/>'
 const panel=version=>'<html><body><p>'+version+'</p><script>window.statusMount=true</script></body></html>'
 const rule={id:'mvu-status-view',scriptName:'MVU 状态视图',placement:[2],markdownOnly:true,findRegex:'/<mvu-status\\s*\\/>/g',replaceString:'```html\n'+panel('旧面板')+'\n```'}
 const context={settings,charName:'Issue68'}
 const first=await runtime.lifecycle({...context,regexScripts:[rule],transcript:[{role:'assistant',content:source}]})
 const initial=display(first.first,[rule])
 assert.equal(initial.statusViews.length,1)
 const rules=[{id:'unrelated',placement:[2],markdownOnly:true,findRegex:'/正文/g',replaceString:'正文'}, {...rule,replaceString:'```html\n'+panel('新面板')+'\n```'}]
 const next=display(first.first,rules)
 assert.equal(next.statusViews.length,1)
 assert.match(next.statusView.content,/新面板/)
 assert.doesNotMatch(JSON.stringify(next.projections),/旧面板|新面板|statusMount/)
 assert.equal(next.statusView.viewId,initial.statusView.viewId)
 assert.deepEqual(first.first.chat[0].template_display,first.second.chat[0].template_display)
})


test('实际 MVU 配方在恢复与修改模板后仍只保留一个状态面板', async () => {
 const {regexScripts}=buildMvuArtifacts({initialState:{玩家:{位置:'门口'}},updateRules:'根据正文更新位置'})
 const context={settings,charName:'配方验证',regexScripts}
 const initial=await runtime.lifecycle({...context,transcript:[{role:'assistant',content:'门口。\n<mvu-status/>'}]})
 const a=display(initial.first,regexScripts)
 assert.equal(a.statusViews.length,1)
 assert.doesNotMatch(JSON.stringify(a.projections), /Mvu.getMvuData|mvu-status|<script|<style/)
 const rules=[regexScripts[1],{...regexScripts[0],replaceString:regexScripts[0].replaceString.replace('</body>','<div>新版模板</div></body>')}]
 const restored=await runtime.lifecycle({...context,regexScripts:rules,transcript:[...transcript(initial.first),{role:'user',content:'继续'},{role:'assistant',content:'抵达庭院。'}]})
 const b=display(restored.first,rules)
 assert.equal(b.statusViews.length,1)
 assert.equal(b.statusView.viewId,a.statusView.viewId)
 assert.match(b.statusView.content,/新版模板/)
 assert.doesNotMatch(JSON.stringify(b.projections), /Mvu.getMvuData|mvu-status|新版模板|<script|<style/)
 assert.deepEqual(restored.first.chat[0].template_display,initial.first.chat[0].template_display)
})

test('转换卡开场 initvar 经真实模板渲染后不进入正文，源初值与侧栏保留',async()=>{
 const built=buildMvuArtifacts({initialState:{人物:{位置:'INITIAL_VALUE'}},updateRules:'依据正文更新。'})
 const regexScripts=built.regexScripts.map(rule=>({...rule,enabled:!rule.disabled}))
 const source='正文\n<initvar>{"人物":{"位置":"INITIAL_VALUE"}}</initvar>\n<mvu-status/>'
 const result=await runtime.lifecycle({settings,charName:'初始化隔离',regexScripts,transcript:[{role:'assistant',content:source}]})
 assert.equal(result.first.chat[0].mes,source)
 assert.ok(result.first.chat[0].template_display)
 const saved=structuredClone(result.first.chat[0].template_display)
 const view=display(result.first,regexScripts)
 assert.equal(view.statusViews.length,1)
 assert.match(view.statusView.content,/Mvu.getMvuData/)
 assert.doesNotMatch(JSON.stringify(view.projections),/INITIAL_VALUE|<initvar>/)
 assert.match(JSON.stringify(view.projections),/正文/)
 assert.deepEqual(result.first.chat[0].template_display,saved)
 assert.deepEqual(display(result.second,regexScripts).projections,view.projections)
})

 test('普通代码块与显示正则不接管整段正文，显示 EJS 仍执行', async()=>{
  const settings={preload_worldinfo_enabled:false,render_enabled:true,raw_message_evaluation_enabled:false}
  const plain='正文\n\n```js\nconst n = 1\n```'
  const a=await runtime.lifecycle({settings,charName:'普通格式',transcript:[{role:'assistant',content:plain}]})
  assert.equal(a.first.chat[0].template_display,undefined)
  assert.deepEqual(display(a.first,[]).projections,[])
  const rule={enabled:true,placement:[2],markdownOnly:true,findRegex:'/标记/g',replaceString:'**替换结果**'}
  const b=await runtime.lifecycle({settings,charName:'普通正则',regexScripts:[rule],transcript:[{role:'assistant',content:'正文 标记'}]})
  const projection=display(b.first,[rule]).projections[0]
  assert.equal(projection.mode,'markdown')
  assert.equal(projection.text,'正文 **替换结果**')
  const restored=await runtime.lifecycle({settings,charName:'普通正则',regexScripts:[{...rule,replaceString:'错误的新值'}],transcript:transcript(b.first)})
  assert.equal(display(restored.first,[rule]).projections[0].text,'正文 **替换结果**')
  const c=await runtime.lifecycle({settings,charName:'真正模板',transcript:[{role:'assistant',content:'结果：<%= 1+2 %>'}]})
  assert.match(c.first.chat[0].template_display.html,/3/)
  assert.doesNotMatch(c.first.chat[0].template_display.html,/<%|&lt;%/)
  assert.equal(display(c.first,[]).projections[0].mode,'html')
 })

test('原始 ST 禁用正则不能覆盖已启用的远程界面', async () => {
 const online='<body><script>window.panelSource="https://example.com/panel.html"</script></body>'
 const local='<body><script>window.panelSource="http://localhost:5500/dist/panel.html"</script></body>'
 const rules=[{disabled:false,replaceString:online},{disabled:true,replaceString:local}].map(rule=>({...rule,placement:[2],markdownOnly:true,findRegex:'/.+/s'}))
 const result=await runtime.lifecycle({settings,regexScripts:rules,transcript:[{role:'assistant',content:'开场正文'}]})
 assert.match(result.first.chat[0].template_display.html,/https:\/\/example.com\/panel.html/)
 assert.doesNotMatch(result.first.chat[0].template_display.html,/localhost:5500/)
 assert.equal(result.first.chat[0].mes,'开场正文')
})
