import test from 'node:test'
import assert from 'node:assert/strict'
import {createOrderedNumericIndex} from '../tavern-plugin/lib/domain/ordered-numeric-index.js'

test('compressed numeric index preserves order, rank, deletion, diff and old roots',()=>{
 const index=createOrderedNumericIndex()
 const keys=[-Infinity,-1e100,-1,-Number.MIN_VALUE,-0,Number.MIN_VALUE,0.25,1,17,1e100,Infinity]
 let source=index.from(keys.map((key,id)=>[key,{id}]))
 const expected=new Map(keys.map((key,id)=>[key,{id}]))
 function check(){
  const entries=[...expected].sort((a,b)=>a[0]-b[0])
  assert.deepEqual(Array.from(source),entries.map(row=>row[1]))
  for(let id=0;id<entries.length;id++){
   assert.equal(index.rank(source,entries[id][0]),id)
   assert.deepEqual(index.get(source,entries[id][0]),entries[id][1])
  }
  for(const key of [-2,-0.5,0.5,99])assert.equal(index.rank(source,key),entries.filter(([value])=>value<key).length)
 }
 check()
 let seed=17
 for(let step=0;step<200;step++){
  seed=(seed*1664525+1013904223)>>>0
  const key=(seed%61)-30,previous=source,before=Array.from(previous)
  const value=step%3 ? {id:step} : undefined
  source=index.update(source,[[key,value]])
  if(value===undefined)expected.delete(key);else expected.set(key,value)
  check();assert.deepEqual(Array.from(previous),before)
  const changes=index.changed(previous,source)
  assert.ok(changes.length<=1)
  if(changes.length)assert.equal(changes[0].key,key)
 }
 assert.throws(()=>{source[0]={}},/immutable/)
 assert.throws(()=>index.from([[NaN,{}]]),/Invalid/)
})
