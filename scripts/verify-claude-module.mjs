// Execute the real Claude SDK loader and hooks, with every service replaced
// by test implementations. Never reuse the user's HOME, login or archive.
import assert from 'node:assert/strict'
import {copyFileSync,existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {findCli} from '../src/runtime.js'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const bin=findCli('claude')
assert.ok(bin,'Claude native checks require an installed Claude Code CLI with plugin test support. This check was NOT performed.')
// Native installs are preferred. npm's Windows .cmd is a launcher, not an
// executable; use its installed JS entry directly instead of shell quoting.
let executable=bin,prefix=[]
if(/\.cmd$/i.test(bin)){
  const entry=join(dirname(bin),'node_modules','@anthropic-ai','claude-code','cli.js')
  assert.ok(existsSync(entry),'Cannot resolve the Claude npm launcher. Install the native Claude CLI to run these checks.')
  executable=process.execPath;prefix=[entry]
}
const dir=mkdtempSync(join(tmpdir(),'SuperLcm Claude native 用户 # ')),home=join(dir,'private-home')
for(const folder of [home,join(home,'.claude'),join(home,'appdata'),join(home,'localappdata'),join(dir,'private-store')])mkdirSync(folder,{recursive:true})
// Allow only OS process essentials. In particular do not inherit credentials,
// provider endpoints, NODE_OPTIONS, plugin/worker flags or login directories.
const env={}
for(const key of ['PATH','Path','PATHEXT','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','LANG','LC_ALL','TMP','TEMP','TMPDIR'])if(process.env[key]!==undefined)env[key]=process.env[key]
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:join(home,'appdata'),LOCALAPPDATA:join(home,'localappdata'),CLAUDE_CONFIG_DIR:join(home,'.claude'),SUPERLCM_HOME:join(dir,'private-store'),DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'})
const files=new Map()
function copyModule(file){
  file=resolve(file)
  const name=relative(root,file)
  assert.ok(name&&!name.startsWith('..'+sep)&&!isAbsolute(name),'Module escaped repository: '+name)
  if(files.has(name))return
  const code=readFileSync(file,'utf8'),target=join(dir,name)
  files.set(name,createHash('sha256').update(code).digest('hex'))
  mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target)
  for(const match of code.matchAll(/(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g))copyModule(resolve(dirname(file),match[1]))
}
const manifest=JSON.parse(readFileSync(join(root,'hooks/hooks.json'),'utf8'))
assert.ok(manifest.modules?.length,'No actual hook module selected')
for(const module of manifest.modules)copyModule(resolve(root,'hooks',module))
// Command hooks are a separate CLI pipeline; this suite tests SDK modules.
// Keeping only the actual modules list prevents external command execution.
writeFileSync(join(dir,'hooks/hooks.json'),JSON.stringify({modules:manifest.modules}))
copyFileSync(join(root,'test/claude-module/compaction.test.ts'),join(dir,'compaction.test.ts'))
const run=args=>spawnSync(executable,[...prefix,...args],{cwd:dir,env,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,windowsHide:true})
const version=run(['--version'])
assert.equal(version.status,0,version.error?.message||version.stderr||'Claude version check failed')
const result=run(['plugin','test',dir]),log=(result.stdout||'')+(result.stderr||'')
writeFileSync(join(dir,'native-test.log'),log)
process.stdout.write(log)
assert.equal(result.status,0,result.error?.message||'Actual Claude hook suite failed; log: '+join(dir,'native-test.log'))
// An empty/native-no-SDK test can exit 0 without loading hooks. Require the
// actual facade-driven cases, not just the runner's exit status.
const count=Number(log.match(/Ran (\d+) tests across/)?.[1]||0)
assert.ok(count>=14&&/\b0 fail\b/.test(log),'Claude did not execute all required hook cases')
const receipt={claude:version.stdout.trim(),nativeCases:count,files:Object.fromEntries(files),paidModelCalls:0,isolatedHome:true,productionSettingsChanged:false}
writeFileSync(join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
console.log(JSON.stringify({...receipt,files:files.size,receipt:join(dir,'receipt.json')}))
