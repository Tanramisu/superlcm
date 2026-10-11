// Cancellation must remain visible while SQLite is waiting for its write lock.
// Append-only private markers are independent of the database and carry no source text.
import {createHash} from 'node:crypto'
import {existsSync,mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {home} from './store.js'
const key=value=>typeof value==='string'&&/^[a-zA-Z0-9-]{8,120}$/.test(value)?value:null
const marker=(dir,session,value)=>join(dir,'claude-rescue-cancellations',createHash('sha256').update(JSON.stringify([session,value])).digest('hex'))
export function rescueCancelled(dir,session,...values) {
  return values.some(value=>key(value)&&existsSync(marker(dir,session,value)))
}
export function revokeClaudeRescue(session,input,dir=home()) {
  const values=[input.cancel_id,input.claim_id].map(key).filter(Boolean)
  if(!values.length)return
  mkdirSync(join(dir,'claude-rescue-cancellations'),{recursive:true,mode:0o700})
  for(const value of values)writeFileSync(marker(dir,session,value),'cancelled\n',{mode:0o600})
}
