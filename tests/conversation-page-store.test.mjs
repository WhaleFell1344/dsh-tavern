import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createConversationPageStore} from '../tavern-plugin/lib/domain/conversation-page-store.js'

async function fixture(t, count=20000) {
 const root=await mkdtemp(join(tmpdir(),'conversation-pages-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const io=[]
 const store=createConversationPageStore({root,onIO:event=>io.push(event)})
 await store.create('a',{metadata:{card:'test'},state:{gold:10},messages:Array.from({length:count},(_,i)=>({id:'m'+i,text:'body '+i}))})
 io.length=0
 return {root,store,io}
}

test('cold tail reads only its pages, returns detached current state, and never hydrates history',async t=>{
 const {root}=await fixture(t)
 const io=[]
 const store=createConversationPageStore({root,onIO:e=>io.push(e)})
 const result=await store.openConversation('a',{limit:50})
 assert.equal(result.messageCount,20000)
 assert.equal(result.messages.length,50)
 assert.equal(result.messages[0].position,19950)
 assert.equal(result.messages.at(-1).message.text,'body 19999')
 assert.deepEqual(result.state,{gold:10})
 assert.ok(io.filter(e=>e.kind==='read'&&e.type==='page').length<=2)
 assert.ok(io.filter(e=>e.kind==='read').length<15)
 result.state.gold=999;result.messages[0].message.text='mutated'
 const again=await store.openConversation('a',{limit:50})
 assert.equal(again.state.gold,10)
 assert.equal(again.messages[0].message.text,'body 19950')
})

test('append and settlement edit publish together; old cursor stays on its snapshot',async t=>{
 const {root,store,io}=await fixture(t)
 const old=await store.openConversation('a',{limit:50})
 const head=await store.commit('a',{expectedRevision:1,append:[{id:'u',text:'next'},{id:'a',text:'reply'}],state:{gold:20}})
 assert.equal(head.revision,2)
 assert.ok(io.filter(e=>e.kind==='read'&&e.type==='page').length<=3)
 assert.ok(io.filter(e=>e.kind==='write'&&e.type==='page').length<=2)
 assert.ok(io.filter(e=>e.kind==='write').length<15)
 const fresh=createConversationPageStore({root})
 const opened=await fresh.openConversation('a',{limit:2})
 assert.deepEqual(opened.messages.map(r=>r.message.id),['u','a'])
 assert.equal(opened.messageCount,20002);assert.equal(opened.state.gold,20)
 const before=await fresh.readHistoryPage('a',{cursor:old.previousCursor,limit:50})
 assert.equal(before.messages.at(-1).position,19949)
 assert.equal(before.revision,1)
 await fresh.commit('a',{expectedRevision:2,edits:[{position:20001,message:{id:'a',text:'reply',stateAfter:'settled'}}],state:{gold:30}})
 assert.equal((await fresh.openConversation('a',{limit:1})).messages[0].message.stateAfter,'settled')
 assert.equal((await fresh.readHistoryPage('a',{cursor:opened.snapshotCursor,limit:2})).messages.at(-1).message.stateAfter,undefined)
})

test('stale writers conflict across store instances without losing committed history',async t=>{
 const {root,store}=await fixture(t,4)
 const another=createConversationPageStore({root})
 await store.commit('a',{expectedRevision:1,append:[{id:'new'}]})
 await assert.rejects(another.commit('a',{expectedRevision:1,state:{gold:0}}),{code:'CONVERSATION_CONFLICT'})
 const result=await another.openConversation('a')
 assert.equal(result.messageCount,5);assert.equal(result.state.gold,10)
})

test('failed publication leaves old head valid and retry can use orphaned immutable blocks',async t=>{
 const {root,store}=await fixture(t,65)
 const failing=createConversationPageStore({root,onIO:event=>{if(event.kind==='write'&&event.type==='head')throw Error('power loss before publication')}})
 await assert.rejects(failing.commit('a',{expectedRevision:1,append:[{id:'next'}],state:{gold:20}}),/power loss/)
 assert.equal((await store.openConversation('a')).messageCount,65)
 await store.commit('a',{expectedRevision:1,append:[{id:'next'}],state:{gold:20}})
 assert.equal((await createConversationPageStore({root}).openConversation('a')).state.gold,20)
})

test('pagination includes every row exactly once across tree growth and rejects foreign cursors',async t=>{
 const {store}=await fixture(t,2050)
 const first=await store.openConversation('a',{limit:137})
 let page=first,positions=[]
 while(true){positions.push(...page.messages.map(row=>row.position));if(!page.previousCursor)break;page=await store.readHistoryPage('a',{cursor:page.previousCursor,limit:137})}
 assert.equal(new Set(positions).size,2050)
 assert.equal(positions.length,2050)
 await store.create('b',{state:{},messages:[]})
 await assert.rejects(store.readHistoryPage('b',{cursor:first.previousCursor}),/cursor/)
 await assert.rejects(store.openConversation('../a'),/id/)
 await assert.rejects(store.commit('a',{expectedRevision:1,edits:[{position:2050,message:{}}]}),/position/)
 assert.equal((await store.openConversation('a')).revision,1)
})

for(const count of [0,63,2047])test('append across page/index growth from '+count,async t=>{
 const {root,store}=await fixture(t,count)
 await store.commit('a',{expectedRevision:1,append:[{id:'x'},{id:'y'}]})
 const cold=await createConversationPageStore({root}).openConversation('a',{limit:2})
 assert.deepEqual(cold.messages.map(r=>r.message.id),['x','y'])
 assert.equal(cold.messageCount,count+2)
})

test('historical state reads are independent of message bodies',async t=>{
 const {root,store}=await fixture(t,2000)
 const before=await store.openConversation('a')
 await store.commit('a',{expectedRevision:1,state:{gold:20}})
 const io=[],cold=createConversationPageStore({root,onIO:e=>io.push(e)})
 assert.deepEqual(await cold.readState('a',{snapshotId:before.snapshotCursor.snapshotId}),{gold:10})
 assert.equal(io.filter(e=>e.type==='page').length,0)
})

test('two real processes cannot both commit from the same revision',async t=>{
 const {root}=await fixture(t,4)
 const {spawn}=await import('node:child_process')
 const moduleUrl=new URL('../tavern-plugin/lib/domain/conversation-page-store.js',import.meta.url).href
 const source=`import {createConversationPageStore} from ${JSON.stringify(moduleUrl)};try{await createConversationPageStore({root:process.argv[1]}).commit('a',{expectedRevision:1,append:[{id:process.argv[2]}]});console.log('committed')}catch(e){console.log(e.code);if(!['CONVERSATION_CONFLICT','DSH_TAVERN_WRITE_CONFLICT'].includes(e.code))process.exitCode=1}`
 const run=id=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source,root,id]);let out='',err=''
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject)
  child.on('exit',code=>code===0?resolve(out.trim()):reject(Error(err)))
 })
 const result=await Promise.all([run('one'),run('two')])
 assert.equal(result.filter(v=>v==='committed').length,1)
 assert.equal((await createConversationPageStore({root}).openConversation('a')).messageCount,5)
})

