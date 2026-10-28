export function hasUnrepresentedContent(raw){
  let value;try{value=JSON.parse(raw)}catch{return false}
  const visit=v=>v&&typeof v==='object'&&(['image','image_url','input_image','file','document','audio','input_audio'].includes(v.type)||Object.values(v).some(x=>Array.isArray(x)?x.some(visit):visit(x)))
  return Boolean(visit(value))
}
