import test from 'node:test'
import assert from 'node:assert/strict'
import {createImmutableOrderedJsonIndex,immutableArrayChanges} from '../tavern-plugin/lib/domain/freeze-json.js'
import {createSessionViewSync} from '../tavern-plugin/lib/domain/session-view-sync.js'
for(const count of [20,400,10000])test(`positional wire sync retains the ${count}-row prefix on append and truncation`,()=>{
 let visits=0
 const index=createImmutableOrderedJsonIndex({visit:()=>visits++})
 const rows=index.from(Array.from({length:count},(_,i)=>[i,{turn:i+1,text:'body'+i}]))
 const sync=createSessionViewSync(),first=sync('s',{replyProjections:rows})
 const appended=index.update(rows,[[count,{turn:count+1,text:'new'}]])
 visits=0
 const next=sync('s',{replyProjections:appended},first.viewCursor)
 assert.ok(visits<500,`append visits: ${visits}`)
 assert.deepEqual(next.viewDelta.set.map(([path])=>path),[['replyProjections','length'],['replyProjections',count]])
 assert.deepEqual(next.viewDelta.remove,[])
 visits=0
 const last=sync('s',{replyProjections:rows},next.viewCursor)
 assert.ok(visits<500,`truncate visits: ${visits}`)
 assert.deepEqual(last.viewDelta.set,[[['replyProjections','length'],count]])
 assert.deepEqual(last.viewDelta.remove,[['replyProjections',count]])
})

test('membership edits include shifted positions even when the total length is unchanged',()=>{
 const index=createImmutableOrderedJsonIndex(),old=index.from([[1,{id:1}],[3,{id:3}],[5,{id:5}],[7,{id:7}]])
 for(const edits of [[[3,undefined],[6,{id:6}]],[[0,{id:0}]],[[7,undefined]],[[1,{id:'edited'}],[7,undefined]]]){
  const next=index.update(old,edits),actual=new Set(immutableArrayChanges(old,next))
  for(let i=0;i<next.length;i++)if(old[i]!==next[i])assert.ok(actual.has(i),`missing changed position ${i}`)
  const sync=createSessionViewSync(),first=sync('s',{replyProjections:old}),delta=sync('s',{replyProjections:next},first.viewCursor).viewDelta
  const reconstructed=Array.from(old)
  for(const [path,value] of delta.set)reconstructed[path[1]]=value
  assert.deepEqual(reconstructed,Array.from(next))
 }
})
