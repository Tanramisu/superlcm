import {test,expect} from 'claude-code/testing'

const original=[
  {role:'user',text:'Historical authorized inspection',toolUses:[]},
  {role:'assistant',text:'Recorded historical result',toolUses:[]},
  {role:'user',text:'CURRENT: preserve all files; inspect only.',toolUses:[]},
]
function base(on,id,reply) {
  on('session.id',()=>({value:id}))
  on('session.usage',()=>({value:{context:{tokens:90000,window:100000}}}))
  on('session.model',()=>({value:'offline-current'}))
  on('process.run',($,e)=>({value:{stdout:JSON.stringify(reply(e.argv[2],e.init)),stderr:'',exitCode:0}}))
}
function rescuePlan(command,deadline=Date.now()+5000) {
  if(command==='compact-packet')return {use:false,rescue:true}
  if(command==='compact-rescue-prepare')return {work:{node_id:'isolated-root',claim_id:'isolated-claim',input_hash:'isolated-hash',deadline_ms:deadline,model:'offline-current',system:'Summary task',prompt:'Historical source only',maxTokens:1024,task:{language:{code:'en'},requireHeading:true}}}
  if(command==='compact-rescue-check')return {valid:true}
  return {}
}
for(const trigger of ['auto','precompute'])test('ready packet replaces native: '+trigger,async($,on)=>{
  let native=0
  base(on,'ready-'+trigger,()=>({use:true,packet:'# Verified historical summary',start:2}))
  on('session.compact',($,e)=>{native++;return {messages:e.messages}})
  const result=await $.session.compact({messages:original,trigger})
  expect(native).toBe(0)
  expect(result.messages[0].text).toBe('# Verified historical summary')
  expect(result.messages.slice(1)).toEqual(original.slice(2))
})
for(const reason of ['off','subagent','storage-error'])test('safe native handoff: '+reason,async($,on)=>{
  let native=0,models=0,processes=0
  base(on,'fallback-'+reason,()=>{processes++;if(reason==='storage-error')throw Error('Isolated process failure');return {use:false}})
  on('model.complete',()=>{models++;throw Error('No model call allowed for native handoff')})
  on('session.compact',($,e)=>{native++;return {messages:e.messages}})
  const result=await $.session.compact({messages:original,trigger:'auto',...(reason==='subagent'?{agentId:'isolated-child'}:{})})
  expect(native).toBe(1);expect(models).toBe(0)
  if(reason==='subagent')expect(processes).toBe(0)
  expect(result.messages).toEqual(original)
})
test('final main-model rescue works through the real SDK capability boundary',async($,on)=>{
  let native=0,models=0,saved=0
  base(on,'rescue',command=>{
    if(command==='compact-rescue-save'){saved++;return {use:true,packet:'# Final verified summary',start:2}}
    return rescuePlan(command)
  })
  on('model.complete',()=>{models++;return {value:{isAnswered:true,text:'# Historical state\nPreserve prior inspection constraints and exact source records.',stopReason:'end_turn'}}})
  on('session.compact',($,e)=>{native++;return {messages:e.messages}})
  const result=await $.session.compact({messages:original,trigger:'auto'})
  expect(native).toBe(0);expect(models).toBe(1);expect(saved).toBe(1)
  expect(result.messages[0].text).toBe('# Final verified summary')
  expect(result.messages.slice(1)).toEqual(original.slice(2))
})
for(const reason of ['quota','truncated','unanswered'])test('failed final rescue hands back to native: '+reason,async($,on)=>{
  let native=0,models=0,saves=0
  base(on,'rescue-failed-'+reason,command=>{if(command==='compact-rescue-save')saves++;return rescuePlan(command)})
  on('model.complete',()=>{models++;if(reason==='quota')throw Error('Synthetic quota exhaustion');return {value:{text:'# Incomplete summary',isAnswered:reason!=='unanswered',stopReason:reason==='truncated'?'max_tokens':'end_turn'}}})
  on('session.compact',($,e)=>{native++;return {messages:e.messages}})
  const result=await $.session.compact({messages:original,trigger:'auto'})
  expect(result.messages).toEqual(original)
  expect(native).toBe(1);expect(models).toBe(1);expect(saves).toBe(0)
})
test('actual SDK tool and result fields remain intact through native handoff',async($,on)=>{
  base(on,'sdk-tools',()=>({use:false}))
  on('session.compact',($,e)=>({messages:e.messages}))
  const messages=[original[0],
    {role:'assistant',text:'Inspect source',toolUses:[{tool_use_id:'offline-tool-1',tool:'inspect',input:{path:'relative-fixture'}}]},
    {role:'user',text:'',toolUses:[],toolResults:[{tool_use_id:'offline-tool-1',text:'Exact offline tool output',isError:false}]},
    original[2],
  ]
  expect((await $.session.compact({messages,trigger:'auto'})).messages).toEqual(messages)
})
test('lagging precompute skips native without buying a final rescue',async($,on)=>{
  let native=0,models=0
  base(on,'precompute-behind',()=>({use:false,retry:true,rescue:true}))
  on('model.complete',()=>{models++;throw Error('Precompute must not buy rescue')})
  on('session.compact',($,e)=>{native++;return {messages:e.messages}})
  const result=await $.session.compact({messages:original,trigger:'precompute'})
  expect(typeof result.skip).toBe('string');expect(native).toBe(0);expect(models).toBe(0)
})
test('precompute with no active summary work uses native without buying rescue',async($,on)=>{
  let native=0,models=0,prepares=0
  base(on,'precompute-no-work',command=>{if(command==='compact-rescue-prepare')prepares++;return {use:false,rescue:true}})
  on('model.complete',()=>{models++;throw Error('Precompute must not buy rescue')})
  on('session.compact',($,e)=>{native++;return {messages:e.messages}})
  const result=await $.session.compact({messages:original,trigger:'precompute'})
  expect(result.messages).toEqual(original);expect(native).toBe(1);expect(models).toBe(0);expect(prepares).toBe(0)
})
test('actual pressure still hands off after failed rescue, even with retry flag',async($,on)=>{
  let native=0,models=0
  base(on,'pressure-behind',command=>command==='compact-packet'?{use:false,retry:true,rescue:true}:rescuePlan(command))
  on('model.complete',()=>{models++;throw Error('Synthetic final model failure')})
  on('session.compact',($,e)=>{native++;return {messages:e.messages}})
  const result=await $.session.compact({messages:original,trigger:'auto'})
  expect(result.messages).toEqual(original);expect(native).toBe(1);expect(models).toBe(1)
})
test('turn.step transparently relays streamed chunks and the final result',async($,on)=>{
  base(on,'stream',()=>({host:false}))
  on('turn.step',async function*(){yield {kind:'text',index:0,text:'first'};yield {kind:'text',index:0,text:'second'};return {answer:'firstsecond',toolUses:[]}})
  const stream=$.turn.step({model:'offline-current'})
  const chunks=[]
  for(;;){const item=await stream.next();if(item.done){expect(item.value).toEqual({answer:'firstsecond',toolUses:[]});break}chunks.push(item.value)}
  expect(chunks).toEqual([{kind:'text',index:0,text:'first'},{kind:'text',index:0,text:'second'}])
})
