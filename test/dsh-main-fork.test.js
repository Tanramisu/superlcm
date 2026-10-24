// Real DSH admission/rebuild/compaction; the model adapter is wholly local.
import test from 'node:test'
import assert from 'node:assert/strict'
import {lab,history,send,close,count,checkpoint,until} from './reliability/lab.mjs'
import {forkScope} from '../dsh/main-fork.js'
for(const failure of [false,true])test('real DSH main branch: '+(failure?'summary failure blocks capacity':'one background call, source blocks and append-only replacement'),async()=>{
 const h=await lab({capacity:64000,config:{summaryMode:'main-fork',summaryTimeoutMs:300,summaryRetryCooldownMs:1000}})
 try {
  history(h,failure?.94:.72)
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
  await initial
  await h.engine.settleBackgroundFold(h.agent)
  if(failure){assert.equal(h.main.length,0);assert.ok(h.errors.length);assert.equal(count(h,'compaction/summary'),0);return}
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
  history(h,.94)
  const original=h.ctx.llm.stream.bind(h.ctx.llm)
  h.ctx.llm.stream=options=>!forkScope.getStore()?original(options):(async function*(){
    if(fault==='truncated'){yield {type:'text-delta',index:0,text:'{"blocks":[]}'};return}
    if(fault==='tool-call'){yield {type:'tool-call-delta',index:0,id:'forbidden',name:'read',argumentsDelta:'{}'};return}
    for(const controller of h.engine.backgroundControllers)controller.abort(Error('synthetic cancellation'))
    yield {type:'finish',reason:{kind:'stop'}}
  })()
  await send(h,'CURRENT INPUT KEPT EXACTLY')
  assert.equal(h.main.length,0);assert.ok(h.errors.length)
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
