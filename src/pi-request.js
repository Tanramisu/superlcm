import { estimateSummaryTokens } from './summary-tokens.js'

// Count native and Pi image forms as visual input, not base64 text.
export function estimatePiRequest(value) {
  let images = 0
  const text = JSON.stringify(value, (_key, item) => {
    if (['image', 'image_url', 'input_image'].includes(item?.type) || item?.inlineData?.mimeType?.startsWith('image/')) {
      images++; return { type: 'image', mimeType: item.mimeType }
    }
    return item
  })
  return estimateSummaryTokens(text || '') + images * 8192
}

const outputPaths = [['max_tokens'], ['max_completion_tokens'], ['max_output_tokens'], ['maxOutputTokens'], ['maxTokens'], ['generationConfig', 'maxOutputTokens']]
export function piOutputReserve(payload, model) {
  // Extensions may leave more than one provider alias. Budget for the largest
  // one and validate all of them, irrespective of the provider's precedence.
  const values = outputPaths.flatMap(path => {
    const parent = path.length === 1 ? payload : payload?.[path[0]], key = path.at(-1)
    return parent && Object.hasOwn(parent, key) ? [parent[key]] : []
  })
  if (!values.length) values.push(model?.maxTokens ?? Math.floor(Math.min(16384, (model?.contextWindow || 163840) * .1)))
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) throw Error('Pi 模型输出预留无效，原文保留')
  return Math.max(...values)
}

export function piWindowSafety(model,ratio=.8) {
  const remaining=model.contextWindow-Math.floor(model.contextWindow*ratio)
  return Math.min(Math.max(1024,model.contextWindow*.02),Math.max(1,Math.floor(remaining/2)))
}
export function piCompletionBudget(model,ratio,requested=piOutputReserve(null,model)) {
  return Math.min(requested,Math.max(1,model.contextWindow-Math.floor(model.contextWindow*ratio)-piWindowSafety(model,ratio)))
}
// The public Pi hook accepts the replacement wire payload. Leave the model
// configuration intact and change only output fields actually sent upstream.
export function limitPiOutput(payload,model,ceiling) {
  const requested=piOutputReserve(payload,model)
  if(!Number.isFinite(ceiling)||ceiling<1)throw Error('Pi 请求没有足够输出空间，原文保留')
  const cap=Math.min(requested,Math.floor(ceiling))
  if(cap===requested)return payload
  const result=structuredClone(payload)
  let found=false
  for(const path of outputPaths){
    const parent=path.length===1?result:result[path[0]],key=path.at(-1)
    if(parent&&Object.hasOwn(parent,key)){
      if(!Number.isSafeInteger(parent[key])||parent[key]<0)throw Error('Pi 模型输出预留无效，原文保留')
      parent[key]=Math.min(parent[key],cap);found=true
    }
  }
  if(!found){
    if(model.api?.includes('responses')||Array.isArray(result.input))result.max_output_tokens=cap
    else if(model.api?.includes('google')||Array.isArray(result.contents))result.generationConfig={...result.generationConfig,maxOutputTokens:cap}
    else if(model.api?.includes('anthropic')||model.api?.includes('completions'))result.max_tokens=cap
    else throw Error('Pi 供应商未声明可限制的输出字段，原文保留')
  }
  return result
}
