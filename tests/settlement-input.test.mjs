import test from 'node:test'
import assert from 'node:assert/strict'
import {readSettlementInput} from '../tavern-plugin/lib/domain/settlement-input.js'
const window = () => ({from:9997,messageCount:10000,revision:8,chat:{id:'c',_storageRevision:8,
 backgroundConfigVersion:1,conversationFeaturesVersion:1,timeline:{schemaVersion:1,revision:3,checkpoints:[],operations:{}},
 preparedWorldBook:{revision:3},mvu:{enabled:true,owner:'official'},messages:[{role:'assistant',text:'prior'},
 {role:'tavern-helper',text:'helper'},{role:'assistant',turn:5000,mvu:{pending:true,variableRetry:true},variables:[{hp:8}]}]}})
test('retry input preserves absolute target and neighboring helper rows without full reads',async()=>{
 const selected=await readSettlementInput('c',{readWindow:async()=>window(),readChat:async()=>{throw Error('full read')}})
 assert.equal(selected.messages.length,10000)
 assert.equal(selected.messages[9999].variables[0].hp,8)
 assert.equal(selected.messages[9998].text,'helper')
 assert.deepEqual(Object.keys(selected.messages),['9997','9998','9999'])
})
for(const reason of ['worldbook','ordinary','legacy','boundary','format','revision'])test(`unsupported ${reason} input retains full read`,async()=>{
 const value=window()
 if(reason==='worldbook')value.chat.preparedWorldBook.revision=2
 if(reason==='ordinary')delete value.chat.messages[2].mvu.variableRetry
 if(reason==='legacy')value.chat.timeline.operations.old={kind:'body',status:'foreground-completed'}
 if(reason==='boundary')value.chat.messages[0].role='user'
 if(reason==='format')value.chat.conversationFeaturesVersion=0
 if(reason==='revision')value.revision++
 let full=0
 const result=await readSettlementInput('c',{readWindow:async()=>value,readChat:async()=>{full++;return 'full'}})
 assert.equal(result,'full');assert.equal(full,1)
})
