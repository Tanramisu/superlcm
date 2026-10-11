import test from 'node:test'
import assert from 'node:assert/strict'
import {summarizeWithModel} from '../src/summarize.js'
const options=(fetchImpl,more={})=>({model:'offline',apiProvider:'openai',apiURL:'http://127.0.0.1:1',fetchImpl,timeoutMs:25,...more})
const complete=()=>new Response(JSON.stringify({choices:[{message:{content:'# Complete historical facts'},finish_reason:'stop'}]}))
async function bounded(run){let timer;try{return await Promise.race([run(),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Request remained pending beyond deadline')),500))])}finally{clearTimeout(timer)}}
test('ignored fetch abort settles deadline and disposes its late response',async()=>{
 let release,cancelled=false
 const pending=summarizeWithModel('Synthetic source',options(()=>new Promise(resolve=>release=resolve)))
 await bounded(()=>assert.rejects(pending,error=>error.summaryKind==='timeout'))
 release({body:{cancel:async()=>{cancelled=true}}});await new Promise(resolve=>setImmediate(resolve))
 assert.equal(cancelled,true)
})
for(const method of ['text','json'])test(`ignored ${method} response cancellation cannot block the deadline`,async()=>{
 const response={ok:true,headers:new Headers(),[method]:()=>new Promise(()=>{})}
 await bounded(()=>assert.rejects(summarizeWithModel('Synthetic source',options(async()=>response)),error=>error.summaryKind==='timeout'))
})
test('quota exhaustion under HTTP 429 is distinct from transient rate limiting and does not leak its body',async()=>{
 for(const [code,kind]of [['insufficient_quota','quota'],['rate_limit_exceeded','rate_limit']]){
  await assert.rejects(summarizeWithModel('Synthetic source',options(async()=>new Response(JSON.stringify({error:{message:'SECRET-SOURCE-AND-CREDENTIAL'.repeat(20),code}}),{status:429}))),error=>error.summaryKind===kind&&!error.message.includes('SECRET'))
 }
})
test('parent cancellation stops ignored transport without a repair retry',async()=>{
 const controller=new AbortController();let calls=0
 const pending=summarizeWithModel('Synthetic source',options(()=>{calls++;controller.abort(Error('Synthetic user stop'));return new Promise(()=>{})},{signal:controller.signal,timeoutMs:300}))
 await bounded(()=>assert.rejects(pending,error=>error.summaryKind==='cancelled'));assert.equal(calls,1)
})
test('ordinary completed API output still passes the bounded request path',async()=>{
 assert.equal(await summarizeWithModel('Synthetic source',options(async()=>complete())),'# Complete historical facts')
})
