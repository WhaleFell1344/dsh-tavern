import test from 'node:test'
import assert from 'node:assert/strict'
import { createHelperHistoryAccess } from '../tavern-plugin/lib/domain/helper-history-access.js'

test('history grant reads only requested floors at the pinned revision', async () => {
 const calls=[]
 const access=createHelperHistoryAccess({read:async(id,args)=>{calls.push({id,...args});return {context:{messages:[{message_id:args.from,message:'old',variables:{hp:7}}]}}}})
 const grant=access.issue({chatId:'chat',revision:12,messageCount:20000})
 assert.deepEqual((await access.read(grant.token,3,3)).messages,[{message_id:3,message:'old',variables:{hp:7}}])
 assert.deepEqual(calls,[{id:'chat',from:3,to:3,revision:12}])
 await assert.rejects(access.read('wrong',3,3))
 await assert.rejects(access.read(grant.token,-1,3))
 await assert.rejects(access.read(grant.token,0,1000))
 assert.equal(calls.length,1)
})

test('history grants cannot be widened or reused on another host',async()=>{
 const read=async()=>{throw Error('must not read')}
 const a=createHelperHistoryAccess({read}),b=createHelperHistoryAccess({read})
 const grant=a.issue({chatId:'a',revision:2,messageCount:100})
 const [body,signature]=grant.token.split('.')
 const scope=JSON.parse(Buffer.from(body,'base64url').toString());scope.chatId='victim'
 const tampered=Buffer.from(JSON.stringify(scope)).toString('base64url')+'.'+signature
 await assert.rejects(a.read(tampered,0,0),/Invalid history capability/)
 await assert.rejects(b.read(grant.token,0,0),/Invalid history capability/)
})
