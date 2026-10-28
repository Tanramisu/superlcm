// Real DSH admission/rebuild/compaction; the model adapter is wholly local.
import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {SessionStore} from '@deepseek-ai/dsh-session'
import {assertReleasedV4Relationships} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import {lab,history,send,close,count,checkpoint,until} from './reliability/lab.mjs'
import {forkScope} from '../dsh/main-fork.js'
import {ROLLING_DEFAULTS} from '../dsh/engine-config.js'
import {controlsConfig} from '../dsh/controls-config.js'
import {currentPolicy,activeInputTokens} from '../dsh/ratio-runtime.js'
import {estimateSummaryTokens} from '../src/summary-tokens.js'

test('an idle host closes without corrupting the native persisted event relationships',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 let closed=false
 try{
  assert.deepEqual(await send(h,'Continue the current task.'),[])
  const session=h.agent.session
  assert.equal(session.requestHeader().config.maxTokens,98976)
  await close(h);closed=true
  const events=session.snapshotEvents()
  assertReleasedV4Relationships({header:session.header,events,inheritedEventCount:0},new Set(events.map(e=>e.type)))
 }finally{if(!closed)await close(h)}
})

for(const fits of [true,false])test('native summary tree '+(fits?'may exceed its planning goal within the hard limit':'must not exceed the independent hard limit'),async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:300,summaryRetryCooldownMs:1000}})
 let branches=0,budget
 try{
  history(h,fits?.72:.91)
  const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(s=>s.startsWith('[{"index":')))
   const target=Number(prompt.match(/together must fit (\d+) tokens/)[1])
   const hard=Math.min(currentPolicy(h.engine,h.agent).summaryPrefixTargetTokens,options.maxTokens)
   const blocks=plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve constraints and pending work.'}))
   const total=()=>blocks.reduce((n,b)=>n+estimateSummaryTokens(b.summary),0)
   const wanted=fits?Math.ceil(target*1.07):hard+32
   blocks[0].summary+=' '+'x'.repeat(Math.max(0,wanted-total())*4)
   budget={target,hard,total:total()};assert.ok(budget.total>target)
   assert.equal(budget.total<=hard,fits)
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  const input='KEEP ORIGINAL REQUEST DURING SUMMARY VALIDATION'
  const pending=send(h,input)
  if(!fits){
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   assert.equal(h.main.length,0);h.agent.cancel({kind:'user'},{keepInbox:true})
  }
  await pending
  if(fits){
   await until(()=>['ready','retrying'].includes(h.engine.backgroundFolds.get(h.agent)?.status))
   assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
   await h.engine.settleBackgroundFold(h.agent)
   await send(h,'CONTINUE WITH THE SAME SUMMARY '+'t'.repeat(28000))
   assert.equal(count(h,'compaction/summary'),1)
  }else assert.equal(count(h,'compaction/summary'),0)
  assert.equal(branches,1)
  assert.ok(h.agent.session.snapshotEvents().some(e=>JSON.stringify(e).includes(input)))
 }finally{await close(h)}
})

test('a later adapter override cannot send an oversized foreground request',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 try{
  history(h,.78)
  const prepare=h.ctx.llm.prepareCall.bind(h.ctx.llm)
  h.ctx.llm.prepareCall=(config,signal)=>prepare({...config,maxTokens:128000},signal)
  const errors=await send(h,'KEEP THIS INPUT WHEN ANOTHER SETTING OVERRIDES OUTPUT CAPACITY')
  assert.ok(errors.length)
  assert.equal(h.main.length,0,'foreground cannot bypass the real output reservation')
  assert.equal(count(h,'compaction/summary'),0)
  assert.ok(h.agent.session.snapshotEvents().some(e=>JSON.stringify(e).includes('KEEP THIS INPUT')))
 }finally{await close(h)}
})

test('a late 425K start limits only branch output and still replaces without trimming the prefix',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
 try{
  history(h,.85)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve decisions, constraints and pending work.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'KEEP CURRENT INPUT DURING LATE PREPARATION')
  assert.equal(branches.length,1);assert.equal(count(h,'compaction/summary'),1)
  assert.ok(branches[0].maxTokens<98976)
  const header=h.agent.session.snapshotEvents().find(e=>e.type==='request/header'&&e.data.header.config.maxTokens===98976)
  assert.ok(header)
  assert.ok(h.main.at(-1).content.includes('KEEP CURRENT INPUT DURING LATE PREPARATION'))
 }finally{await close(h)}
})

