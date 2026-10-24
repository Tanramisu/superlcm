import { dirname, join } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { findCli } from './runtime.js'
import { forkHash, forkAnchors, forkDirective, parseForkTree } from './fork-summary.js'
import {summaryToolPairing} from './summary-source.js'
import { estimateSummaryTokens } from './summary-tokens.js'
import { serializePiMessages } from './pi-snapshot.js'
let converter
async function convert(messages) {
  if (!converter) {
    let root = dirname(realpathSync(findCli('pi')))
    while (!existsSync(join(root, 'package.json'))) { const parent = dirname(root); if (parent === root) throw Error('未找到 Pi 公共接口'); root = parent }
    converter = (await import(pathToFileURL(join(root, 'dist/index.js')))).convertToLlm
  }
  return converter(messages)
}
export async function piForkPlan(snapshot, capture) {
  const selected = await convert(snapshot.sourceMessages)
  const visible = capture.messages
  // Every selected message must be the exact beginning of the captured main
  // transcript after system messages. Changed context extensions are blocked.
  const indices = visible.flatMap((message, index) => message.role === 'system' ? [] : [index])
  if (selected.length > indices.length || selected.some((message, i) => serializePiMessages([message]) !== serializePiMessages([visible[indices[i]]]))) throw Error('Pi 原始请求与归档选区不同，无法原样分支')
  const mapped=[]
  if(snapshot.sourceEntryIds){
    const individual=[]
    for(let i=0;i<snapshot.sourceMessages.length;i++){
      const part=await convert([snapshot.sourceMessages[i]])
      individual.push(...part);mapped.push(...part.map(()=>snapshot.sourceEntryIds[i]))
    }
    if(serializePiMessages(individual)!==serializePiMessages(selected))throw Error('Pi 消息映射不兼容，原文保留')
  }
  const plan = []; let first = 0, tokens = 0;const pending=new Set()
  for (let i = 0; i < selected.length; i++) {
    tokens += estimateSummaryTokens(serializePiMessages([selected[i]]))
    const pairing=summaryToolPairing(JSON.stringify({type:'message',message:selected[i]}))
    if(pairing.endsTurn)pending.clear()
    for(const id of pairing.opened)pending.add(id);for(const id of pairing.closed)pending.delete(id)
    if(pending.size)continue
    if (tokens < (snapshot.summaryTuning?.targetTokens||20000) && i < selected.length - 1) continue
    plan.push({ index: plan.length, firstMessage: indices[first], lastMessage: indices[i], ...forkAnchors(selected.slice(first,i+1)),...(mapped.length?{entryIds:[...new Set(mapped.slice(first,i+1))]}:{}) }); first = i + 1; tokens = 0
  }
  if(first!==selected.length)throw Error('Pi 选区存在未闭合工具组，保留原文')
  return plan
}
export async function summarizePiFork(ctx, snapshot, capture, { signal, stage } = {}) {
  if (!capture?.payload || capture.model.provider !== ctx.model?.provider || capture.model.id !== ctx.model?.id) throw Error('Pi 尚未捕获当前模型的原始请求')
  const plan = await piForkPlan(snapshot, capture)
  await stage() // Exact originals must be durably archived before model work.
  signal?.throwIfAborted()
  const target = Math.min(20000, Math.max(2048, snapshot.tokensBefore * .15))
  const nativeReserve=capture.payload.max_tokens??capture.payload.max_completion_tokens??capture.payload.max_output_tokens??capture.model.maxTokens??16384
  const treeOptions={fanout:snapshot.summaryTuning?.fanout||4,targetTokens:Math.max(256,Math.min(target,12000,Math.floor(nativeReserve*.65)))}
  const directive = forkDirective(plan, treeOptions.targetTokens,undefined,treeOptions)
  let images = 0
  const encoded = JSON.stringify(capture.messages, (_key,value) => { if(value?.type === 'image'){images++;return {type:'image'}};return value })
  const limit = capture.model.contextWindow - nativeReserve - Math.max(1024,capture.model.contextWindow*.02)
  if (Number.isFinite(limit) && Math.max(snapshot.tokensBefore,estimateSummaryTokens(encoded)+images*8192) + estimateSummaryTokens(directive) >= limit) throw Error('Pi 后台分支没有足够输入空间，原文保留')
  const field = Array.isArray(capture.payload.messages) ? 'messages' : Array.isArray(capture.payload.input) ? 'input' : null
  if (!field) throw Error('当前 Pi 供应商没有可原样分支的请求数组')
  let sent = false
  const result = await ctx.modelRegistry.streamSimple(capture.model, { messages: [...capture.messages, { role: 'user', content: directive, timestamp: Date.now() }] }, {
    sessionId: snapshot.session_id, reasoning: capture.reasoning, signal: AbortSignal.any([signal, AbortSignal.timeout(180000)].filter(Boolean)),
    onPayload(payload) {
      if (!Array.isArray(payload[field]) || payload[field].at(-1)?.role !== 'user') throw Error('Pi 后台摘要请求格式不兼容')
      sent = true
      // Replay all native settings, tools, cache controls and original wire
      // messages. Only append the provider-converted final user instruction.
      return { ...structuredClone(capture.payload), [field]: [...structuredClone(capture.payload[field]), payload[field].at(-1)] }
    }
  }).result()
  signal?.throwIfAborted()
  if (!sent || result.stopReason !== 'stop' || result.content.some(block => block.type === 'toolCall')) throw Error('Pi 后台分支未完整结束，原文保留')
  const tree = parseForkTree(result.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), plan,undefined,treeOptions)
  const blocks=tree.filter(n=>n.level===0)
  return { blocks, tree, treeOptions, model: capture.model.id, provider: capture.model.provider, usage: result.usage,
    sourceDigest: forkHash(snapshot.source), prefixHash: forkHash(capture.payload[field]), requestSettingsHash: forkHash(Object.fromEntries(Object.entries(capture.payload).filter(([key]) => key !== field))) }
}
