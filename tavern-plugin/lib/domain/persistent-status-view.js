import { statusViewDeclaration } from './status-view-declaration.js'
import { createIndexedArrayApi } from './indexed-array.js'
import { createImmutableJsonIndex, immutableArrayChanges } from './freeze-json.js'
import { createHash } from 'node:crypto'
import { applyTavernRegexText } from './tavern-regex-display.js'
import { projectDisplayParts, resolveDisplayIdentityMacros } from './reply-presentation.js'

const matchIndex = createIndexedArrayApi({eligible:row=>Boolean(row?.origin),maximum:row=>row?.legacy?1:0,measure:row=>JSON.stringify([row.origin,row.content,[...row.removed]]).length*2})
const filteredIndex = createImmutableJsonIndex({measure:row=>JSON.stringify(row).length*2})

function contentOf(part) {
  return String(part && (part.content ?? part.html) || '')
}

/** Only an explicit display declaration creates a persistent panel. MVU reads
 * are diagnostic evidence, never authority to move an interactive document. */
function projectStatusView(messages, projections, options, compile, summary) {
  const sourceMessages = Array.isArray(messages) ? messages : []
  const sourceProjections = Array.isArray(projections) ? projections : []
  let inferredTurn = 1
  let latestTurn = summary?.latestTurn ?? 1
  if (!summary) for (const message of sourceMessages) {
    if (message?.role === 'user') inferredTurn++
    if (message?.role === 'assistant') latestTurn = Math.max(latestTurn, Number(message.turn) || inferredTurn)
  }
  const templates = new Map()
  const prior = summary?.previous
  const changes = prior ? immutableArrayChanges(prior.source,sourceProjections) : null
  const matchStates = new Map()
  let legacy = false
  const rules = Array.isArray(options.regexScripts) ? options.regexScripts : []
  const enabled = rules.filter(rule => rule && rule.disabled !== true && rule.enabled !== false)
  function legacyMatches(part, projection, rule) {
    if (!Number.isInteger(part.statusRule)) return false
    const message = sourceMessages.find(message => message.role === 'assistant' && (Number(message.turn) || 1) === projection.turn)
    const source = String(message?.sourceText ?? message?.text ?? '')
    // Old captures have only an array index. Recover solely when the original
    // source names exactly one status declaration; never guess from MVU reads.
    const candidates = enabled.filter(candidate => statusViewDeclaration(candidate) && applyTavernRegexText(source, [candidate], { placement: 2, isMarkdown: true, depth: 0 }).changed)
    return candidates.length === 1 && candidates[0] === rule
  }
  for (const rule of rules) {
    if (!rule || rule.disabled === true || rule.enabled === false) continue
    const declaration = statusViewDeclaration(rule)
    if (!declaration) continue
    for (const [templateIndex, { content, revision }] of compile(declaration.marker, rule, options).entries()) {
      if (templates.has(revision)) continue
      let origin = null
      let templateContent = content
      const viewId = 'status-' + createHash('sha256').update(declaration.key + ':' + templateIndex).digest('hex').slice(0, 16)
      const matchKey = declaration.key + ':' + templateIndex + ':' + revision
      const oldMatches = prior?.matches.get(matchKey)
      function match(projection) {
        summary?.onMatch?.()
        const parts = (projection.parts || []).filter(part => String(part.kind === 'html' ? contentOf(part) : part.text || '').trim())
        const matches = part => part.kind === 'html' && (part.statusKey ? part.statusKey === declaration.key : contentOf(part) === content || legacyMatches(part, projection, rule))
        const index = parts.findIndex(matches)
        return {
          origin:index < 0 ? null : {sourceTurn:projection.turn,sourcePartIndex:index},
          content:index < 0 ? content : resolveDisplayIdentityMacros(contentOf(parts[index]),options),
          removed:new Set(index < 0 ? [] : parts.filter(matches)),
          legacy:parts.some(part=>!part.statusKey && Number.isInteger(part.statusRule))
        }
      }
      let candidates
      if (oldMatches && changes && matchIndex.maximum(oldMatches)===0) {
        candidates=matchIndex.update(oldMatches,changes.map(id=>[id,match(sourceProjections[id])]),sourceProjections.length)
      } else candidates=matchIndex.from(sourceProjections.map(match))
      matchStates.set(matchKey,candidates)
      legacy ||= matchIndex.maximum(candidates)>0
      const last=matchIndex.previous(candidates,candidates.length)
      if(last>=0){
        origin=candidates[last].origin
        // Captured dynamic templates retain the latest matching source output.
        if (/<%|&lt;%/.test(String(rule.replaceString)) || /\$\d+|\$<[^>]+>|\{\{match\}\}/i.test(String(rule.replaceString))) templateContent=candidates[last].content
      }
      if (!origin && !/<%|&lt;%|\$\d+|\$<[^>]+>|\{\{match\}\}/i.test(String(rule.replaceString))) {
        // Template synchronization can remove the rendered marker before the
        // browser's sidebar capture arrives. The authored opening declaration
        // remains authority; panel lifetime must not depend on that receipt.
        for (const message of sourceMessages) {
          if (message.role !== 'assistant' || message.greeting !== true) continue
          const source = String(message.sourceText ?? message.text ?? '')
          if (applyTavernRegexText(source, [rule], { placement: 2, isMarkdown: true, isEdit: false, depth: 0 }).changed) {
            origin = { sourceTurn: Number(message.turn) || 1, sourcePartIndex: 0 }
          }
        }
      }
      if (!origin) {
        for (const message of sourceMessages) {
          const frame = message.displayRuntime?.frames?.find(frame => frame.placement === 'sidebar' && (frame.panelId === viewId || frame.panelId === 'status-' + revision))
          if (frame) origin = { sourceTurn: Number(message.turn) || 1, sourcePartIndex: Number(frame.partIndex) || 0 }
        }
      }
      if (latestTurn <= 1 && !origin) continue
      templates.set(revision, {
        version: 1, viewId,
        title: String(rule.name || rule.scriptName || '角色状态').slice(0, 80),
        sourceTurn: origin?.sourceTurn || latestTurn, sourcePartIndex: origin?.sourcePartIndex || 0,
        targetTurn: latestTurn, templateRevision: revision, content: templateContent
      })
    }
  }
  const statusViews = [...templates.values()]
  const contents = new Set(statusViews.map(view => view.content))

  const legacyRemoved = new Set()
  if(legacy) for(const rows of matchStates.values()) for(const row of rows) for(const part of row.removed) legacyRemoved.add(part)
  const matchedRows=[...matchStates.values()]
  function filter(projection,id) {
    summary?.onFilter?.()
    const parts=(projection.parts || []).filter(part=>!(part.kind==='html' && (contents.has(contentOf(part)) || legacyRemoved.has(part) || matchedRows.some(rows=>rows[id]?.removed.has(part)))))
    return parts.length===(projection.parts || []).length ? projection : {...projection,parts,text:parts.map(part=>part.kind==='html'?contentOf(part):part.text || '').join('')}
  }
  const contentSignature=JSON.stringify([...contents])
  const incremental=summary && prior && changes && !legacy && !prior.legacy && prior.contentSignature===contentSignature
  const filtered=incremental ? filteredIndex.update(prior.filtered,changes.map(id=>[id,filter(sourceProjections[id],id)]),sourceProjections.length)
    : summary ? filteredIndex.from(sourceProjections.map(filter)) : sourceProjections.map(filter)
  if(summary){
    summary.next={source:sourceProjections,matches:matchStates,filtered,contentSignature,legacy}
    summary.filteredBytes=filteredIndex.info(filtered).bytes + matchedRows.reduce((size,rows)=>size+matchIndex.info(rows).bytes,0)
  }
  return {
    projections: filtered,
    statusView: statusViews[0] || null,
    statusViews
  }
}


