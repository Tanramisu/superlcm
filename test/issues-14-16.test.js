import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {ClaudeStore} from '../src/store.js'
import {verifiedCompactionInput} from '../src/claude-compaction-input.js'
import {planCompaction,frontier} from '../src/compaction.js'
import {summaryEstimate,summaryWork} from '../src/summarize.js'
import {flushUnderPressure} from '../src/summary-background.js'
import {reducedNotice} from '../src/summary-fitting.js'

const root=new URL('../',import.meta.url)
function source(t,rows){
  const dir=mkdtempSync(join(tmpdir(),'SuperLcm Claude issues 用户 # ')),file=join(dir,'source.jsonl'),store=new ClaudeStore(join(dir,'store'))
  writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');store.ingest('s',file)
  store.setMetadata('s',{harness:'claude-code',externalId:'s'});store.setHarnessSetting('claude-code','cli','offline-summary')
  store.setTuning({target_tokens:20000,fanout:4});store.setTakeover({enabled:true,window:360000,keep:20000})
  t.after(()=>store.close())
  return {dir,file,store,rows}
}
const user=text=>({type:'user',message:{content:text}})
function toolHistory(){
  const rows=[{...user('Only inspect this task. Do not deploy.'),origin:{kind:'human'}}],messages=[{role:'user',text:rows[0].message.content,size:300}]
  for(let i=0;i<24;i++){
    rows.push({type:'assistant',message:{content:[{type:'text',text:'Step '+i},{type:'tool_use',id:'t'+i,name:'offline',input:{}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'t'+i,content:'Offline result '+i}]}})
    messages.push({role:'assistant',text:'Step '+i,toolUses:[{tool_use_id:'t'+i}],size:3000},{role:'user',text:'',toolResults:1,toolResultIds:['t'+i],size:3000})
  }
  rows.push({...user('Background task completed.'),origin:{kind:'task-notification'},promptSource:'system'})
  messages.push({role:'user',text:'Background task completed.',size:200})
  return {rows,messages}
}
function addNode(store,node){store.addNode({session:'s',children:[],digest:'fixture',model:'offline',summary:'# State\nInspection remains unfinished. Do not deploy.',...node})}
const tailRows=()=>[user('Please preserve all constraints. '+ 'word '.repeat(3500)),{type:'assistant',message:{content:'Inspection pending. '+ 'word '.repeat(3500)}}]

