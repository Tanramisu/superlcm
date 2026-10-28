import {randomUUID} from 'node:crypto'
import {summaryEvents} from './summary-source.js'
import {detectSummaryLanguage,userTextFromRecord} from './summary-language.js'
import {estimateSummaryTokens} from './summary-tokens.js'
import {summarySettingsRevision} from './summarize.js'
import {forkHash,forkAnchors,forkTreePlan,forkDirective,parseForkTree} from './fork-summary.js'
import {summarizeNativeFork} from './native-fork.js'
import {bindSummaryRun,finishSummaryRun,progressSummaryRun,summaryRunOwns} from './summary-runs.js'
import {summaryAttempt} from './summary-attempt.js'
import {classifySummaryError,summaryErrorDetail} from './summary-errors.js'

export function nativeContextUsage(store,session,provided={}){
  if(provided.tokens>0&&provided.window>0)return provided
  const rows=store.db.prepare('SELECT ordinal FROM events WHERE session=? ORDER BY ordinal DESC LIMIT 512').all(session)
  for(const row of rows){
    let record;try{record=JSON.parse(store.exact(session,row.ordinal))}catch{continue}
    const info=record.payload?.info,usage=info?.last_token_usage??record.message?.usage
    const window=info?.model_context_window??record.context_window??usage?.context_window
    if(!usage||!Number.isFinite(window)||window<=0)continue
    const tokens=usage.input_tokens+(usage.output_tokens||0)+(info?0:(usage.cache_read_input_tokens||0)+(usage.cache_creation_input_tokens||0))
    if(Number.isFinite(tokens)&&tokens>0)return {tokens,window}
  }
  return {tokens:0,window:0}
}
export function forkPreparationThreshold(store,session,window){
  const policy=store.takeover()
  if(store.metadata(session).harness==='claude-code'&&policy.ratio!=null)return window*Math.round((policy.ratio-.1)*1e12)/1e12
  return store.metadata(session).harness==='claude-code'&&policy.enabled?Math.min(window*.7,policy.window*.7/.8):window*.7
}
function anchor(raw){
  try{
    const r=JSON.parse(raw),m=r.message??r.payload??r
    return forkAnchors([{content:m.content??m.message??m.text??''}])
  }catch{return {firstAnchor:'',lastAnchor:''}}
}
export function planMainFork(store,session,{keepTokens=40000,force=false,env=process.env}={}){
  const done=store.nodeRows(session,0),start=done.length?Math.max(...done.map(n=>n.last))+1:0
  const all=summaryEvents(store,session,start),tuning=store.tuning()
  if(!all.length)return null
  const sizes=all.map(e=>estimateSummaryTokens(e.summaryText)),total=sizes.reduce((a,b)=>a+b,0)
  let remaining=total,cut=-1,pending=new Set()
  for(let i=0;i<all.length;i++){
    remaining-=sizes[i]
    const p=all[i].toolPairing
    if(p.endsTurn)pending.clear()
    for(const id of p.opened)pending.add(id)
    for(const id of p.closed)pending.delete(id)
    if(!pending.size&&(remaining>=keepTokens||force&&total<=keepTokens))cut=i
  }
  if(cut<0)return null
  const selected=all.slice(0,cut+1),leaves=[]
  let first=0,size=0;pending=new Set()
  function add(last){
    const visible=selected.slice(first,last+1).filter(e=>e.summaryText.trim())
    if(visible.length){const a=anchor(store.exact(session,visible[0].ordinal)),b=anchor(store.exact(session,visible.at(-1).ordinal));leaves.push({index:leaves.length,firstMessage:selected[first].ordinal,lastMessage:selected[last].ordinal,firstAnchor:a.firstAnchor,lastAnchor:b.lastAnchor})}
    first=last+1;size=0
  }
  for(let i=0;i<selected.length;i++){
    const p=selected[i].toolPairing;if(p.endsTurn)pending.clear()
    for(const id of p.opened)pending.add(id);for(const id of p.closed)pending.delete(id)
    size+=estimateSummaryTokens(selected[i].summaryText)
    if(!pending.size&&(size>=(tuning.target_tokens||Math.floor(tuning.target_chars/4))||i===selected.length-1))add(i)
  }
  if(!leaves.length)return null
  const originals=selected.map(e=>({ordinal:e.ordinal,digest:e.digest})),digest=forkHash(originals),language=detectSummaryLanguage(selected.map(e=>userTextFromRecord(store.exact(session,e.ordinal))))
  const targetTokens=Math.min(12000,Math.max(2048,Math.floor(total*.1)))
  return {leaves,digest,originals,language,targetTokens,fanout:tuning.fanout,revision:summarySettingsRevision(store,session,env),tree:forkTreePlan(leaves,tuning.fanout)}
}
export function saveForkTree(store,session,plan,tree,{model,usage={},branchId=null,owner,validate=()=>true}={}){
  store.db.exec('BEGIN IMMEDIATE')
  try{
    if(!validate()||owner&&!store.ownsLease(session,owner))throw Error('摘要配置或任务归属已变化，结果未保存')
    for(const row of plan.originals){store.exact(session,row.ordinal);if(store.db.prepare('SELECT digest FROM events WHERE session=? AND ordinal=?').get(session,row.ordinal)?.digest!==row.digest)throw Error('摘要原文已变化，结果未保存')}
    const ids=tree.map(n=>n.archiveId||'s'+n.level+'-'+forkHash([session,plan.digest,n.index,n.summary]).slice(0,24))
    for(const node of tree){
      const inserted=store.db.prepare('INSERT OR IGNORE INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run(session,ids[node.index],node.level,node.firstMessage,node.lastMessage,JSON.stringify(node.children.map(i=>ids[i])),node.summary,plan.digest,model)
      if(node.sourceRecords){
        store.db.exec('CREATE TABLE IF NOT EXISTS dsh_node_sources(session TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(session,id,seq))')
        for(const seq of node.sourceRecords){if(!plan.originals.some(r=>r.ordinal===seq)||seq<node.firstMessage||seq>node.lastMessage)throw Error('摘要来源不属于当前分支');store.db.prepare('INSERT OR IGNORE INTO dsh_node_sources VALUES(?,?,?)').run(session,ids[node.index],seq)}
      }
      if(inserted.changes)store.db.prepare('INSERT INTO node_fts(session,id,summary) VALUES(?,?,?)').run(session,ids[node.index],node.summary)
    }
    store.db.exec('CREATE TABLE IF NOT EXISTS fork_summary_receipts(session TEXT PRIMARY KEY,digest TEXT NOT NULL,branch TEXT,model TEXT,usage TEXT NOT NULL,at_ms INTEGER NOT NULL)')
    store.db.prepare('INSERT OR REPLACE INTO fork_summary_receipts VALUES(?,?,?,?,?,?)').run(session,plan.digest,branchId,model,JSON.stringify(usage),Date.now())
    store.db.exec('COMMIT');return ids
  }catch(error){store.db.exec('ROLLBACK');throw error}
}
function waitForRetry(ms,signal){
  signal.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const finish=(fn,value)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);fn(value)}
    const cancel=()=>finish(reject,signal.reason)
    const timer=setTimeout(()=>finish(resolve),ms)
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()
  })
}
export async function generateMainFork(store,session,{runId,signal,shouldContinue=()=>true,env=process.env,summarize=summarizeNativeFork,force=true,queuedPlan=null,explicit=false,retry=false}={}){
  const meta=store.metadata(session)
  if(!['claude-code','codex'].includes(meta.harness))throw Error('此工具的分支由运行中的宿主准备')
  const plan=queuedPlan||planMainFork(store,session,{force,env}),owner='fork:'+randomUUID()
  if(!plan){if(runId)finishSummaryRun(store,runId,{state:'done',reason:'no-closed-source'});return {session,created:0}}
  if(runId&&!bindSummaryRun(store,runId,{owner,pid:process.pid}))return {session,busy:true}
  if(!store.lease(session,240000,owner)){if(runId)finishSummaryRun(store,runId,{owner,state:'stopped',reason:'busy'});return {session,busy:true}}
  const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
  const valid=()=>shouldContinue()&&!!store.source(session)&&!store.isDeleted(session)&&(explicit||store.integrationEnabled(meta.harness))&&(explicit||store.effectiveSetting(session,env).mode==='main-fork')&&summarySettingsRevision(store,session,env)===plan.revision&&(!runId||summaryRunOwns(store,runId,owner))
  const timer=setInterval(()=>{
    try{if(!valid()||!store.renewLease(session,240000,owner))controller.abort(Error('后台分支摘要已取消'));else if(runId)progressSummaryRun(store,runId,owner)}
    catch{controller.abort(Error('后台分支无法核验任务归属，原文保留'))}
  },10000);timer.unref()
  const assertCurrent=()=>{
    combined.throwIfAborted()
    try{
      if(!valid()||!store.ownsLease(session,owner))throw Error('后台分支配置或任务归属已变化')
      for(const row of plan.originals){store.exact(session,row.ordinal);if(store.db.prepare('SELECT digest FROM events WHERE session=? AND ordinal=?').get(session,row.ordinal)?.digest!==row.digest)throw Error('后台分支原文已变化')}
    }catch(error){controller.abort(error);throw error}
  }
  let completed,calls=0,retryNote=''
  try{
    for(let attempt=1;;attempt++){
      assertCurrent()
      if(runId&&attempt>1)store.db.prepare("UPDATE summary_runs SET error_message=? WHERE id=? AND owner=? AND state='running'").run(`正在进行第 ${attempt} 次后台摘要尝试，原文保留。`,runId,owner)
      try{
        if(!completed){
          calls++
          const result=await summaryAttempt(abort=>summarize(meta.harness,meta.conversation_id,forkDirective(plan.leaves,plan.targetTokens,plan.language.name,{fanout:plan.fanout})+retryNote,{env,signal:abort,timeoutMs:600000,...(store.harnessSetting(meta.harness)?.mode==='main-fork'&&store.harnessSetting(meta.harness)?.model?{model:store.harnessSetting(meta.harness).model}:{})}),combined,600000)
          assertCurrent()
          // Native completion and the transport limit bound generation. The
          // estimate guides writing; planCompaction separately checks whether
          // the archived tree can safely replace the foreground context.
          const tree=parseForkTree(result.text,plan.leaves,plan.language,{fanout:plan.fanout})
          completed={result,tree}
        }
        assertCurrent()
        const ids=saveForkTree(store,session,plan,completed.tree,{...completed.result,owner,validate:valid})
        store.completeSummaryBatch(session,plan.digest,plan.revision);store.setStatus(session,'ok');if(runId){progressSummaryRun(store,runId,owner,{created:ids.length});finishSummaryRun(store,runId,{owner,state:'done'})}
        return {session,created:ids.length,calls,branch:completed.result.branchId}
      }catch(error){
        assertCurrent()
        if(!error.summaryKind&&(error instanceof SyntaxError||/分块|层级|分支摘要/.test(error.message)))error.summaryKind='response_invalid'
        if(!retry||classifySummaryError(error)==='spawn')throw error
        if(['response_invalid','quality'].includes(classifySummaryError(error)))retryNote='\nThe previous response failed summary validation. Return only the required JSON object, with every planned leaf and parent exactly once in index order. Start each summary with a heading in the requested language. Do not call tools or continue the task.'
        const delay=Math.min(300000,30000*2**Math.min(attempt-1,4)),safe=summaryErrorDetail(error)
        if(runId)store.db.prepare("UPDATE summary_runs SET heartbeat_ms=?,error_kind=?,error_message=? WHERE id=? AND owner=? AND state='running'").run(Date.now(),safe.kind,`后台分支摘要第 ${attempt} 次未完成。将在 ${delay/1000} 秒后自动重试，原文已保留。`,runId,owner)
        await waitForRetry(delay,combined)
      }
    }
  }catch(error){if(!combined.aborted&&store.ownsLease(session,owner)){store.failSummaryBatch(session,plan.digest,plan.revision);store.setStatus(session,'summary_failed')}if(runId)finishSummaryRun(store,runId,{owner,state:combined.aborted?'stopped':'failed',error});throw error}
  finally{clearInterval(timer);store.release(session,owner)}
}
