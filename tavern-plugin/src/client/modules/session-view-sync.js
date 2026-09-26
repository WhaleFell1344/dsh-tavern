// Cached session views are immutable, like the React views returned by getSession.
function createSessionViewReader(maxSessions = 4) {
  const sessions = new Map();
  const index = createSessionViewReader.indexApi ||= createIndexedArrayApi();
  const receiptLookup = createSessionViewReader.receiptLookup ||= createReceiptTurnLookup(index,createSessionViewReader.onReceiptLookupVisit);
  let sequence = 0;
  return function begin(sessionId) {
    const base = sessions.get(sessionId);
    const requestSequence = ++sequence;
    return {
      cursor: base && base.cursor,
      accept(result) {
        let view = result.view;
        if (result.viewDelta) {
          if (!base || result.viewDelta.baseCursor !== base.cursor) throw new Error("会话增量已过期，请重新读取");
          view = Object.assign({}, base.view);
          const copied = new Set();
          const messagePath = path => path[0] === "tavernHelper" && path[1] === "messages" && path.length === 3;
          const messageEdits = result.viewDelta.set.filter(([path]) => messagePath(path));
          const messageRemovals = result.viewDelta.remove.filter(messagePath);
          const incrementalMessages = Array.isArray(base.view?.tavernHelper?.messages)
            && !result.viewDelta.set.some(([path]) => path[0] === "tavernHelper" && path.length < 3)
            && !result.viewDelta.remove.some(path => path[0] === "tavernHelper" && path.length < 3)
            && messageRemovals.every(path => typeof path[2] === "number")
            && messageEdits.every(([path]) => path[2] === "length" || Number.isSafeInteger(path[2]));

          const receiptPath = path => path[0] === "mvuReceipts" && path.length === 2;
          const receiptEdits = result.viewDelta.set.filter(([path]) => receiptPath(path));
          const receiptRemovals = result.viewDelta.remove.filter(receiptPath);
          const incrementalReceipts = Array.isArray(base.view?.mvuReceipts)
            && !result.viewDelta.set.some(([path]) => path[0] === "mvuReceipts" && path.length < 2)
            && !result.viewDelta.remove.some(path => path[0] === "mvuReceipts" && path.length < 2)
            && receiptRemovals.every(path => Number.isSafeInteger(path[1]))
            && receiptEdits.every(([path]) => path[1] === "length" || Number.isSafeInteger(path[1]));

          function parent(path) {
            let target = view;
            for (let i = 0; i < path.length - 1; i++) {
              const key = path[i];
              const id = JSON.stringify(path.slice(0, i + 1));
              if (!copied.has(id)) {
                const old = target[key];
                target[key] = Array.isArray(old) ? old.slice() : (path[i + 1] === "length" || typeof path[i + 1] === "number" ? [] : Object.assign({}, old));
                copied.add(id);
              }
              target = target[key];
            }
            return target;
          }
          // Remove old descendants before replacing a parent with null or a new object.
          for (const path of result.viewDelta.remove.slice().sort((a, b) => b.length - a.length)) {
            if (incrementalMessages && messagePath(path) || incrementalReceipts && receiptPath(path)) continue;
            const target = parent(path), key = path[path.length - 1];
            if (!(Array.isArray(target) && key === "length")) delete target[key];
          }
          for (const [path, value] of result.viewDelta.set) {
            if (incrementalMessages && messagePath(path) || incrementalReceipts && receiptPath(path)) continue;
            parent(path)[path[path.length - 1]] = value;
          }
          if (incrementalReceipts) {
            const old = base.view.mvuReceipts;
            const length = receiptEdits.find(([path]) => path[1] === "length")?.[1] ?? old.length;
            const entries = receiptEdits.filter(([path]) => path[1] !== "length").map(([path,value]) => [path[1],value]);
            if (receiptRemovals.some(path => path[1] < length)) throw new Error("Invalid sparse receipt delta");
            view.mvuReceipts = index.update(old,entries,length);
            receiptLookup.remember(view.mvuReceipts,old,entries);
          }
          if (incrementalMessages) {
            const old = base.view.tavernHelper.messages;
            const length = messageEdits.find(([path]) => path[2] === "length")?.[1] ?? old.length;
            const entries = messageEdits.filter(([path]) => path[2] !== "length").map(([path,value]) => [path[2],value]);
            // The protocol emits removals only for a truncated tail.
            if (messageRemovals.some(path => path[2] < length)) throw new Error("Invalid sparse message delta");
            view.tavernHelper = {...view.tavernHelper,messages:index.update(old,entries,length)};
          }
        }
        if (Array.isArray(view?.tavernHelper?.messages)) {
          view = {...view,tavernHelper:{...view.tavernHelper,messages:index.from(view.tavernHelper.messages)}};
        }
        if (Array.isArray(view?.mvuReceipts)) {
          view = {...view,mvuReceipts:index.from(view.mvuReceipts)};
          receiptLookup.remember(view.mvuReceipts);
        }
        const latest = sessions.get(sessionId);
        if (!latest || latest.sequence < requestSequence) {
          sessions.delete(sessionId);
          sessions.set(sessionId, { view, cursor: result.viewCursor, sequence: requestSequence });
          while (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
        }
        return Object.assign({}, result, { view });
      }
    };
  };
}

// Weak array-version keys preserve concurrent/older views without retaining them.
function createReceiptTurnLookup(index,onVisit = () => {}) {
  const versions = new WeakMap();
  // Number-to-string has bounded length for IEEE-754 turns, including infinities.
  // A character trie avoids history-sized Map copies while retaining old roots.
  const turnKey = value => { const turn=Number(value); return Number.isNaN(turn) ? null : String(turn); };
  function get(root,key) {
    let node=root;
    for (const character of key) { onVisit(); node=node?.[character]; }
    return node?.$;
  }
  function put(root,key,value,offset=0) {
    onVisit();
    const next={...root}, character=offset===key.length ? "$" : key[offset];
    const child=offset===key.length ? value : put(root?.[character],key,value,offset+1);
    if (child===undefined) delete next[character]; else next[character]=child;
    return Object.keys(next).length ? next : undefined;
  }
  function change(root,key,id,row) {
    if (key===null) return root;
    const old=get(root,key);
    let next;
    if (old?.rows) {
      const rows=index.update(old.rows,[[id,row]],Math.max(old.rows.length,id+1));
      const count=index.info(rows).eligible;
      if (count>1) next={rows};
      else if (count===1) { const last=index.previous(rows,rows.length); next={id:last,row:rows[last]}; }
    } else if (row!==undefined) {
      next=old && old.id!==id
        ? {rows:index.update([],[[old.id,old.row],[id,row]],Math.max(old.id,id)+1)} : {id,row};
    } else if (old?.id!==id) next=old;
    return put(root,key,next);
  }
  function remember(rows,before,entries) {
    if (versions.has(rows)) return;
    let root;
    if (before && versions.has(before)) {
      root=versions.get(before);
      const changed=new Map(entries);
      // Clear all old owners first, so swaps and duplicate-turn promotion work.
      for (const [id] of changed) if (id<before.length) root=change(root,turnKey(before[id]?.turn),id,undefined);
      for (let id=rows.length;id<before.length;id++) if (!changed.has(id)) root=change(root,turnKey(before[id]?.turn),id,undefined);
      for (const [id,row] of changed) if (id<rows.length) root=change(root,turnKey(row?.turn),id,row);
    } else {
      for (let id=0;id<rows.length;id++) { const row=rows[id]; root=change(root,turnKey(row?.turn),id,row); }
    }
    versions.set(rows,root);
  }
  function read(rows,turn) {
    const key=turnKey(turn);
    if (key===null) return null;
    const bucket=get(versions.get(rows),key);
    const row=bucket?.rows ? bucket.rows[index.previous(bucket.rows,bucket.rows.length)] : bucket?.row;
    return row?.receipt || null;
  }
  return {remember,read,has:rows=>versions.has(rows)};
}
