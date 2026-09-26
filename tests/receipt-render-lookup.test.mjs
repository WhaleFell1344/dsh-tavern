import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
function harness(){
 const context=vm.createContext({})
 const main=fs.readFileSync(new URL('../tavern-plugin/src/client/main.js',import.meta.url),'utf8')
 const lookup=main.slice(main.indexOf('function tavernMvuReceiptForTurn('),main.indexOf('function TavernMvuReceipt('))
 vm.runInContext(fs.readFileSync(new URL('../tavern-plugin/lib/domain/indexed-array.js',import.meta.url),'utf8').replace(/^export .*$/gm,'')+'\n'+fs.readFileSync(new URL('../tavern-plugin/src/client/modules/session-view-sync.js',import.meta.url),'utf8')+'\n'+lookup,context)
 let visits=0
 context.createSessionViewReader.indexApi=context.createIndexedArrayApi({visit:()=>visits++})
 return {context,begin:context.createSessionViewReader(),reset:()=>visits=0,visits:()=>visits}
}
for(const count of [20,400,10000])test(`render receipt lookup stays bounded at ${count}`,t=>{
 const h=harness()
 const first=h.begin('s').accept({viewCursor:'a',view:{mvuReceipts:Array.from({length:count},(_,i)=>({turn:i+1,receipt:{status:'error',summary:'old'}}))}}).view
 h.reset()
 assert.equal(h.context.tavernMvuReceiptForTurn(first,1).summary,'old')
 assert.ok(h.visits()<32,`${h.visits()} lookup index visits`)
 const request=h.begin('s');h.reset()
 const next=request.accept({viewCursor:'b',viewDelta:{baseCursor:'a',set:[[['mvuReceipts',0],{turn:1,receipt:{status:'error',summary:'new'}}]],remove:[]}}).view
 assert.equal(h.context.tavernMvuReceiptForTurn(next,1).summary,'new')
 assert.equal(h.context.tavernMvuReceiptForTurn(first,1).summary,'old')
 assert.ok(h.visits()<64,`${h.visits()} update and lookup visits`)
 t.diagnostic(`${count} receipts: ${h.visits()} update and lookup visits`)
})

test('receipt lookup retains legacy duplicate, unusual turn and missing-turn semantics',()=>{
 const h=harness()
 let serial=0
 for(const rows of [
  [{turn:1,receipt:{summary:'first'}},{turn:'1',receipt:{summary:'last'}}],
  [{turn:-1,receipt:{summary:'negative'}},{turn:4294967295,receipt:{summary:'large'}}],
  [{turn:1.5,receipt:{summary:'fraction'}}],[]
 ]){
  const view=h.begin('s').accept({viewCursor:String(++serial),view:{mvuReceipts:rows}}).view
  for(const turn of [1,'1',-1,4294967295,1.5,99]){
   const expected=rows.findLast(row=>Number(row.turn)===Number(turn))?.receipt || null
   assert.deepEqual(h.context.tavernMvuReceiptForTurn(view,turn),expected)
  }
 }
})

test('turn changes, truncation and concurrent receipt views preserve their own lookup',()=>{
 const h=harness(),row=(turn,summary)=>({turn,receipt:{summary}})
 const first=h.begin('s').accept({viewCursor:'a',view:{mvuReceipts:[row(1,'one'),row(2,'two')]}}).view
 const slow=h.begin('s'),fast=h.begin('s')
 const newer=fast.accept({viewCursor:'new',viewDelta:{baseCursor:'a',set:[[['mvuReceipts',0],row(3,'three')]],remove:[]}}).view
 const older=slow.accept({viewCursor:'old',viewDelta:{baseCursor:'a',set:[[['mvuReceipts','length'],1]],remove:[['mvuReceipts',1]]}}).view
 assert.equal(h.context.tavernMvuReceiptForTurn(newer,1),null)
 assert.equal(h.context.tavernMvuReceiptForTurn(newer,3).summary,'three')
 assert.equal(h.context.tavernMvuReceiptForTurn(older,1).summary,'one')
 assert.equal(h.context.tavernMvuReceiptForTurn(older,2),null)
 assert.equal(h.context.tavernMvuReceiptForTurn(first,2).summary,'two')
 assert.equal(h.begin('s').cursor,'new')
})
