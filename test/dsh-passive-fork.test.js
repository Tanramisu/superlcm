import test from 'node:test'
import assert from 'node:assert/strict'
import {lab,history,send,close,count,until} from './reliability/lab.mjs'
import {MainArchiveFork} from '../dsh/main-archive-fork.js'
import {forkScope} from '../dsh/fork-scope.js'
import {captureDshPacket,projectDshEvent,dshSessionKey} from '../src/dsh.js'
import {ClaudeStore} from '../src/store.js'
import {summarizeArchiveFork} from '../dsh/archive-fork.js'

function idleFixture(stream){
 const message={id:'synthetic-message',role:'user',content:[{type:'text',text:'Please preserve the original request.'}]}
 const event={seq:0,type:'user/message',data:{content:message.content}},session={eventAt:()=>event,deriveEventMessage:()=>message}
 const request={provider:'offline',model:'offline',messages:[message],maxTokens:4096},saved=[]
 const db={nodes:()=>[],sourceRows:()=>[{seq:0,event:JSON.stringify(event),tokens:100,text:'Please preserve the original request.'}],saveTree:(...args)=>saved.push(args)}
 const ctx={sessions:new Map([['synthetic',session]]),tokenMeter:{measure:()=>({totalTokens:75000})},llm:{resolveModelInfo:async()=>({context:{contextWindow:100000},defaultMaxTokens:4096}),stream}}
 return {service:{ctx,db,file:'/synthetic',forkRequests:new Map([['synthetic',request]])},doc:{revision:'r',settings:{compressionRatio:.8,chunkTokens:2000,fanout:4,forkModelOverride:false}},saved}
}
const flush=async()=>{for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve))}

test('passive DSH summary keeps running while it produces meaningful output',async t=>{
 const gates=[],f=idleFixture(options=>(async function*(){
  const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(x=>x.startsWith('[{"index":')))
  const body=JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# State\nPreserve the original request.'}))})
  yield {type:'text-delta',text:body.slice(0,1)}
  for(let i=0;i<2;i++){await new Promise(resolve=>gates.push(resolve));yield {type:'reasoning-delta',text:'still working'}}
  yield {type:'text-delta',text:body.slice(1)};yield {type:'finish',reason:{kind:'stop'}}
 })())
 t.mock.timers.enable({apis:['setTimeout','Date']})
 try{
  const pending=summarizeArchiveFork(f.service,'synthetic',f.doc,'owner',new AbortController().signal)
  await flush();assert.equal(gates.length,1)
  for(let i=0;i<2;i++){t.mock.timers.tick(540000);gates.shift()();await flush()}
  assert.equal(await pending,'complete');assert.equal(f.saved.length,1)
 }finally{t.mock.timers.reset();for(const release of gates)release()}
})

test('passive DSH summary aborts after ten minutes without meaningful progress',async t=>{
 let release,started=false
 const f=idleFixture(()=>(async function*(){yield {type:'text-delta',text:'{'};started=true;await new Promise(resolve=>release=resolve)})())
 t.mock.timers.enable({apis:['setTimeout','Date']})
 try{
  const pending=summarizeArchiveFork(f.service,'synthetic',f.doc,'owner',new AbortController().signal)
  const failure=assert.rejects(pending,error=>error.name==='TimeoutError')
  await flush();assert.equal(started,true);t.mock.timers.tick(600001);await failure
  assert.equal(f.saved.length,0)
 }finally{t.mock.timers.reset();release?.()}
})

test('passive DSH retries temporary failures without another conversation event',async t=>{
 const h=await lab({capacity:64000,config:{auto:false,summaryMode:'main-fork'}}),store=new ClaudeStore(h.dir);let forks,attempts=0
 try{
  store.setGlobalSetting('main-fork');forks=new MainArchiveFork(h.ctx,h.engine.superLcmStore,h.dir,error=>h.warnings.push(error.message));history(h,.72)
  const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   attempts++;if(attempts<=3)throw Error('synthetic temporary failure')
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(x=>x.startsWith('[{"index":')))
   yield {type:'text-delta',text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical state\nPreserve the original request and pending inspection.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'Synthetic request.')
  captureDshPacket(store,{header:h.agent.session.header,records:h.agent.session.snapshotEvents().map(e=>projectDshEvent(h.id,e,JSON.stringify(e.data)))})
  const surface=h.agent.session.surface.nodes.slice()
  t.mock.timers.enable({apis:['setTimeout','Date']});forks.afterCapture(h.id,true)
  const state=forks.jobs.get(h.id);assert.ok(state)
  for(let i=1;i<=3;i++){
   await until(()=>state.failures===i&&state.retryAt!==null)
   assert.equal(attempts,i);assert.equal(count(h,'compaction/summary'),0)
   assert.equal(state.lastErrorKind,'invalid_summary')
   t.mock.timers.tick(state.retryAt-Date.now())
  }
  await state.promise
  assert.equal(attempts,4);assert.equal(forks.jobs.size,0)
  assert.deepEqual(h.agent.session.surface.nodes,surface)
  assert.ok(store.roots(dshSessionKey(h.id)).length)
 }finally{t.mock.timers.reset();await forks?.close();store.close();await close(h)}
})

