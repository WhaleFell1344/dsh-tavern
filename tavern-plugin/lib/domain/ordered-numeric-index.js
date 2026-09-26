// Persistent compressed radix tree over IEEE-754 numeric keys. At most sixteen
// nibble levels; insertion/removal never shifts a sorted array's suffix.
export function createOrderedNumericIndex({visit=()=>{},measure=()=>0}={}) {
  const states=new WeakMap(),buffer=new DataView(new ArrayBuffer(8))
  function digits(key) {
    if(typeof key!=='number' || Number.isNaN(key))throw new Error('Invalid ordered numeric key')
    buffer.setFloat64(0,key===0?0:key)
    let high=buffer.getUint32(0),low=buffer.getUint32(4)
    if(high>>>31){high=(~high)>>>0;low=(~low)>>>0}else high=(high^0x80000000)>>>0
    const result=[]
    for(const word of [high,low])for(let shift=28;shift>=0;shift-=4)result.push((word>>>shift)&15)
    return result
  }
  const leaf=(key,value)=>({key,value,count:1,bytes:48+measure(value)})
  function branch(depth,key,slots){
    let count=0,bytes=160,children=0,last
    for(const item of slots)if(item){count+=item.count;bytes+=item.bytes;children++;last=item}
    return children===0?undefined:children===1?last:{depth,key,slots,count,bytes}
  }
  function put(node,path,key,value,mutable=false) {
    visit()
    if(!node)return value===undefined?undefined:leaf(key,value)
    const other=digits(node.key),limit=node.slots?node.depth:16
    let split=0
    while(split<limit && other[split]===path[split])split++
    if(split<limit){
      if(value===undefined)return node
      const slots=[];slots[other[split]]=node;slots[path[split]]=leaf(key,value)
      return branch(split,node.key,slots)
    }
    if(!node.slots)return value===undefined?undefined:node.value===value?node:leaf(key,value)
    const digit=path[node.depth],child=put(node.slots[digit],path,key,value,mutable)
    if(child===node.slots[digit])return node
    const slots=mutable?node.slots:node.slots.slice();slots[digit]=child
    return branch(node.depth,node.key,slots)
  }
  function at(root,position) {
    let node=root
    while(node?.slots){
      visit()
      if(position<0 || position>=node.count)return undefined
      for(const child of node.slots){if(!child)continue;if(position<child.count){node=child;break}position-=child.count}
    }
    return position===0?node?.value:undefined
  }
  function view(root) {
    const length=root?.count || 0
    const numeric=key=>typeof key==='string' && /^(0|[1-9]\d*)$/.test(key) && Number(key)<length
    const array=new Proxy([],{
      get(target,key,receiver){return key==='length'?length:numeric(key)?at(root,Number(key)):Reflect.get(target,key,receiver)},
      has(target,key){return numeric(key)||Reflect.has(target,key)},
      ownKeys(){return [...Array.from({length},(_,id)=>String(id)),'length']},
      getOwnPropertyDescriptor(target,key){
        if(numeric(key))return {value:at(root,Number(key)),enumerable:true,writable:false,configurable:true}
        const descriptor=Reflect.getOwnPropertyDescriptor(target,key)
        return key==='length'?{...descriptor,value:length}:descriptor
      },
      set(){throw new Error('Ordered index is immutable')},defineProperty(){throw new Error('Ordered index is immutable')},deleteProperty(){throw new Error('Ordered index is immutable')}
    })
    states.set(array,root);return array
  }
  function from(entries){let root;for(const [key,value] of entries)root=put(root,digits(key),key,value,true);return view(root)}
  function update(source,entries){if(!states.has(source))throw new Error('Unknown ordered index');let root=states.get(source);for(const [key,value] of entries)root=put(root,digits(key),key,value);return root===states.get(source)?source:view(root)}
  function get(source,key){let node=states.get(source);const path=digits(key);while(node?.slots){visit();node=node.slots[path[node.depth]]}visit();return node?.key===key?node.value:undefined}
  function rank(source,key){
    let node=states.get(source),position=0;const path=digits(key)
    while(node?.slots){
      visit();const prefix=digits(node.key)
      for(let i=0;i<node.depth;i++)if(prefix[i]!==path[i])return position+(prefix[i]<path[i]?node.count:0)
      const digit=path[node.depth];for(let i=0;i<digit;i++)position+=node.slots[i]?.count || 0
      node=node.slots[digit]
    }
    return position+(node && node.key<key?1:0)
  }
  function changed(before,after){
    if(!states.has(before)||!states.has(after))return null
    const result=[]
    function collect(node,rows){if(!node)return;if(node.slots){for(const child of node.slots)collect(child,rows)}else rows.set(node.key,node.value)}
    function walk(left,right){
      visit();if(left===right)return
      if(left?.slots && right?.slots && left.depth===right.depth && digits(left.key).slice(0,left.depth).join()===digits(right.key).slice(0,right.depth).join()){
        for(let id=0;id<16;id++)if(left.slots[id]!==right.slots[id])walk(left.slots[id],right.slots[id]);return
      }
      if(left && right && !left.slots && !right.slots && left.key===right.key){result.push({key:right.key,before:left.value,after:right.value});return}
      const a=new Map(),b=new Map();collect(left,a);collect(right,b)
      for(const key of new Set([...a.keys(),...b.keys()]))if(a.get(key)!==b.get(key))result.push({key,before:a.get(key),after:b.get(key)})
    }
    walk(states.get(before),states.get(after));return result
  }
  return {from,update,get,rank,changed,info:source=>states.has(source)?{count:states.get(source)?.count||0,bytes:states.get(source)?.bytes||0}:null}
}