test('500K window prepares at 350K and replaces at 400K with a configured 128K output ceiling',async()=>{
 const h=await lab({capacity:500000,maxTokens:128000,config:{summaryMode:'main-fork'}})
 const original=h.ctx.llm.stream.bind(h.ctx.llm);let branches=0,closed=false
 try{
  history(h,.696)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const prompt=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(prompt.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(p=>({index:p.index,summary:'# Historical state\nPreserve constraints and pending work; originals remain available.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'STILL BELOW PREPARATION')
  assert.equal(branches,0)
  const p=currentPolicy(h.engine,h.agent)
  assert.equal(p.prepareActiveTokens,350000);assert.equal(p.softActiveTokens,400000)
  assert.ok(activeInputTokens(h.engine,h.agent)<350000)
  await send(h,'CROSS PREPARATION '+ 'x'.repeat(18000))
  await h.engine.settleBackgroundFold(h.agent)
  assert.equal(branches,1);assert.equal(count(h,'compaction/summary'),0)
  await send(h,'STILL BELOW REPLACEMENT '+ 'x'.repeat(120000))
  assert.ok(activeInputTokens(h.engine,h.agent)<400000)
  assert.equal(count(h,'compaction/summary'),0)
  await send(h,'CROSS REPLACEMENT AND KEEP EXACT '+ 'x'.repeat(80000))
  assert.equal(count(h,'compaction/summary'),1);assert.equal(branches,1)
  assert.ok(h.main.at(-1).content.includes('CROSS REPLACEMENT AND KEEP EXACT'))
  assert.equal(h.agent.options.maxTokens,128000,'user configuration stays intact')
  assert.equal(h.agent.session.requestHeader().config.maxTokens,98976)
  assert.ok(h.main.every(r=>r.inputTokens+r.maxTokens<500000))
  const session=h.agent.session
  await close(h);closed=true
  const fresh=new Context()
  try{
   new SessionStore(fresh)
   const resumed=fresh.sessions.create(session.id,{meta:session.header,seed:session.snapshotEvents(),eventState:'detached'})
   assert.deepEqual(resumed.requestHeader(),session.requestHeader(),'closing an idle host must leave a cold-readable log')
   assert.equal(resumed.requestHeader().config.maxTokens,98976,'shutdown must not append an out-of-turn header')
  }finally{await fresh.fiber.dispose()}
 }finally{if(!closed)await close(h)}
})

for(const stalled of [false,true])test('native fork '+(stalled?'still stops at its longer deadline':'can finish after the former three-minute deadline'),async t=>{
 const deadline=controlsConfig({auto:true,summaryMode:'main-fork'}).summaryTimeoutMs
 assert.equal(deadline,ROLLING_DEFAULTS.summaryTimeoutMs)
 assert.equal(deadline,600000)
 assert.equal(controlsConfig({auto:true,summaryMode:'main-fork',summaryTimeoutMs:120000}).summaryTimeoutMs,120000)
 const h=await lab({capacity:500000,config:{summaryMode:'main-fork',summaryTimeoutMs:deadline}})
 let release,branchSignal,branches=0
 const barrier=new Promise(resolve=>release=resolve),original=h.ctx.llm.stream.bind(h.ctx.llm)
 try{
  history(h,.72)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++;branchSignal=options.signal
   await barrier
   const directive=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical state\nOriginal records preserve constraints and pending work.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  t.mock.timers.enable({apis:['setTimeout']})
  await send(h,'CURRENT INPUT MUST REMAIN VERBATIM')
  assert.equal(branches,1)
  assert.equal(h.main.length,1,'normal requests continue while a background fork is preparing')
  t.mock.timers.tick(180001)
  await Promise.resolve()
  assert.equal(branchSignal.aborted,false,'the old deadline must not cancel a large fork')
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'summarizing')
  if(stalled){
   t.mock.timers.tick(deadline)
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   assert.equal(branchSignal.aborted,true)
   assert.ok(h.warnings.some(s=>s.includes('timeout')))
   assert.equal(count(h,'compaction/summary'),0)
  }else{
   release();await h.engine.settleBackgroundFold(h.agent)
   assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
   await send(h,'LATE INPUT '+ 't'.repeat(200000))
   assert.equal(count(h,'compaction/summary'),1,h.warnings.join('\n'))
   assert.equal(branches,1,'replacement reuses the finished fork')
  }
  assert.ok(h.agent.session.deriveMessages().some(m=>JSON.stringify(m).includes('CURRENT INPUT MUST REMAIN VERBATIM')))
 }finally{release?.();t.mock.timers.reset();await close(h)}
})

for(const failure of [false,true])test('real DSH main branch: '+(failure?'summary failure blocks capacity':'one background call, source blocks and append-only replacement'),async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:300,summaryRetryCooldownMs:1000}})
 try {
  history(h,failure?.91:.72)
  const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[],requests=[]
  let release
  const barrier=new Promise(resolve=>release=resolve)
  h.ctx.llm.stream=options=>{
   if(!forkScope.getStore()){requests.push(structuredClone({...options,signal:undefined}));return original(options)}
   return (async function*(){
    branches.push(structuredClone({...options,signal:undefined}))
    if(failure)throw Error('synthetic branch failure')
    await barrier
    const directive=options.messages.at(-1).content.map(b=>b.text||'').join('')
    const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
    yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(range=>({index:range.index,summary:'# Historical state\nPending inspection. Read original records for exact facts.'}))})}
    yield {type:'usage',usage:{inputTokens:100,outputTokens:100,totalTokens:10200,cacheReadTokens:10000}}
    yield {type:'finish',reason:{kind:'stop'}}
   })()
  }
  const initial=send(h,'MAIN INPUT MUST REMAIN VERBATIM')
  await until(()=>branches.length===1)
  if(!failure){await until(()=>h.main.length===1);assert.equal(count(h,'compaction/summary'),0);release()}
  else{
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   assert.equal(h.main.length,0);assert.equal(count(h,'compaction/summary'),0)
   h.agent.cancel({kind:'user'},{keepInbox:true})
  }
  await initial
  await h.engine.settleBackgroundFold(h.agent)
  if(failure){assert.equal(h.main.length,0);assert.equal(count(h,'compaction/summary'),0);return}
  assert.equal(branches.length,1)
  const mainRequest=h.engine.mainRequests.get(h.agent).request
  assert.deepEqual(branches[0].messages.slice(0,-1),mainRequest.messages)
  const settings=value=>({...value,messages:[],signal:undefined})
  assert.deepEqual(settings(branches[0]),settings(mainRequest))
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
  await send(h,'LATE APPENDED INPUT '+ 't'.repeat(28000))
  assert.equal(count(h,'compaction/summary'),1,h.warnings.join('\n'))
  assert.equal(branches.length,1,'replacement must never generate another summary')
  const event=h.agent.session.snapshotEvents().find(e=>e.type==='compaction/summary')
  assert.ok(event.data.preparedBatchCount>=2);assert.equal(event.data.usage.cacheReadTokens,10000)
  assert.ok(h.main.at(-1).content.includes('MAIN INPUT MUST REMAIN VERBATIM'))
  assert.ok(h.main.at(-1).content.includes('LATE APPENDED INPUT'))
  await checkpoint(h,{duplicate:false})
  history(h,.72)
  await send(h,'SECOND CYCLE INPUT')
  await h.engine.settleBackgroundFold(h.agent)
  await send(h,'SECOND CYCLE CONTINUE')
  assert.equal(count(h,'compaction/summary'),2,JSON.stringify({warnings:h.warnings,branches:branches.length,errors:h.errors.map(String),active:h.ctx.tokenMeter.measure(h.agent.session).totalTokens,state:h.engine.backgroundFolds.get(h.agent)?.status}))
  assert.equal(branches.length,2)
  await checkpoint(h,{duplicate:false})
 } finally{await close(h)}
})