test('process death before head publication preserves old state and recovers writer lock',async t=>{
 const {root}=await fixture(t,4)
 const {spawn}=await import('node:child_process')
 const moduleUrl=new URL('../tavern-plugin/lib/domain/conversation-page-store.js',import.meta.url).href
 const source=`import {createConversationPageStore} from ${JSON.stringify(moduleUrl)};await createConversationPageStore({root:process.argv[1],onIO:e=>{if(e.kind==='write'&&e.type==='head')process.exit(42)}}).commit('a',{expectedRevision:1,state:{gold:0},append:[{id:'interrupted'}]})`
 const code=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',source,root],{stdio:'ignore'});child.on('error',reject);child.on('exit',resolve)})
 assert.equal(code,42)
 const fresh=createConversationPageStore({root})
 assert.equal((await fresh.openConversation('a')).state.gold,10)
 await fresh.commit('a',{expectedRevision:1,append:[{id:'retry'}]})
 const current=await fresh.openConversation('a')
 assert.equal(current.messageCount,5);assert.equal(current.messages.at(-1).message.id,'retry')
})

test('state-only writes do not read or rewrite historical pages',async t=>{
 const {store,io}=await fixture(t,2000)
 await store.commit('a',{expectedRevision:1,state:{gold:20}})
 assert.equal(io.filter(e=>e.type==='page'||e.type==='index').length,0)
 assert.deepEqual(await store.readState('a'),{gold:20})
})

