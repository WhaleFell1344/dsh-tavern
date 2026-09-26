// Cached session views are immutable, like the React views returned by getSession.
function createSessionViewReader(maxSessions = 4) {
  const sessions = new Map();
  const index = createSessionViewReader.indexApi ||= createIndexedArrayApi();
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
            if (incrementalMessages && messagePath(path)) continue;
            const target = parent(path), key = path[path.length - 1];
            if (!(Array.isArray(target) && key === "length")) delete target[key];
          }
          for (const [path, value] of result.viewDelta.set) {
            if (incrementalMessages && messagePath(path)) continue;
            parent(path)[path[path.length - 1]] = value;
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
