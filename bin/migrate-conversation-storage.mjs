#!/usr/bin/env node
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createChatJournalStore} from '../tavern-plugin/lib/domain/chat-journal-store.js'

export async function migrateConversationStorage({dataRoot,chatId,restoreLegacy=false}){
 if(!dataRoot||!chatId)throw Error('Required: --data PATH --chat ID')
 const store=createChatJournalStore({dataRoot:path.resolve(dataRoot)})
 return restoreLegacy?store.restoreLegacy(chatId):store.migrateCompatibility(chatId,{force:true})
}
async function main(){
 const args=process.argv.slice(2),values={}
 for(let i=0;i<args.length;i++){
  const key=args[i]
  if(key==='--restore-legacy'){if(values[key])throw Error('Duplicate option');values[key]=true;continue}
  if(!['--data','--chat'].includes(key)||!args[i+1]||args[i+1].startsWith('--')||values[key])throw Error('Usage: node bin/migrate-conversation-storage.mjs --data PATH --chat ID [--restore-legacy]')
  values[key]=args[++i]
 }
 const result=await migrateConversationStorage({dataRoot:values['--data'],chatId:values['--chat'],restoreLegacy:values['--restore-legacy']===true})
 console.log(JSON.stringify(result,null,2))
 if(result.status==='missing'||(!values['--restore-legacy']&&result.status!=='compatible'))process.exitCode=2
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1})