test('corrupt immutable pages fail explicitly instead of returning incomplete history',async t=>{
 const {root}=await fixture(t,1)
 const {readFile,writeFile}=await import('node:fs/promises')
 const pointer=JSON.parse(await readFile(join(root,'a','head.json'),'utf8'))
 const block=id=>join(root,'a','blocks',id.slice(0,2),id+'.json')
 const head=JSON.parse(await readFile(block(pointer.headId),'utf8'))
 await writeFile(block(head.root),'{}')
 await assert.rejects(createConversationPageStore({root}).openConversation('a'),/checksum/)
})

test('keyed receipts use snapshot indexes and never read message pages',async t=>{
 const {root,store,io}=await fixture(t,65)
 const entries=Array.from({length:512},(_,i)=>['op:'+i,{value:i}])
 const old=await store.commit('a',{expectedRevision:1,records:entries,state:{gold:20}})
 await store.commit('a',{expectedRevision:2,records:[['op:17',{value:999}],['__proto__',{safe:true}]]})
 const fresh=createConversationPageStore({root,onIO:e=>io.push(e)})
 io.length=0
 assert.deepEqual(await fresh.readEntries('a',['op:17','missing','op:511']),{'op:17':{value:999},'op:511':{value:511}})
 assert.deepEqual(await fresh.readEntries('a',['op:17'],{snapshotId:old.snapshotId}),{'op:17':{value:17}})
 assert.equal((await fresh.readEntries('a',['__proto__'])).__proto__.safe,true)
 assert.equal(io.filter(e=>e.type==='page').length,0)
 assert.ok(io.filter(e=>e.kind==='read').length<40)
 assert.deepEqual(await fresh.readEntries('a',entries.map(([key])=>key),{snapshotId:old.snapshotId}),Object.fromEntries(entries))
 await assert.rejects(store.commit('a',{expectedRevision:3,records:[['',{bad:true}]]}),/record key/)
 assert.equal((await store.openConversation('a')).revision,3)
})

test('failed publication hides receipts and state together',async t=>{
 const {root,store}=await fixture(t,0)
 const failing=createConversationPageStore({root,onIO:e=>{if(e.kind==='write'&&e.type==='head')throw Error('interrupted')}})
 await assert.rejects(failing.commit('a',{expectedRevision:1,state:{gold:99},records:[['op',{done:true}]]}),/interrupted/)
 assert.deepEqual(await store.readEntries('a',['op']),{})
 assert.equal((await store.openConversation('a')).state.gold,10)
})

test('small immutable blocks survive reader calls while head publication remains fresh',async t=>{
 const {root}=await fixture(t,4)
 const io=[],store=createConversationPageStore({root,onIO:event=>io.push(event)})
 const first=await store.openConversation('a')
 io.length=0
 first.messages[0].message.text='caller mutation'
 assert.equal((await store.openConversation('a')).messages[0].message.text,'body 0')
 assert.equal(io.filter(event=>event.kind==='read').length,0,'reuse immutable blocks across readers')
 await createConversationPageStore({root}).commit('a',{expectedRevision:1,append:[{id:'external',text:'external write'}]})
 const latest=await store.openConversation('a')
 assert.equal(latest.revision,2)
 assert.equal(latest.messages.at(-1).message.text,'external write')
})
