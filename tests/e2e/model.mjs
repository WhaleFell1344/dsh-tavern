import { recoveryBlocks } from './recovery-model.mjs'
import { compactionStream, modelCapacity } from './compaction-model.mjs'
// The only substituted boundary: fixed provider output. Tools execute normally.
import { appendFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { LlmAdapter } = await import(pathToFileURL(process.env.TAVERN_E2E_LLM_MODULE))
export const inject = ['llm']
export function apply(ctx) {
  class Model extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: 'E2E fixed model', ...(process.env.TAVERN_E2E_COMPACTION_DIR ? { defaultMaxTokens: 8192 } : {}), context: { contextWindow: process.env.TAVERN_E2E_COMPACTION_DIR ? await modelCapacity() : 64000 } }
    }
    async *stream(input) {
      if (process.env.TAVERN_E2E_COMPACTION_DIR) { yield* compactionStream(input); return }
      const tools = new Set((input.tools || []).map(tool => tool.name))
      if (process.env.TAVERN_E2E_MEMORY_AUDIT) {
        await appendFile(process.env.TAVERN_E2E_MEMORY_AUDIT, JSON.stringify({ system: input.system, messages: input.messages, tools: input.tools }) + '\n')
        if (tools.has('tavern_memory_search')) {
          const text = JSON.stringify(input.messages)
          const done = input.messages.some(message => (message.content || []).some(block => block.type === 'tool-result' && block.toolCallId === 'memory-preference-save'))
          const block = text.includes('E2E_MEMORY_NEXT') ? { type: 'text', text: '已读取改卡偏好。' }
            : text.includes('E2E_MEMORY_SAVE') && !done ? { type: 'tool-call', id: 'memory-preference-save', name: 'tavern_memory_preference', arguments: JSON.stringify({ action: 'add', content: '保留原卡结构，不重写开场白' }) }
            : { type: 'text', text: done ? '改卡偏好已保存。' : '卡片工作台就绪。' }
          yield { type: 'block-start', index: 0, blockType: block.type }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
          return
        }
      }
      const recovery = await recoveryBlocks(input, tools)
      if (recovery) {
        for (const [index, block] of recovery.entries()) {
          yield { type: 'block-start', index, blockType: block.type }
          yield { type: 'block-end', index, block }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      let heldAttempt
      if (process.env.TAVERN_E2E_BACKGROUND_DIR && tools.has('mvu_submit_update')) {
        const file = process.env.TAVERN_E2E_BACKGROUND_DIR + '/background-control.json'
        const control = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))
        if (control.mode === 'hold') {
          heldAttempt = control.attempt
          await appendFile(process.env.TAVERN_E2E_BACKGROUND_DIR + '/background-attempts.jsonl', JSON.stringify({attempt:control.attempt})+'\n')
          // Deliberately ignore cancellation: the host must reject any late tool call.
          const deadline=Date.now()+60000
          while(Date.now()<deadline && JSON.parse(await readFile(file,'utf8')).mode==='hold') await new Promise(resolve=>setTimeout(resolve,50))
        }
      }
      const done = new Set(input.messages.flatMap(message => message.content || [])
        .filter(block => block.type === 'tool-result').map(block => block.toolCallId))
      const text = JSON.stringify(input.messages)
      const presetRound = [70, 60, 50].find(value => text.includes(`E2E 预设验收 ${value}`) || text.includes(`预设切换后继续游玩，金币 ${value}。`))
      const cardUpdate = (text.includes('E2E 更新后继续') || text.includes('更新后的世界中，你又获得十枚金币'))
      const perf = process.env.TAVERN_E2E_PERFORMANCE_DIR ? JSON.parse(await readFile(process.env.TAVERN_E2E_PERFORMANCE_DIR + '/performance-control.json', 'utf8').catch(() => 'null')) : null
      const gold = perf?.gold ?? (cardUpdate ? 20 : presetRound || (text.includes('E2E 修正金币为四十') ? 40 : (text.includes('雨夜重写') || text.includes('雨夜里')) ? 30 : (text.includes('再次领取奖励') || text.includes('金币累计二十枚')) ? 20 : 10))
      const goldId = perf ? 'perf-gold-' + perf.id : 'e2e-gold-' + gold, postureId = 'e2e-posture-' + gold
      const blocks = []
      if (tools.has('candidate_submit_choices')) blocks.push({ type: 'tool-call', id: 'e2e-choices', name: 'candidate_submit_choices', arguments: JSON.stringify({ actions: ['再次领取奖励', '向店主道谢', '查看任务告示', '清点背包'], scene: '夜幕降临酒馆' }) })
      if (tools.has('mvu_submit_update') && !done.has(goldId)) blocks.push({
        type: 'tool-call', id: goldId, name: 'mvu_submit_update',
        arguments: JSON.stringify({ operations: [{ op: 'replace', path: cardUpdate ? '/stat_data/coins' : '/stat_data/gold',
          valueJson: process.env.TAVERN_E2E_WRONG_GOLD === '1' ? '9' : String(gold) }] })
      })
      if (tools.has('posture_submit') && !done.has(postureId)) blocks.push({
        type: 'tool-call', id: postureId, name: 'posture_submit',
        arguments: JSON.stringify({ posture: '站在柜台前，收下奖励。' })
      })
      if (!blocks.length) blocks.push({ type: 'text', text: (cardUpdate ? '更新后的世界中，你又获得十枚金币。' : presetRound ? `预设切换后继续游玩，金币 ${gold}。` : gold === 30 ? '雨夜里，你重新领取了奖励。' : gold === 20 ? '你再次领取了奖励，金币累计二十枚。' : '你获得了十枚金币。') + (process.env.TAVERN_E2E_PERFORMANCE_DIR && process.env.TAVERN_PERF_HISTORY_READY === '1' ? '\n' + '这是性能测试的合成剧情，不对应真实存档。'.repeat(Number(process.env.TAVERN_PERF_BODY_REPEATS || 60)) : '') + '\n\n<StatusPlaceHolderImpl/>' })
      if (cardUpdate && process.env.TAVERN_E2E_REQUEST_AUDIT) await appendFile(process.env.TAVERN_E2E_REQUEST_AUDIT, JSON.stringify({cardUpdate:true,newWorldbook:text.includes(tools.has('mvu_submit_update') ? 'E2E_LIVE_MVU_RULES_V2' : 'E2E_LIVE_WORLDBOOK_V2'),settlement:tools.has('mvu_submit_update') || tools.has('posture_submit')})+'\n')
      if (presetRound && blocks.some(block => block.type === 'text') && process.env.TAVERN_E2E_REQUEST_AUDIT) {
        await appendFile(process.env.TAVERN_E2E_REQUEST_AUDIT, JSON.stringify({ gold,
          presetA: text.includes('E2E_PRESET_A_ACTIVE'), presetB: text.includes('E2E_PRESET_B_ACTIVE'),
          settlement: tools.has('mvu_submit_update') || tools.has('posture_submit') }) + '\n')
      }
      // Put the state-changing call first so cancellation is tested against an MVU write.
      if (heldAttempt !== undefined) blocks.sort((a, b) => Number(b.name === 'mvu_submit_update') - Number(a.name === 'mvu_submit_update'))
      for (const [index, block] of blocks.entries()) {
        if (heldAttempt !== undefined && block.type === 'tool-call') await appendFile(process.env.TAVERN_E2E_BACKGROUND_DIR + '/background-late.jsonl', JSON.stringify({attempt:heldAttempt, tool:block.name})+'\n')
        yield { type: 'block-start', index, blockType: block.type }
        yield { type: 'block-end', index, block }
      }
      yield { type: 'finish', reason: { kind: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['tavern-e2e'], new Model())
}