for (const fault of ['truncated','tool-call','cancelled']) test('DSH branch refuses '+fault+' and keeps every original',async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:300,summaryRetryCooldownMs:1000}})
 try {
  history(h,.91)
  const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
    if(fault==='truncated'){yield {type:'text-delta',index:0,text:'{"blocks":[]}'};return}
    if(fault==='tool-call'){yield {type:'tool-call-delta',index:0,id:'forbidden',name:'read',argumentsDelta:'{}'};return}
    for(const controller of h.engine.backgroundControllers)controller.abort(Error('synthetic cancellation'))
    yield {type:'finish',reason:{kind:'stop'}}
  })()
  const pending=send(h,'CURRENT INPUT KEPT EXACTLY')
  if(fault!=='cancelled'){
   await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
   assert.equal(h.main.length,0)
   h.agent.cancel({kind:'user'},{keepInbox:true})
  }
  await pending
  assert.equal(h.main.length,0)
  assert.equal(count(h,'compaction/summary'),0)
  assert.ok(h.agent.session.snapshotEvents().some(event=>JSON.stringify(event).includes('CURRENT INPUT KEPT EXACTLY')))
 } finally {await close(h)}
})

test('native fork jobs share the archive lease and never generate concurrently',async()=>{
 const {withForkLease}=await import('../dsh/archive-fork.js')
 const h=await lab({config:{auto:false}});let release,started=0
 try{
  const barrier=new Promise(resolve=>release=resolve),run=()=>{started++;return barrier}
  const first=withForkLease(h.engine.superLcmStore.path,h.id,'revision',null,run)
  await assert.rejects(withForkLease(h.engine.superLcmStore.path,h.id,'revision',null,run),/已有后台摘要/)
  assert.equal(started,1);release();await first
  await withForkLease(h.engine.superLcmStore.path,h.id,'revision',null,()=>{started++})
  assert.equal(started,2)
 }finally{release?.();await close(h)}
})