/** Rule compilation is shared. Incremental match state belongs to the caller
 * that supplies a versioned immutable projection and retains its summary. */
export function createPersistentStatusProjector({ maxCacheBytes = 4 * 1024 * 1024, maxCacheEntries = 128 } = {}) {
  const cache = new Map()
  let bytes = 0, hits = 0, misses = 0
  function compile(marker, rule, options) {
    const key = createHash('sha256').update(JSON.stringify([marker, rule, options.charName, options.macroState?.userName, options.allowStaticStatus])).digest('hex')
    const previous = cache.get(key)
    if (previous) {
      hits++; cache.delete(key); cache.set(key, previous)
      return previous.value
    }
    misses++
    const rendered = applyTavernRegexText(marker, [rule], { placement: 2, isMarkdown: true, isEdit: false, depth: 0 })
    const value = []
    if (rendered.changed) for (const part of projectDisplayParts(rendered.text).parts) {
      const content = resolveDisplayIdentityMacros(contentOf(part), options)
      if (part.kind !== 'html' || (!options.allowStaticStatus && !/<(?:script|iframe|object|embed)\b/i.test(content))) continue
      value.push({ content, revision: createHash('sha256').update(content).digest('hex').slice(0, 16) })
    }
    const size = JSON.stringify(value).length * 2 + 256
    if (size <= maxCacheBytes && maxCacheEntries > 0) {
      while (cache.size && (bytes + size > maxCacheBytes || cache.size >= maxCacheEntries)) {
        const oldest = cache.keys().next().value
        bytes -= cache.get(oldest).size; cache.delete(oldest)
      }
      cache.set(key, { value, size }); bytes += size
    }
    return value
  }
  const project = (messages, projections, options = {}, summary) => projectStatusView(messages, projections, options, compile, summary)
  project.cacheStats = () => ({ entries: cache.size, estimatedBytes: bytes, hits, misses })
  return project
}

export const projectPersistentStatusView = createPersistentStatusProjector()
