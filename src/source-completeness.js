// A textual projection may only certify blocks it actually represents.
// Unknown content blocks fail closed; private reasoning is deliberately omitted.
const opaque=new Set(['image','image_url','input_image','file','input_file','document','audio','input_audio','video'])
const text=new Set(['text','input_text','output_text'])
const calls=new Set(['tool_use','toolCall','tool-call','function_call','custom_tool_call'])
const privateReasoning=new Set(['thinking','redacted_thinking'])
function contentIncomplete(value){
  if(value==null)return false
  if(typeof value==='string'){
    if(!value.startsWith('\0json:'))return false
    try{return contentIncomplete(JSON.parse(value.slice(6)))}catch{return true}
  }
  if(Array.isArray(value))return value.some(blockIncomplete)
  if(typeof value!=='object')return true
  // Even a serialized wrapper may contain an image or an unknown typed block.
  return value.type?blockIncomplete(value):nestedContentIncomplete(value)
}
function nestedContentIncomplete(value){
  if(!value||typeof value!=='object')return false
  if(Array.isArray(value))return value.some(nestedContentIncomplete)
  if(value.type)return blockIncomplete(value)
  return Object.values(value).some(nestedContentIncomplete)
}
function blockIncomplete(block){
  if(!block||typeof block!=='object'||Array.isArray(block))return true
  if(opaque.has(block.type))return true
  if(text.has(block.type))return typeof block.text!=='string'
  if(calls.has(block.type))return false // input/arguments are serialized in full
  if(block.type==='tool_result')return contentIncomplete(block.content)
  if(privateReasoning.has(block.type))return false
  return true
}
function visit(value){
  if(!value||typeof value!=='object')return false
  if(Array.isArray(value))return value.some(visit)
  if(opaque.has(value.type))return true
  if(calls.has(value.type))return false
  return Object.entries(value).some(([key,child])=>key==='content'?contentIncomplete(child):visit(child))
}
export function hasUnrepresentedContent(raw,kind='jsonl'){
  if(kind==='text')return false
  let value;try{value=JSON.parse(raw)}catch{return true}
  return !value||typeof value!=='object'||Array.isArray(value)||visit(value)
}
