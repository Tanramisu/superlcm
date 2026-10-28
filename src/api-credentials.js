import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {randomBytes} from 'node:crypto'
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
// A secret is first written under an immutable revision. The main database
// then commits only that revision reference together with the model setting.
// A failed or interrupted setting save cannot overwrite the old secret.
function binding(dir,scope){
  const file=join(dir,'lcm.sqlite')
  if(!existsSync(file))return {found:false}
  const db=new DatabaseSync(file,{readOnly:true})
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_bindings'").get())return {found:false}
    const row=db.prepare('SELECT revision FROM credential_bindings WHERE scope=?').get(scope)
    return row?{found:true,revision:row.revision}:{found:false}
  }finally{db.close()}
}
function valueFor(dir,scope){
  const current=binding(dir,scope)
  if(!current.found)return access(dir)[scope]
  if(current.revision===null)return null
  const file=join(dir,'api-credentials.sqlite')
  if(!existsSync(file))throw Error('API credential database is missing')
  const db=new DatabaseSync(file,{readOnly:true})
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='credential_versions'").get())throw Error('API credential revision is missing')
    const row=db.prepare('SELECT value FROM credential_versions WHERE scope=? AND revision=?').get(scope,current.revision)
    if(!row)throw Error('API credential revision is missing')
    return JSON.parse(row.value)
  }finally{db.close()}
}
export function bindApiKey(db,scope,revision){
  if(!scopeValid(scope)||revision!==null&&(typeof revision!=='string'||!/^[a-f0-9]{32}$/.test(revision)))throw Error('Invalid API credential binding')
  db.exec('CREATE TABLE IF NOT EXISTS credential_bindings(scope TEXT PRIMARY KEY,revision TEXT)')
  db.prepare('INSERT INTO credential_bindings VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision').run(scope,revision)
}
function bindStandalone(dir,scope,revision){
  privateDirectory(dir);const file=join(dir,'lcm.sqlite');privateFile(file)
  const db=new DatabaseSync(file)
  try{db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE');bindApiKey(db,scope,revision);db.exec('COMMIT')}
  catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error}finally{db.close()}
}
export function stageApiKey(dir,scope,key,endpoint=null){
  if(!scopeValid(scope)||typeof key!=='string'||key.length<8||key.length>4096||/[\r\n\0]/.test(key)||!key.trim())throw new Error('API key must be 8–4096 nonempty characters without line breaks')
  if(endpoint!==null&&(typeof endpoint!=='string'||endpoint.length>2048))throw new Error('Invalid API credential endpoint')
  privateDirectory(dir)
  // Prepare the compatibility file before publishing a new revision; a file
  // creation error must not change either the selected key or the settings.
  try{writeFileSync(keyFile(dir),'{}',{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}
  credentials(dir)
  const revision=randomBytes(16).toString('hex'),value=endpoint===null?key:{key,endpoint}
  access(dir,db=>{
    db.exec('CREATE TABLE IF NOT EXISTS credential_versions(revision TEXT PRIMARY KEY,scope TEXT NOT NULL,value TEXT NOT NULL)')
    db.prepare('INSERT INTO credential_versions VALUES(?,?,?)').run(revision,scope,JSON.stringify(value))
  })
  return revision
}
export function apiKeyEndpoint(dir,scope) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const value=valueFor(dir,scope)
  return value && typeof value==='object' && typeof value.endpoint==='string' ? value.endpoint : null
}
export function readApiKey(dir,scope,endpoint) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  const value=valueFor(dir,scope)
  if(value && typeof value==='object') {
    if(endpoint !== undefined && value.endpoint !== endpoint)return null
    return typeof value.key==='string'&&value.key.length>=8?value.key:null
  }
  return typeof value==='string'&&value.length>=8?value:null
}
export function saveApiKey(dir,scope,key,endpoint=null) {
  const revision=stageApiKey(dir,scope,key,endpoint)
  bindStandalone(dir,scope,revision)
  return true
}
export function removeApiKey(dir,scope) {
  if(!scopeValid(scope))throw new Error('Invalid API credential scope')
  if(!valueFor(dir,scope))return false
  bindStandalone(dir,scope,null)
  return true
}
