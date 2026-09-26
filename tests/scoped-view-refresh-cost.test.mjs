import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
function harness(){
 const context=vm.createContext({})
 const files=['../tavern-plugin/lib/domain/indexed-array.js','../tavern-plugin/lib/domain/ordered-numeric-index.js','../tavern-plugin/src/client/modules/session-view-sync.js','../tavern-plugin/src/client/modules/live-tavern-view.js']
 vm.runInContext(files.map(path=>fs.readFileSync(new URL(path,import.meta.url),'utf8').replace(/^export .*$/gm,'')).join('\n'),context)
 return context
}
for(const count of [20,400,10000])test(`real delta routes only matching subscribers among ${count} turns`,async()=>{
 const h=harness(),begin=h.createSessionViewReader(),jobs=[]
 let cursor='a',sequence=0,edits=[],removals=[],fail=false
 const first=begin('s').accept({viewCursor:cursor,view:{inputSources:{},tavernHelper:{messages:[]}}}).view
 const live=h.createLiveTavernViewModule({deduplicateViews:true,pollWhileBusy:false,schedule:run=>{jobs.push(run);return jobs.length},cancel(){},load:async()=>{
  if(fail)throw new Error('offline')
  const next=String(++sequence),result=begin('s').accept({viewCursor:next,viewDelta:{baseCursor:cursor,set:edits,remove:removals}})
  cursor=next;return result
 }})
 live.setView('s',first)
 let notices=0,global=0
 const selections=[]
 for(let i=0;i<count;i++){
  const selection=live.select('s',[['inputSources',String(i)]])
  selections.push(selection);selection.subscribe(()=>notices++)
 }
 live.subscribe('s',()=>global++)
 const snapshot=selections[0].getSnapshot();notices=0;global=0
 async function run(set=[],remove=[]){edits=set;removals=remove;if(!jobs.length)live.invalidate('s');jobs.shift()();await new Promise(resolve=>setImmediate(resolve))}
 await run([[['tavernHelper','variables'],{hp:1}]])
 assert.equal(notices,0);assert.equal(global,1);assert.equal(selections[0].getSnapshot(),snapshot)
 await run([[['inputSources','0'],undefined]])
 assert.equal(notices,1)
 assert.equal(Object.hasOwn(selections[0].getSnapshot().view.inputSources,'0'),true)
 await run([],[['inputSources','0']])
 assert.equal(notices,2);assert.equal(Object.hasOwn(selections[0].getSnapshot().view,'inputSources'),false)
 await run([[['inputSources'],{'0':'replaced'}]])
 assert.equal(notices,count+2)
 fail=true;await run();assert.equal(notices,2*count+2)
 fail=false;await run();assert.equal(notices,3*count+2)
 // A local optimistic view invalidates the incoming delta's published baseline.
 live.setView('s',{inputSources:{'0':'local'}});notices=0
 await run([[['tavernHelper','variables'],{hp:2}]])
 assert.equal(notices,count);assert.equal(selections[0].getSnapshot().view.inputSources['0'],'replaced')
})

test('overlapping dependencies notify once and unsubscribe removes path entries',async()=>{
 const h=harness(),begin=h.createSessionViewReader(),jobs=[]
 let cursor='a',sequence=0,edits=[]
 const first=begin('s').accept({viewCursor:cursor,view:{inputSources:{'1':'old'}}}).view
 const live=h.createLiveTavernViewModule({pollWhileBusy:false,schedule:run=>{jobs.push(run);return jobs.length},cancel(){},load:async()=>{
  const next=String(++sequence),result=begin('s').accept({viewCursor:next,viewDelta:{baseCursor:cursor,set:edits,remove:[]}});cursor=next;return result
 }})
 live.setView('s',first)
 let notices=0
 const stop=live.subscribe('s',()=>notices++,[['inputSources'],['inputSources','1']])
 live.subscribe('s',()=>{},[['mode']]);notices=0
 edits=[[['inputSources','1'],'new']];jobs.shift()();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(notices,1)
 stop();live.invalidate('s');jobs.shift()();await new Promise(resolve=>setImmediate(resolve))
 assert.equal(notices,1)
})

test('overlapping selections preserve immutable parents and root selection returns full snapshot',()=>{
 const h=harness(),live=h.createLiveTavernViewModule({load:async()=>null,pollWhileBusy:false})
 const inputSources=Object.freeze({'1':'one'}),view=Object.freeze({inputSources})
 live.setView('s',view)
 const selection=live.select('s',[['inputSources','1'],['inputSources'],['inputSources']])
 assert.equal(selection.getSnapshot().view.inputSources,inputSources)
 assert.equal(live.select('s',[[]]).getSnapshot(),live.getSnapshot('s'))
})
