import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {ScenePrefixHash} from '../tavern-plugin/lib/domain/scene-prefix-hash.js'
test('persisted SHA prefixes preserve Node scene hashes across UTF-8 and block boundaries',()=>{
 for(const size of [0,1,55,56,63,64,65,127,128,129,1024,100000]){
  const bytes=Buffer.from('场景😀\\"\n'.repeat(size)),prefix=new ScenePrefixHash()
  for(let start=0;start<bytes.length;start+=37)prefix.update(bytes.subarray(start,start+37))
  const restored=new ScenePrefixHash(JSON.parse(JSON.stringify(prefix.state())))
  assert.equal(restored.digest('],999,1000,0,"hash"]'),createHash('sha256').update(bytes).update('],999,1000,0,"hash"]').digest('hex'))
  assert.equal(prefix.digest(),createHash('sha256').update(bytes).digest('hex'))
 }
})
