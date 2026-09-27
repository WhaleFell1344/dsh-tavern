import test from 'node:test'
import assert from 'node:assert/strict'
import {createTemplateHistoryWindow} from '../tavern-plugin/lib/vendor/st-prompt-template/host-build/history-window.js'

test('template window reads recent rows locally, old rows on demand and saves only loaded edits',()=>{
 let reads=0
 const page={from:9998,messageCount:10000,revision:4,token:'grant'}
 const rows=[{mes:'recent',variables:[]},{mes:'last',variables:[]}]
 const view=createTemplateHistoryWindow({window:page,rows,read:id=>{reads++;return {mes:'old '+id,variables:[]}}})
 assert.equal(view.chat.length,10000)
 assert.equal(view.chat[9999].mes,'last');assert.equal(reads,0)
 assert.equal(view.chat[3].mes,'old 3');assert.equal(reads,1)
 view.chat[3].variables=[{hp:9}]
 assert.deepEqual(view.changes(),[{op:'splice',path:['chat',3,'variables'],index:0,deleteCount:0,items:[{hp:9}]}])
 assert.equal(reads,1)
 assert.deepEqual(view.loaded(),[3,9998,9999])
})

import {createNativeTemplateConnection} from '../tavern-plugin/lib/vendor/st-prompt-template/host-build/native-connection.js'
test('paged template connection saves an explicitly loaded historical row at its absolute index',async()=>{
 let reads=0, request
 const snapshot={capabilities:{statePatch:1},historyWindow:{from:9999,messageCount:10000,revision:4,token:'grant'},
  state:{chatId:'c',sessionId:'s',stateRevision:4,lifecycleRevision:0,chat:[{mes:'tail',variables:[]}],chat_metadata:{variables:{}}},
  environment:{extension_settings:{variables:{global:{}}}}}
 const rpc=async(method,args)=>{
  if(method==='getFullPromptTemplateState'){assert.equal(args.openingWindow,1);return structuredClone(snapshot)}
  if(method==='saveFullPromptTemplateState'){request=args.state;return {updated:true,statePatch:[{op:'set',path:['stateRevision'],value:5}]}}
  throw Error(method)
 }
 rpc.readHistory=({messageId,token})=>{reads++;assert.equal(token,'grant');return {revision:4,messages:[{message_id:messageId,message:'old',role:'assistant',swipe_id:0,swipes:['old'],swipes_data:[{hp:1}],pluginData:{}}]}}
 const c=await createNativeTemplateConnection({sessionId:'s',rpc})
 assert.equal(reads,0)
 c.snapshot.chat[8].variables[0].hp=2
 await c.callbacks.saveChatConditional(c.snapshot)
 assert.equal(reads,1)
 assert.deepEqual(request.changes,[{op:'set',path:['chat',8,'variables',0,'hp'],value:2}])
 await c.callbacks.saveChatConditional(c.snapshot)
 assert.equal(reads,1)
 await c.refresh()
 assert.equal(reads,1,'refresh must not hydrate the formerly loaded historical row')
 assert.equal(c.snapshot.chat.length,10000)
})

import {spawn} from 'node:child_process'
import {serveTemplateHistoryPipe} from '../tavern-plugin/lib/domain/template-history-pipe.js'
test('isolated worker can synchronously read a framed historical response while host remains asynchronous',async()=>{
 const url=new URL('../tavern-plugin/lib/domain/template-history-pipe.js',import.meta.url).href
 const child=spawn(process.execPath,['--input-type=module','-e',`import {createTemplateHistoryPipeClient} from ${JSON.stringify(url)};const read=createTemplateHistoryPipeClient();process.stdout.write(JSON.stringify(read({messageId:7,token:'g'})));`],{stdio:['ignore','pipe','pipe','ignore','pipe']})
 let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b)
 serveTemplateHistoryPipe(child.stdio[4],async args=>{assert.deepEqual(args,{messageId:7,token:'g'});await new Promise(r=>setTimeout(r,10));return {message:'x'.repeat(100000)}})
 const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,error)
 assert.equal(JSON.parse(output).message.length,100000)
})


test('explicit full snapshot replaces a paged template array without fetching old rows again',async()=>{
 let calls=0,reads=0
 const row={mes:'same',variables:[]}
 const rpc=async()=>({state:{sessionId:'s',chat:[row],chat_metadata:{variables:{}}},environment:{extension_settings:{variables:{global:{}}}},
  ...(calls++===0?{historyWindow:{from:2,messageCount:3,revision:1,token:'g'}}:{})})
 rpc.readHistory=()=>{reads++;throw Error('unexpected read')}
 const c=await createNativeTemplateConnection({sessionId:'s',rpc})
 await c.refresh()
 assert.equal(c.snapshot.chat.length,1)
 assert.equal(c.snapshot.chat[0].mes,'same')
 assert.equal(reads,0)
})
