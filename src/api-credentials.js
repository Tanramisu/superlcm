import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {privateDirectory,privateFile} from './private-path.js'

const keyFile=dir=>join(dir,'api-credentials.json')
const scopeValid=scope=>scope==='global'||/^harness:[a-z][a-z0-9-]{0,39}$/.test(scope)||/^model:[a-z0-9]{1,40}$/.test(scope)
function credentials(dir) {
  const file=keyFile(dir)
  if(!existsSync(file))return {}
  const stat=lstatSync(file)
  if(!stat.isFile() || stat.size>128*1024 || (process.platform!=='win32' && (stat.mode&0o077)!==0) || (typeof process.getuid==='function' && stat.uid!==process.getuid()))throw new Error('API credential file must be a private regular file owned by this user')
  const value=JSON.parse(readFileSync(file,'utf8'))
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid API credential file')
  return value
}
function access(dir,mutate){
  const old=credentials(dir),file=join(dir,'api-credentials.sqlite')
  if(!mutate&&!existsSync(file))return old
  privateDirectory(dir);privateFile(file)
  const db=new DatabaseSync(file)
  try{
    db.exec('PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS credentials(scope TEXT PRIMARY KEY,value TEXT NOT NULL)')
    if(mutate){
      db.exec('BEGIN IMMEDIATE')
      for(const [scope,value] of Object.entries(old))if(scopeValid(scope))db.prepare('INSERT OR IGNORE INTO credentials VALUES(?,?)').run(scope,JSON.stringify(value))
      mutate(db)
      db.exec('COMMIT')
    }
    return {...old,...Object.fromEntries(db.prepare('SELECT scope,value FROM credentials').all().map(r=>[r.scope,JSON.parse(r.value)]))}
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error}finally{db.close()}
}
export function apiKeyEndpoint(dir,scope) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const value=access(dir)[scope]
  return value && typeof value==='object' && typeof value.endpoint==='string' ? value.endpoint : null
}
export function readApiKey(dir,scope,endpoint) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const value=access(dir)[scope]
  if(value && typeof value==='object') {
    if(endpoint !== undefined && value.endpoint !== endpoint)return null
    return typeof value.key==='string'&&value.key.length>=8?value.key:null
  }
  return typeof value==='string'&&value.length>=8?value:null
}
export function saveApiKey(dir,scope,key,endpoint=null) {
  if(!scopeValid(scope)||typeof key!=='string'||key.length<8||key.length>4096||/[\r\n\0]/.test(key)||!key.trim())throw new Error('API key must be 8–4096 nonempty characters without line breaks')
  if(endpoint!==null&&(typeof endpoint!=='string'||endpoint.length>2048))throw new Error('Invalid API credential endpoint')
  access(dir,db=>db.prepare('INSERT INTO credentials VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value').run(scope,JSON.stringify(endpoint===null?key:{key,endpoint})))
  // Retain a private compatibility file, without copying new secrets back into
  // a non-transactional whole-file document.
  try{writeFileSync(keyFile(dir),'{}',{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}
  return true
}
export function removeApiKey(dir,scope) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const current=access(dir);if(!current[scope])return false
  access(dir,db=>db.prepare('INSERT INTO credentials VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value').run(scope,'null'))
  return true
}
