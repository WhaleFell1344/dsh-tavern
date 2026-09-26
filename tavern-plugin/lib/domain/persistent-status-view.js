import { statusViewDeclaration } from './status-view-declaration.js'
import { createHash } from 'node:crypto'
import { applyTavernRegexText } from './tavern-regex-display.js'
import { projectDisplayParts, resolveDisplayIdentityMacros } from './reply-presentation.js'

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
  const removedParts = new Set()
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
      for (const projection of sourceProjections) {
        const parts = (projection.parts || []).filter(part => String(part.kind === 'html' ? contentOf(part) : part.text || '').trim())
        const matches = part => part.kind === 'html' && (part.statusKey ? part.statusKey === declaration.key : contentOf(part) === content || legacyMatches(part, projection, rule))
        const index = parts.findIndex(matches)
        if (index >= 0) {
          for (const part of parts.filter(matches)) removedParts.add(part)
          origin = { sourceTurn: projection.turn, sourcePartIndex: index }
          // Fixed HTML follows the latest card template. Stateful EJS history
          // and source-dependent regex replacements retain their captured output;
          // do not replay historical side effects or serve raw EJS.
          if (/<%|&lt;%/.test(String(rule.replaceString)) || /\$\d+|\$<[^>]+>|\{\{match\}\}/i.test(String(rule.replaceString))) templateContent = resolveDisplayIdentityMacros(contentOf(parts[index]), options)
        }
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

  return {
    projections: sourceProjections.map(projection => {
      const parts = (projection.parts || []).filter(part => !(part.kind === 'html' && (contents.has(contentOf(part)) || removedParts.has(part))))
      return parts.length === (projection.parts || []).length ? projection : { ...projection, parts, text: parts.map(part => part.kind === 'html' ? contentOf(part) : part.text || '').join('') }
    }),
    statusView: statusViews[0] || null,
    statusViews
  }
}


/** Cache only rule compilation; message origins and target turns remain live. */
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
