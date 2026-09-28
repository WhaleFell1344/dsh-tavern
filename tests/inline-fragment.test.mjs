import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {JSDOM} from 'jsdom'

async function harness() {
  const dom = new JSDOM('<style>.example-bubble{display:flex}.example-bubble img{width:52px}</style><main></main>')
  let descriptor, effect
  const root = dom.window.document.querySelector('main')
  const React = {createElement:(type,props,...children)=>({type,props,children}),useRef:()=>({current:root}),useLayoutEffect:run=>{effect=run}}
  vm.runInNewContext(await readFile(new URL('../tavern-plugin/lib/client.js',import.meta.url),'utf8'),{window:{document:dom.window.document,__ModuleLoader__:{load:value=>descriptor=value}},console})
  return {dom,root,client:descriptor.factory(name=>name==='react'?React:{}),mount:()=>effect()}
}

test('trusted reply fragments share host styles and hydration without a frame',async()=>{
  const h=await harness()
  try {
    const content='<div class="example-bubble" data-speaker="Example"><img alt="avatar"><span>Hello</span></div>'
    const observer=new h.dom.window.MutationObserver(()=>{
      const bubble=h.dom.window.document.querySelector('.example-bubble')
      if(bubble) bubble.dataset.hydrated='true'
    })
    observer.observe(h.dom.window.document.body,{childList:true,subtree:true})
    const [part]=h.client.renderTavernProjection({parts:[{kind:'html',content}]},{trustedCardMode:true})
    assert.equal(part.type,h.client.TavernInlineFragment)
    part.type(part.props);const cleanup=h.mount()
    await new Promise(resolve=>setImmediate(resolve))
    const bubble=h.root.querySelector('.example-bubble')
    assert.equal(h.dom.window.getComputedStyle(bubble).display,'flex')
    assert.equal(bubble.dataset.hydrated,'true')
    assert.equal(bubble.textContent,'Hello')
    cleanup();assert.equal(h.root.children.length,0);observer.disconnect()
  }finally{h.dom.window.close()}
})

test('untrusted fragments, previews, active HTML and full documents retain iframe rendering',async()=>{
  const h=await harness()
  try{
    for(const [content,options] of [
      ['<div>hello</div>',{trustedCardMode:false}],
      ['<div>hello</div>',{trustedCardMode:true,openingPreview:{}}],
      ...['<script>void 0</script>','<style>body{color:red}</style>','<img src=x onerror="alert(1)">','<a href="java&#10;script:alert(1)">x</a>','<svg onload="alert(1)"></svg>','<iframe srcdoc="hello"></iframe>','<!doctype html><html><body>hello</body></html>'].map(content=>[content,{trustedCardMode:true}])
    ]){
      const [part]=h.client.renderTavernProjection({parts:[{kind:'html',content}]},options)
      assert.equal(part.type,h.client.TavernMessageFrame,content)
    }
  }finally{h.dom.window.close()}
})
