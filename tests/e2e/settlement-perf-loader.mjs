const mark = stage => `console.log('[settlement-perf]'+JSON.stringify({stage:${JSON.stringify(stage)},at:performance.timeOrigin+performance.now()}));`
export async function load(url, context, next) {
  const result = await next(url, context)
  if (!url.includes('/tavern-plugin/lib/domain/')) return result
  let source = String(result.source)
  const replace = (from, to) => { if (!source.includes(from)) throw Error('Performance probe seam changed: ' + url + ' ' + from); source = source.replace(from, to) }
  if (url.endsWith('/mvu-background-settlement.js')) {
    replace("      await record('submitted', { operations: submission.operations })", mark('submitted') + "\n      await record('submitted', { operations: submission.operations })")
    replace('    const applied = await options.runtime.settleMvuUpdate({', mark('runtime-start') + '\n    const applied = await options.runtime.settleMvuUpdate({')
    replace('    if (applied.deferred === true || applied.stale === true)', mark('runtime-return') + '\n    if (applied.deferred === true || applied.stale === true)')
    replace("    await record('finished', { status: result.receipt.status })", mark('settlement-return') + "\n    await record('finished', { status: result.receipt.status })")
  } else if (url.endsWith('/tavern-script-host-adapter.js')) {
    replace('      async function executionContext(baseline) {', "      async function executionContext(baseline) {\nconsole.log('[settlement-perf]'+JSON.stringify({stage:'context-baseline',at:performance.timeOrigin+performance.now(),baseline,currentRevision:current._storageRevision,currentMessages:current.messages.length}));")
    replace("            const changed = await options.resolveChangedChatSlice?.(sessionId, baseline.stateRevision, 'settlement')", "            const changed = await options.resolveChangedChatSlice?.(sessionId, baseline.stateRevision, 'settlement')\nconsole.log('[settlement-perf]'+JSON.stringify({stage:'context-changes',at:performance.timeOrigin+performance.now(),available:Boolean(changed),layoutChanged:changed?.layoutChanged,layoutFrom:changed?.layoutFrom,count:changed?.indices?.length,baseRevision:changed?.baseRevision,revision:changed?.chat?._storageRevision}));")
    replace('        if (!indices) return projected', "console.log('[settlement-perf]'+JSON.stringify({stage:'execution-context',at:performance.timeOrigin+performance.now(),compact:Boolean(indices),messages:projected.messages.length,total:current.messages.length}));\n        if (!indices) return projected")
    replace("      const dispatched = await options.scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED'", "console.log('[settlement-perf]'+JSON.stringify({stage:'dispatch-start',at:performance.timeOrigin+performance.now(),eventId:transaction.eventId}));\n      const dispatched = await options.scriptDispatch.dispatch(sessionId, 'MESSAGE_RECEIVED'")
  } else if (url.endsWith('/background-task-coordinator.js')) {
    replace('      async commit(input = {}) {', '      async commit(input = {}) {\n' + mark('commit-start') + '\ntry {')
    replace('      },\n      async fail(trace)', '} finally {' + mark('commit-return') + '}\n      },\n      async fail(trace)')
  } else if (url.endsWith('/chat-journal-store.js')) {
    replace('    if (bytes > cacheMaxBytes) return', "    if (bytes > cacheMaxBytes) { console.log('[settlement-perf]'+JSON.stringify({stage:'cache-oversized',at:performance.timeOrigin+performance.now(),bytes,limit:cacheMaxBytes,revision:state.revision})); return }")
    replace("    await appendFile(openPath, encodeFrame(frame), 'utf8')", "    await appendFile(openPath, encodeFrame(frame), 'utf8')\n" + "console.log('[settlement-perf]'+JSON.stringify({stage:'journal-appended',at:performance.timeOrigin+performance.now(),source:frame.source,revision:frame.revision}));")
  }
  return { ...result, source }
}
