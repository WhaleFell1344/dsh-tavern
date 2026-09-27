import {createScopedMessages} from './scoped-messages.js'

// This projection is internal and must never be passed to full-Chat writes.
// Only a variable retry with an already prepared worldbook has bounded inputs.
export async function readSettlementInput(chatId, {readWindow, readChat}) {
  const window = await readWindow(chatId, {limit:200})
  const chat = window?.chat
  const timeline = chat?.timeline
  const rows = chat?.messages
  const target = rows?.findLastIndex(row => row?.role === 'assistant' && row.mvu?.pending === true) ?? -1
  const previous = target > 0 ? rows.slice(0,target).findLastIndex(row => row?.role === 'assistant') : -1
  if (!window || !Number.isSafeInteger(window.revision) || chat._storageRevision !== window.revision
    || chat.backgroundConfigVersion !== 1 || chat.conversationFeaturesVersion !== 1
    || timeline?.schemaVersion !== 1 || !Array.isArray(timeline.checkpoints)
    || Object.values(timeline.operations || {}).some(op => op?.kind === 'body' && op.status === 'foreground-completed')
    || !chat.preparedWorldBook || Number(chat.preparedWorldBook.revision) !== Number(timeline.revision)
    || chat.mvu?.enabled !== true || chat.mvu.owner !== 'official'
    || target < 0 || rows[target].mvu.variableRetry !== true
    || (window.from > 0 && previous < 0)) return readChat(chatId)
  return {...chat, messages:createScopedMessages(window.messageCount,rows.map((row,index)=>[window.from+index,row]))}
}
