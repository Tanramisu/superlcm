// A dedicated destination, with independent controls and deep links per tool.
function compressionSection(tool,updateHash=true) {
  tool=['dsh','pi'].includes(tool)?tool:'claude-code';state.compressionTool=tool
  for(const button of document.querySelectorAll('[data-compression-tool]')) {
    const selected=button.dataset.compressionTool===tool
    button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1
  }
  for(const panel of document.querySelectorAll('[data-compression]'))panel.hidden=panel.dataset.compression!==tool
  if(updateHash)history.replaceState(null,'','#compression/'+tool)
  if(tool==='dsh') {
    if(!dshControls.value&&!dshControls.loading)act(loadDshControls)
    else renderDshControls()
  }
  if(tool==='pi') {
    if(!piControls.value&&!piControls.loading)act(loadPiControls)
    else renderPiControls()
  }
}
for(const button of document.querySelectorAll('[data-compression-tool]')) {
  button.onclick=()=>compressionSection(button.dataset.compressionTool)
  button.onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault()
    const tools=Array.from(document.querySelectorAll('[data-compression-tool]'),b=>b.dataset.compressionTool)
    const index=tools.indexOf(state.compressionTool),offset=event.key==='ArrowLeft'?-1:1
    const tool=event.key==='Home'?tools[0]:event.key==='End'?tools.at(-1):tools[(index+offset+tools.length)%tools.length]
    compressionSection(tool);document.querySelector('[data-compression-tool="'+tool+'"]').focus()
  }
}
function renderCompressionOwner(id,enabled,pending=false) {
  const badge=$(id);if(!badge)return
  badge.hidden=!enabled&&!pending
  badge.className='state '+(pending?'warn':enabled?'warn':'on')
  badge.textContent=t(pending?'等待应用':enabled?'SuperLcm 接管':id==='#claudeCompressionOwner'?'Claude 原生压缩':'DSH 原生压缩')
}