test('a settings change during native generation fences archive publication',async()=>{
 const {registerForkArchive,forkArchiveSnapshot,publishForkArchive}=await import('../dsh/archive-fork.js')
 let revision='before',saved=0;const path='fixture-revision-fence'
 const unregister=registerForkArchive(path,async()=>{saved++},()=>revision)
 try{const snapshot=forkArchiveSnapshot(path);revision='after';await assert.rejects(publishForkArchive(path,'s',[],{},snapshot),/配置已变化/);assert.equal(saved,0)}finally{unregister()}
})

test('DSH 50% policy prepares at 40% and uses an optional native model only on its background branch',async()=>{
 const {automaticRatios}=await import('../dsh/ratio-policy.js')
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',forkModelOverride:true,...automaticRatios(.5),summarizationProvider:'lab-main',summarizationModel:'summary-alternate'}})
 try{
  const original=h.ctx.llm.stream.bind(h.ctx.llm),branches=[]
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches.push(options)
   const directive=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical state\nRetain all constraints. Work remains pending.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  history(h,.32);await send(h,'BELOW_40_PERCENT');await h.engine.settleBackgroundFold(h.agent)
  assert.equal(branches.length,0)
  const policy=h.engine.resolvedPolicies.get(h.agent),used=h.ctx.tokenMeter.measure(h.agent.session).totalTokens
  assert.ok(used<policy.prepareActiveTokens)
  const target=(policy.prepareActiveTokens+policy.softActiveTokens)/2
  history(h,Math.max(0,target-used)/(h.capacity-2048),{pieces:2});await send(h,'PREPARE_ABOVE_40_PERCENT');await h.engine.settleBackgroundFold(h.agent)
  assert.equal(branches.length,1,h.warnings.join('\n'));assert.equal(branches[0].model,'summary-alternate')
  assert.equal(h.agent.options.model,'main-64000');assert.equal(count(h,'compaction/summary'),0)
  assert.deepEqual(branches[0].messages.slice(0,-1),h.engine.mainRequests.get(h.agent).request.messages)
  await send(h,'LATER_INPUT '+ 't'.repeat(20000))
  assert.equal(count(h,'compaction/summary'),1,h.warnings.join('\n'))
  assert.equal(branches.length,1,'replacement must reuse the prepared tree')
  assert.equal(h.engine.mainRequests.get(h.agent).request.model,'main-64000')
 }finally{await close(h)}
})

test('DSH rejects an auxiliary model that cannot hold the complete branch and preserves originals',async()=>{
 const {automaticRatios}=await import('../dsh/ratio-policy.js')
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',forkModelOverride:true,...automaticRatios(.5),summarizationProvider:'lab-main',summarizationModel:'main-8000'}})
 try{
  let branches=0;const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>{if(forkScope.getStore())branches++;return original(options)}
  history(h,.42);const originals=h.agent.session.surface.nodes.slice()
  await send(h,'KEEP_INPUT_WHEN_SUMMARY_MODEL_IS_TOO_SMALL')
  await until(()=>h.engine.backgroundFolds.get(h.agent)?.status==='retrying')
  assert.equal(branches,0);assert.equal(count(h,'compaction/summary'),0)
  assert.ok(originals.every(seq=>h.agent.session.surface.nodes.includes(seq)))
  assert.equal(h.agent.options.model,'main-64000')
  assert.equal(h.engine.backgroundFolds.get(h.agent).errorKind,'capacity')
 }finally{await close(h)}
})

test('real DSH preserves recent originals with an oversized 80K retention preference on a 64K model',async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',keepRecentTokens:80000}})
 try {
  history(h,.72)
  const original=h.ctx.llm.stream.bind(h.ctx.llm);let branches=0
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
   branches++
   const directive=options.messages.at(-1).content.map(b=>b.text||'').join('')
   const plan=JSON.parse(directive.split('\n').find(line=>line.startsWith('[{"index":')))
   yield {type:'text-delta',index:0,text:JSON.stringify({blocks:plan.map(n=>({index:n.index,summary:'# Historical decisions\nOriginal records retain all precise facts. Task remains pending.'}))})}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'CURRENT REQUEST MUST STAY EXACT');await h.engine.settleBackgroundFold(h.agent)
  assert.equal(h.engine.backgroundFolds.get(h.agent)?.status,'ready',h.warnings.join('\n'))
  await send(h,'APPENDED AFTER PREPARATION '+ 't'.repeat(28000))
  assert.equal(count(h,'compaction/summary'),1,h.warnings.join('\n'))
  assert.equal(branches,1);assert.equal(h.errors.length,0)
  assert.ok(h.main.at(-1).content.includes('CURRENT REQUEST MUST STAY EXACT'))
  assert.ok(h.main.at(-1).content.includes('APPENDED AFTER PREPARATION'))
  await checkpoint(h,{duplicate:false})
 }finally{await close(h)}
})