test('pressure closes the open 20K-token segment without changing the normal budget',t=>{
  const h=source(t,tailRows()),before=readFileSync(h.file)
  assert.equal(summaryWork(h.store,'s'),null)
  assert.equal(flushUnderPressure(h.store,'s',{tokens:170000,window:360000}),false)
  assert.equal(flushUnderPressure(h.store,'s',{tokens:180000,window:360000}),true)
  const work=summaryWork(h.store,'s');assert.equal(work.first,0);assert.equal(work.last,1)
  assert.equal(summaryEstimate(h.store,'s').segments,1)
  assert.equal(h.store.tuning().target_tokens,20000)
  assert.deepEqual(readFileSync(h.file),before)
})
test('takeover off, small tails and expired marks retain ordinary 20K batching',t=>{
  const h=source(t,tailRows());h.store.setTakeover({enabled:false})
  assert.equal(flushUnderPressure(h.store,'s',{tokens:300000,window:360000}),false);assert.equal(summaryWork(h.store,'s'),null)
  h.store.setTakeover({enabled:true});h.store.setSummaryFlush('s',1,-1)
  assert.equal(summaryWork(h.store,'s'),null)
  const small=source(t,[user('A small pending task'),{type:'assistant',message:{content:'Pending'}}])
  assert.equal(flushUnderPressure(small.store,'s',{tokens:300000,window:360000}),false)
})
test('flushing never splits parallel tools or pursues records beyond its frozen ordinal',t=>{
  const rows=[user('Inspect only.'),{type:'assistant',message:{content:[{type:'tool_use',id:'a',name:'offline',input:{}},{type:'tool_use',id:'b',name:'offline',input:{}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'a',content:'First result'}]}}]
  const h=source(t,rows);h.store.setSummaryFlush('s',2)
  assert.equal(summaryWork(h.store,'s').last,0)
  const result={type:'user',message:{content:[{type:'tool_result',tool_use_id:'b',content:'Second result'}]}}
  appendFileSync(h.file,JSON.stringify(result)+'\n');h.store.ingest('s',h.file)
  assert.equal(summaryWork(h.store,'s').last,0,'Existing mark cannot chase a later result')
  h.store.setSummaryFlush('s',3)
  assert.equal(summaryWork(h.store,'s').last,3)
  assert.equal(summaryEstimate(h.store,'s').segments,1)
})
for(const origin of ['task-notification','system'])test('recorded '+origin+' is not a human prompt and manual compaction preserves the real request',t=>{
  const f=toolHistory();if(origin==='system')delete f.rows.at(-1).origin
  const h=source(t,f.rows),before=readFileSync(h.file)
  addNode(h.store,{id:'complete',level:0,first:0,last:48})
  const context=verifiedCompactionInput(h.store,'s',f.messages)
  assert.equal(context.events.at(-1).humanPrompt,false);assert.equal(context.messages.at(-1).prompt,'system')
  const plan=planCompaction({meta:h.store.metadata('s'),...context,nodes:h.store.nodeRows('s',0),tokens:150000,window:360000,keepTokens:20000,trigger:'manual'})
  assert.equal(plan.use,true);assert.ok(plan.after<40000);assert.ok(plan.start<=49)
  assert.ok(plan.packet.includes(f.messages[0].text));assert.deepEqual(f.messages.slice(plan.start).at(-1),f.messages.at(-1))
  const pending=new Set();for(const m of f.messages.slice(0,plan.start)){for(const use of m.toolUses||[])pending.add(use.tool_use_id);for(const id of m.toolResultIds||[])pending.delete(id)}assert.equal(pending.size,0)
  assert.deepEqual(readFileSync(h.file),before)
})
test('untagged old records and ambiguous human/system text keep human protection',t=>{
  const rows=[user('Continue.'),{...user('Continue.'),origin:{kind:'task-notification'}}],h=source(t,rows)
  const old=verifiedCompactionInput(h.store,'s',[{role:'user',text:'Unknown old prompt'}]);assert.equal(old.messages[0].prompt,undefined)
  assert.equal(verifiedCompactionInput(h.store,'s',[{role:'user',text:'Continue.'}]).messages[0].prompt,undefined,'Unknown origin sharing notification text remains protected')
  // Explicitly human and system matches must not demote a person's request.
  const human=source(t,[{...user('Continue.'),origin:{kind:'human'}},rows[1]])
  assert.equal(verifiedCompactionInput(human.store,'s',[{role:'user',text:'Continue.'}]).messages[0].prompt,'human')
})
test('unknown origin retains the exact current authorization in a smaller manual packet',t=>{
  const f=toolHistory();f.rows[0].origin={kind:'unknown-origin'}
  f.rows[0].message.content='CURRENT UNKNOWN AUTHORIZATION: inspect only; do not deploy.';f.messages[0].text=f.rows[0].message.content
  const h=source(t,f.rows);addNode(h.store,{id:'complete',level:0,first:0,last:48})
  const context=verifiedCompactionInput(h.store,'s',f.messages)
  assert.equal(context.events[0].humanPrompt,true);assert.equal(context.messages[0].prompt,undefined)
  const plan=planCompaction({meta:h.store.metadata('s'),...context,nodes:h.store.nodeRows('s',0),tokens:150000,window:360000,keepTokens:20000,trigger:'manual'})
  assert.equal(plan.use,true);assert.ok(plan.packet.includes(f.rows[0].message.content))
})
test('manual moderate context also reduces a long covered turn rather than retaining it whole',t=>{
  const f=toolHistory(),h=source(t,f.rows);addNode(h.store,{id:'complete',level:0,first:0,last:48})
  const plan=planCompaction({meta:h.store.metadata('s'),...verifiedCompactionInput(h.store,'s',f.messages),nodes:h.store.nodeRows('s',0),tokens:70000,window:360000,keepTokens:20000,trigger:'manual'})
  assert.equal(plan.use,true);assert.ok(plan.after<35000);assert.ok(plan.packet.includes(f.messages[0].text))
})
test('a complete child can replace a shortened parent, but a shortened leaf cannot replace source',()=>{
  const nodes=[{id:'a',level:0,first:0,last:0,summary:'# Full historical facts'},{id:'b',level:0,first:1,last:1,summary:'# Full current constraints'},{id:'parent',level:1,first:0,last:1,summary:reducedNotice({first:0,last:1})}]
  assert.deepEqual(frontier(nodes,1).map(n=>n.id),['a','b'])
  const input={meta:{code:'test'},nodes,events:[{ordinal:0,preview:'user: old'},{ordinal:1,preview:'assistant: done'},{ordinal:2,preview:'user: current'}],messages:[{role:'user',text:'old',size:100000},{role:'assistant',text:'done',size:100000},{role:'user',text:'current'}],tokens:200000,window:360000,keepTokens:20000}
  assert.equal(planCompaction(input).use,true)
  nodes[0].summary=reducedNotice({first:0,last:0})
  assert.equal(planCompaction(input).use,false)
})
test('real CLI precompute flushes an open tail and returns host retry without a model call',t=>{
  const h=source(t,tailRows());h.store.setHostWriter('s',true)
  const input={messages:h.rows.map(r=>({role:r.type,text:r.message.content.slice(0,2000),size:r.message.content.length+200})),tokens:300000,window:360000,trigger:'precompute'}
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('src/cli.js',root)),'compact-packet','s'],{env:{...process.env,SUPERLCM_HOME:h.store.dir,SUPERLCM_SEGMENT_MESSAGES:'10000',SUPERLCM_CATCHUP_MS:'0',SUPERLCM_SUMMARY_MODE:''},input:JSON.stringify(input),encoding:'utf8',timeout:10000})
  assert.equal(run.status,0,run.stderr);const reply=JSON.parse(run.stdout)
  assert.equal(reply.use,false);assert.equal(reply.retry,'host');assert.equal(reply.catchup,undefined)
  assert.equal(h.store.summaryFlush('s'),1);assert.equal(summaryEstimate(h.store,'s').segments,1)
  assert.equal(h.store.nodeRows('s',0).length,0)
})