test('passive DSH retry stops after settings change and on shutdown',async t=>{
 const h=await lab({capacity:64000,config:{auto:false,summaryMode:'main-fork'}}),store=new ClaudeStore(h.dir);let forks,attempts=0
 try{
  store.setGlobalSetting('main-fork');forks=new MainArchiveFork(h.ctx,h.engine.superLcmStore,h.dir,error=>h.warnings.push(error.message));history(h,.72)
  const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){attempts++;throw Error('temporary fixture error')})()
  await send(h,'Synthetic request.')
  captureDshPacket(store,{header:h.agent.session.header,records:h.agent.session.snapshotEvents().map(e=>projectDshEvent(h.id,e,JSON.stringify(e.data)))})
  t.mock.timers.enable({apis:['setTimeout','Date']});forks.afterCapture(h.id,true)
  const first=forks.jobs.get(h.id);await until(()=>first.failures===1&&first.retryAt!==null)
  store.setGlobalSetting('off');t.mock.timers.tick(first.retryAt-Date.now());await first.promise
  assert.equal(attempts,1);assert.equal(forks.jobs.size,0)
  store.setGlobalSetting('main-fork');forks.afterCapture(h.id,true)
  const second=forks.jobs.get(h.id);await until(()=>second.failures===1&&second.retryAt!==null)
  await forks.close();forks=null;assert.equal(attempts,2)
 }finally{t.mock.timers.reset();await forks?.close();store.close();await close(h)}
})

test('a changed DSH request cannot publish an obsolete passive fork',async()=>{
 let release,started=false
 const f=idleFixture(options=>(async function*(){
  const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(x=>x.startsWith('[{"index":')))
  started=true;await new Promise(resolve=>release=resolve)
  yield {type:'text-delta',text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# State\nThe task remains pending.'}))})}
  yield {type:'finish',reason:{kind:'stop'}}
 })())
 const pending=summarizeArchiveFork(f.service,'synthetic',f.doc,'owner',new AbortController().signal)
 await until(()=>started);f.service.forkRequests.set('synthetic',{...f.service.forkRequests.get('synthetic')})
 release();await assert.rejects(pending,/请求已变化/);assert.equal(f.saved.length,0)
})
test('integrated DSH archives a complete native fork tree with takeover off',async()=>{
 const h=await lab({capacity:64000,config:{auto:false,summaryMode:'main-fork'}}),store=new ClaudeStore(h.dir);let forks
 try{
  store.setGlobalSetting('main-fork');forks=new MainArchiveFork(h.ctx,h.engine.superLcmStore,h.dir,error=>h.warnings.push(error.message))
  history(h,.72);const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(x=>x.startsWith('[{"index":')))
   yield {type:'text-delta',text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical constraints\nKeep the original request; deployment is forbidden. Inspection remains pending.'}))})}
   yield {type:'usage',usage:{cacheReadTokens:30000}}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'Never deploy. Continue inspection.')
  captureDshPacket(store,{header:h.agent.session.header,records:h.agent.session.snapshotEvents().map(e=>projectDshEvent(h.id,e,JSON.stringify(e.data)))})
  const surface=h.agent.session.surface.nodes.slice();forks.afterCapture(h.id,true)
  await Promise.all([...forks.jobs.values()].map(j=>j.promise))
  assert.equal(branches.length,1,h.warnings.join('\n'));assert.equal(count(h,'compaction/summary'),0)
  assert.deepEqual(h.agent.session.surface.nodes,surface)
  const id=dshSessionKey(h.id),roots=store.roots(id)
  assert.equal(roots.length,1,h.warnings.join('\n'));assert.ok(roots[0].children.length>1);assert.ok(roots[0].source_records.length)
  assert.equal(JSON.parse(store.db.prepare('SELECT usage FROM fork_summary_receipts WHERE session=?').get(id).usage).cacheReadTokens,30000)
  const before=store.db.prepare('SELECT count(*) n FROM nodes WHERE session=?').get(id).n;forks.mirror(h.id)
  assert.equal(store.db.prepare('SELECT count(*) n FROM nodes WHERE session=?').get(id).n,before)
 }finally{await forks?.close();store.close();await close(h)}
})

test('DSH passive branch honors the native model override and 40% preparation with takeover off',async()=>{
 const {writeFileSync}=await import('node:fs'),{join}=await import('node:path')
 const h=await lab({capacity:64000,config:{auto:false,summaryMode:'main-fork'}}),store=new ClaudeStore(h.dir);let forks
 try{
  store.setGlobalSetting('main-fork')
  writeFileSync(join(h.dir,'dsh-compression.json'),JSON.stringify({format:1,revision:'chosen',config:{auto:false,switchRatio:.5,forkModelOverride:true,summarizationProvider:'lab-main',summarizationModel:'summary-alternate'}}))
  forks=new MainArchiveFork(h.ctx,h.engine.superLcmStore,h.dir,error=>h.warnings.push(error.message))
  const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join(''),plan=JSON.parse(prompt.split('\n').find(x=>x.startsWith('[{"index":')))
   yield {type:'text-delta',text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical state\nKeep the original constraints; inspection remains pending.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  history(h,.42);await send(h,'PASSIVE_SELECTED_MODEL')
  captureDshPacket(store,{header:h.agent.session.header,records:h.agent.session.snapshotEvents().map(e=>projectDshEvent(h.id,e,JSON.stringify(e.data)))})
  const surface=h.agent.session.surface.nodes.slice();forks.afterCapture(h.id,true)
  await Promise.all([...forks.jobs.values()].map(j=>j.promise))
  assert.equal(branches.length,1,h.warnings.join('\n'));assert.equal(branches[0].model,'summary-alternate')
  assert.equal(h.agent.options.model,'main-64000')
  assert.equal(count(h,'compaction/summary'),0);assert.deepEqual(h.agent.session.surface.nodes,surface)
  assert.equal(store.db.prepare('SELECT model FROM fork_summary_receipts WHERE session=?').get(dshSessionKey(h.id)).model,'summary-alternate')
 }finally{await forks?.close();store.close();await close(h)}
})
