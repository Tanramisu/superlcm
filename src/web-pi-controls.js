const piControls = { value: null, draft: null, busy: false, loading: false, error: '' }
function renderPiControls() {
  const root = $('#piCompressionSettings'), value = piControls.value, draft = piControls.draft
  if (!value) {
    root.innerHTML = '<p role="status">' + esc(piControls.error || t('正在读取压缩设置…')) + '</p><button type="button" class="btn" id="piControlsRead">' + t('重新读取') + '</button>'
    root.querySelector('button').onclick = () => act(loadPiControls); return
  }
  const disabled = piControls.busy ? ' disabled' : ''
  const percent = Math.round(draft.ratio * 100), prepare = Math.max(10, percent - 10)
  root.innerHTML = '<label class="toggle-row"><span><b>' + t('由 SuperLcm 接管压缩') + '</b><span>' + t('关闭后使用 Pi 原生压缩，原文档案继续保留。') + '</span></span><span class="switch"><input type="checkbox" id="piControlsOn" role="switch"' + (draft.enabled ? ' checked' : '') + disabled + '><i></i></span></label>' +
    '<p class="desc">' + t('摘要方式与模型在上方 Pi 卡片设置。') + '</p>' +
    '<h3>' + t('压缩比例') + '</h3><div class="choice" role="radiogroup" aria-label="' + t('压缩比例') + '">' + [70,80,90].map(n => '<button type="button" role="radio" data-pi-ratio="' + n + '" aria-checked="' + (percent === n) + '"' + disabled + '>' + n + '%' + (n === 80 ? '<small>' + t('推荐') + '</small>' : '') + '</button>').join('') + '</div>' +
    '<label class="field">' + t('自定义压缩比例（%）') + '<input type="number" id="piControlsRatio" min="50" max="95" step="1" value="' + esc(percent) + '"' + disabled + '></label>' +
    '<p class="notice calm" id="piPreparationHint">' + esc(t('约 {prepare}% 时在后台准备，{replace}% 时直接替换已完成摘要。', { prepare, replace: percent })) + '</p>' +
    '<p class="desc">' + t('摘要未就绪且空间不足时，暂停下一次模型请求。失败或输出过大时保留原文并提示处理。') + '</p>' +
    '<p role="status" class="notice calm">' + t(value.enabled ? '接管策略已开启。已加载新版扩展的 Pi 在下一次检查时读取设置。' : '接管策略已关闭，使用 Pi 原生压缩。') + '</p>' +
    '<div class="actions"><button type="button" class="btn primary" id="piControlsSave"' + disabled + '>' + t('保存压缩设置') + '</button><button type="button" class="btn" id="piControlsRead"' + disabled + '>' + t('重新读取') + '</button><span class="saved" id="piControlsDirty"></span></div>' + (piControls.error ? '<p role="alert">' + esc(piControls.error) + '</p>' : '')
  const badge = $('#piCompressionOwner'); badge.hidden = !value.enabled; badge.textContent = t('接管策略已开启')
  const dirty = () => { $('#piControlsDirty').textContent = t('有未保存的修改') }
  root.querySelector('#piControlsOn').onchange = event => { draft.enabled = event.target.checked; dirty() }
  root.querySelector('#piControlsRatio').oninput = event => {
    draft.ratio = event.target.value.trim() ? Number(event.target.value) / 100 : NaN
    const n = Math.round(draft.ratio * 100)
    $('#piPreparationHint').textContent = Number.isInteger(n) && n >= 50 && n <= 95 ? t('约 {prepare}% 时在后台准备，{replace}% 时直接替换已完成摘要。', { prepare: n - 10, replace: n }) : t('Pi 压缩比例必须在50%到95%之间')
    for (const button of root.querySelectorAll('[data-pi-ratio]')) button.setAttribute('aria-checked', String(Number(button.dataset.piRatio) === n))
    dirty()
  }
  for (const button of root.querySelectorAll('[data-pi-ratio]')) button.onclick = () => { draft.ratio = Number(button.dataset.piRatio) / 100; renderPiControls(); dirty() }
  root.querySelector('#piControlsSave').onclick = () => act(savePiControls)
  root.querySelector('#piControlsRead').onclick = () => act(loadPiControls)
}
async function loadPiControls() {
  if (piControls.loading || piControls.busy) return
  piControls.loading = true
  try { piControls.value = await api('/api/pi-compression'); piControls.draft = { ...piControls.value }; piControls.error = '' }
  catch (error) { piControls.value = null; piControls.error = error.message }
  finally { piControls.loading = false; renderPiControls() }
}
async function savePiControls() {
  if (piControls.busy) return
  const draft = piControls.draft, percent = draft.ratio * 100
  if (!Number.isFinite(percent) || Math.abs(percent - Math.round(percent)) > 1e-8 || percent < 50 || percent > 95) { piControls.error = t('Pi 压缩比例必须在50%到95%之间'); renderPiControls(); return }
  piControls.busy = true; piControls.error = ''; renderPiControls()
  try {
    piControls.value = await api('/api/pi-compression', { revision: draft.revision, enabled: draft.enabled, ratio: draft.ratio })
    piControls.draft = { ...piControls.value }; await loadHarnesses(); await loadSettings(); toast(t('压缩设置已保存'))
  } catch (error) { piControls.error = error.message }
  finally { piControls.busy = false; renderPiControls() }
}
