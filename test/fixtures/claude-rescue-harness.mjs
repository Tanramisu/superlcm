import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdtempSync,writeFileSync,appendFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {ClaudeStore} from '../../src/store.js'

export const root=fileURLToPath(new URL('../../',import.meta.url))
export const output='# Historical state\nThe synthetic verification is unfinished. Original evidence and constraints are preserved. Newer explicit instructions govern what happens next.'
export const answer=()=>({text:output,isAnswered:true,stopReason:'end_turn'})
export function history({native=false,longRequest=false,steps=48}={}) {
  const rows=[],push=(type,content,extra={})=>rows.push({type,uuid:randomUUID(),message:{content},...extra})
  for(let turn=0;turn<3;turn++) {
    push('user','Inspect historical fixture '+turn+'.')
    for(let i=0;i<6;i++) {
      const id='past-'+turn+'-'+i
      push('assistant',[{type:'text',text:'Historical step '+turn+':'+i+'. '+'a'.repeat(1500)},{type:'tool_use',id,name:'offline',input:{argument:i}}])
      push('user',[{type:'tool_result',tool_use_id:id,content:'Archived result '+turn+':'+i+'. '+'b'.repeat(2000)}])
    }
    push('assistant','Historical outcome '+turn+'.')
  }
  if(native){push('system',[],{subtype:'compact_boundary'});push('user','This session is being continued from a previous conversation. Historical synthetic continuation.',{isCompactSummary:true})}
  push('user','CURRENT_REQUEST_BEGIN: inspect only. Never delete or deploy. '+(longRequest?'Full constraint. '.repeat(180):'')+'CURRENT_REQUEST_END')
  for(let i=0;i<steps;i++) {
    const id='current-'+i
    push('assistant',[{type:'text',text:'Current step '+i+'. '+'c'.repeat(1600)},{type:'tool_use',id,name:'offline',input:{argument:i}}])
    push('user',[{type:'tool_result',tool_use_id:id,content:'Current evidence '+i+'. '+'d'.repeat(2200)}])
  }
  return rows
}
export function messages(rows) {
  return rows.filter(r=>['user','assistant'].includes(r.type)).map(r=>{
    const c=r.message.content,blocks=Array.isArray(c)?c:[]
    return {role:r.type,text:typeof c==='string'?c:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n'),
      toolUses:blocks.filter(b=>b.type==='tool_use').map(b=>({tool_use_id:b.id,name:b.name,input:b.input})),
      toolResults:blocks.filter(b=>b.type==='tool_result').map(b=>({tool_use_id:b.tool_use_id,content:b.content,is_error:b.is_error}))}
  })
}
export function fixture({rows=history(),tokens=90000,window=100000,deadline=0}={}) {
  const dir=mkdtempSync(join(tmpdir(),'superlcm-claude-rescue-')),home=join(dir,'store'),file=join(dir,'source.jsonl'),id=randomUUID()
  writeFileSync(file,rows.map(r=>JSON.stringify(r)+'\n').join(''))
  const env={...process.env,SUPERLCM_HOME:home,SUPERLCM_CATCHUP_MS:String(deadline),SUPERLCM_SEGMENT_MESSAGES:'8',SUPERLCM_SUMMARY_MODE:'',SUPERLCM_CLI_WORKER:'',SUPERLCM_SUMMARY_CONCURRENCY:'1'}
  const store=new ClaudeStore(home)
  store.ingest(id,file);store.setMetadata(id,{harness:'claude-code',externalId:id});store.setHarnessSetting('claude-code','cli','offline-summary')
  store.setTuning({target_tokens:2000,batch_size:8,fanout:4});store.setTakeover({enabled:true,window,keep:5000,previous:null});store.close()
  const nativeAt=rows.findIndex(r=>r.isCompactSummary===true)
  const h={id,home,file,env,rows,tokens,window,messages:messages(nativeAt<0?rows:rows.slice(nativeAt)),commands:[],calls:[]}
  h.open=()=>new ClaudeStore(home)
  h.cli=(command,input='',flags=[])=>new Promise((resolve,reject)=>{
    assert.ok(['summary-host','summary-claim','summary-check','summary-save','summary-release','compact-packet','compact-diagnostic','compact-rescue-prepare','compact-rescue-check','compact-rescue-save','compact-rescue-stop'].includes(command),'Offline command whitelist: '+command)
    const child=execFile(process.execPath,[join(root,'src/cli.js'),command,id,...flags],{env,timeout:5000,maxBuffer:8e6},(error,stdout)=>{
      if(error){reject(error);return}
      try{resolve(JSON.parse(stdout.trim().split('\n').at(-1)||'{}'))}catch(error){reject(error)}
    });child.stdin.end(typeof input==='string'?input:JSON.stringify(input))
  })
  h.seed=async(n=2)=>{for(let i=0;i<n;i++){const c=await h.cli('summary-claim');assert.ok(c.work);assert.equal((await h.cli('summary-save',{batch_id:c.work.batch_id,claim_id:c.work.claim_id,summary:output,model:'offline-summary',isAnswered:true})).saved,true)}}
  h.snapshot=()=>{const s=h.open();try{return {nodes:s.db.prepare('SELECT * FROM nodes WHERE session=? ORDER BY level,first,id').all(id),originals:s.eventRows(id).map(e=>s.exact(id,e.ordinal))}}finally{s.close()}}
  h.unchanged=before=>{const now=h.snapshot();assert.deepEqual(now.originals,before.originals);for(const node of before.nodes)assert.deepEqual(now.nodes.find(n=>n.id===node.id),node);for(const node of now.nodes)for(const child of JSON.parse(node.children))assert.ok(now.nodes.some(n=>n.id===child));return now}
  h.append=more=>{appendFileSync(file,more.map(r=>JSON.stringify(r)+'\n').join(''));const s=h.open();try{s.ingest(id,file)}finally{s.close()}}
  h.hook=async(complete=answer,{boundary=async(command,run)=>run(),trigger='auto'}={})=>{
    const mod=await import(pathToFileURL(join(root,'hooks/compact-mod.js')).href+'?fixture='+id),handlers=new Map(),controller=new AbortController()
    mod.register((event,fn)=>handlers.set(event,fn))
    let model='offline-current',fallbacks=0
    const $={plugin:{root},session:{id:async()=>id,model:async()=>model,usage:async()=>({context:{tokens:h.tokens,window:h.window}})},
      model:{complete:async input=>{h.calls.push(input);return complete(input)}},
      process:{run:async(args,options)=>{const command=args[2];h.commands.push(command);const r=await boundary(command,()=>h.cli(command,options.stdin,args.slice(4)));return {stdout:JSON.stringify(r)+'\n'}}}}
    await handlers.get('session.start')($,{},e=>e)
    return {$,handlers,controller,changeModel:value=>{model=value},run:()=>handlers.get('session.compact')($,{messages:h.messages,trigger,signal:controller.signal},()=>{fallbacks++;return {fallback:true}}),get fallbacks(){return fallbacks}}
  }
  return h
}
