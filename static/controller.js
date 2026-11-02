async function refresh() {
  if (state.samplingSample !== state.sample) {
    $('includeLayoutOnly').checked = true;
    state.samplingSample = state.sample;
  }
  if (!state.sample) {
    state.candidatesDirty = false;
    state.pads = []; state.groups = []; state.images = []; state.plan = [];
    state.structure = []; state.measurements = []; state.plans = [];
    state.currentPlanId = null; state.planDraftDirty = false; state.padMapActiveId = null;
    $('savePlanEdits').disabled = true;
    $('deleteTemplate').disabled = true;
    $('padPlot').innerHTML = ''; $('padTable').innerHTML = '';
    $('padMapLegend').innerHTML = ''; $('padMapInfo').textContent = '点击 Pad 查看区域、版图和行列编号。';
    $('groupSelect').innerHTML = ''; $('groupInfo').innerHTML = '';
    $('samplingRegionChoices').innerHTML = '';
    $('planImage').innerHTML = '<p class="muted" style="padding:20px">请先创建或选择样品。</p>';
    $('planLegend').innerHTML = ''; $('planHistory').innerHTML = '';
    $('imageStage').innerHTML = ''; $('summary').innerHTML = '';
    $('overviewStage').innerHTML = ''; $('regionBoxList').innerHTML = '';
    state.regionBoxes = []; state.detected = []; state.latticeStats = {};
    state.primaryRegionBoxes = []; state.padMapRegion = '';
    await loadScaleBar(null);
    $('measurementTable').innerHTML = '';
    $('sampleStructure').innerHTML = '';
    $('deleteSample').disabled = true;
    return;
  }
  const previous = state.image;
  const previousRegions = new Set($('regions').value.split(',').map(s => s.trim()).filter(Boolean));
  const data = await fetchSampleData(state.sample);
  state.pads = data.pads; state.groups = data.groups; state.images = data.images;
  state.measurements = data.measurements; state.plans = data.plans;
  renderGroups();
  $('measurementTable').innerHTML = table(data.measurements,
    ['pad_id', 'status', 'reviewed', 'pr_uc_cm2', 'ec_mv_cm', 'measured_at']);
  $('templateSelect').innerHTML = data.templates.map(item =>
    `<option>${esc(item.name)}</option>`).join('');
  $('deleteTemplate').disabled = !$('templateSelect').value;
  renderSamplingRegions(previousRegions);
  const hierarchy = await api('/api/structure?sample_id=' + encodeURIComponent(state.sample));
  state.structure = hierarchy;
  $('sampleStructure').innerHTML = hierarchy.map(region => `<div class="region-summary"><strong>${esc(region.region_id)}</strong> · ${region.reviewed_at ? '已核对' : '待核对'} · 版图类型 ${esc(region.layout_type_id)} · ${region.unit_count} 个重复版图 · ${region.pad_count} 个 Pad<div>${region.units.map(unit => `<span class="chip">${esc(unit.layout_unit_id)} (${unit.unit_row ?? '—'}, ${unit.unit_col ?? '—'}) · ${unit.pad_count} Pad</span>`).join('')}</div></div>`).join('') || '<p class="muted">尚未登记区域和重复版图。</p>';
  renderPadTable();
  $('imageSelect').innerHTML = state.images.map(i => `<option value="${i.image_id}">${i.role === 'primary' ? '★ 主图' : '补充'} · ${esc(i.original_name || i.image_id.slice(0, 8))} · ${i.width_px}×${i.height_px}</option>`).join('');
  const selected = state.images.find(i => i.image_id === previous) || primaryImage() || state.images[0];
  if (selected) {
    $('imageSelect').value = selected.image_id; state.image = selected.image_id;
    await loadRegionBoxes(selected);
    await loadScaleBar(selected);
  } else {
    state.image = null;
    $('imageStage').innerHTML = '';
    renderOverview(null);
    await loadScaleBar(null);
  }
  renderPads();
  $('deleteSample').disabled = false;
  renderPlanImage();
  const plans = data.plans;
  $('planHistory').innerHTML = plans.map(p => `<p>方案 #${p.plan_id} · ${esc(p.created_at)} · ${p.mode === 'region' ? '按区域/版图' : '按几何规格'}${p.purpose === 'manual_adjusted' ? ' · 手动调整' : ''} · ${esc(p.regions.join(','))} · ${p.count} 个 · 种子 ${p.seed} · <button type="button" data-plan="${p.plan_id}">在图上查看</button> <a href="/api/task.csv?plan_id=${p.plan_id}">下载 CSV</a> <button type="button" class="plan-delete" data-delete-plan="${p.plan_id}" aria-label="删除方案 #${p.plan_id}">删除</button></p>`).join('') || '<p class="muted">暂无方案</p>';
  $('planHistory').querySelectorAll('button[data-plan]').forEach(button => button.onclick = () => {
    const plan = plans.find(p => p.plan_id === Number(button.dataset.plan));
    if (!plan) return;
    state.plan = state.pads.filter(p => plan.pad_ids.includes(p.pad_id));
    state.currentPlanId = plan.plan_id;
    state.planDraftDirty = false;
    $('samplingMode').value = plan.mode || 'geometry';
    $('geometryFilter').hidden = $('samplingMode').value !== 'geometry';
    $('includeLayoutOnly').checked = !!plan.include_layout_only;
    if (state.groups.some(g => g.id === plan.group_id)) $('groupSelect').value = plan.group_id;
    $('regions').value = plan.regions.join(',');
    renderSamplingRegions(new Set(plan.regions));
    renderPlanResult();
    renderPlanImage(); renderPads();
  });
  $('planHistory').querySelectorAll('button[data-delete-plan]').forEach(button => button.onclick = () => action(async () => {
    const plan = plans.find(item => item.plan_id === Number(button.dataset.deletePlan));
    if (!plan) return;
    const draftNote = state.currentPlanId === plan.plan_id && state.planDraftDirty
      ? '\n当前图上的修改会保留为未保存清单。' : '';
    if (!window.confirm(`删除方案 #${plan.plan_id}（${plan.count} 个 Pad）？\n对应任务 CSV 将无法再从系统下载；Pad 和测试记录不受影响。${draftNote}`)) return;
    await api('/api/delete-plan', {sample_id: state.sample, plan_id: plan.plan_id});
    if (state.currentPlanId === plan.plan_id) {
      if (state.planDraftDirty) {
        state.currentPlanId = null;
        renderPlanResult();
      } else {
        clearPlanSelection();
      }
    }
    await refresh();
    await refreshLibrary();
    toast(`方案 #${plan.plan_id} 已删除`);
  }));
  await summary();
  renderWorkspaceStatus();
}

async function refreshDeletedSamples() {
  const archived = await api('/api/deleted-samples');
  $('deletedSelect').innerHTML = archived.map(s => `<option value="${esc(s.sample_id)}">${esc(s.sample_id)} · ${esc(s.deleted_at)}</option>`).join('');
  $('restoreSample').disabled = archived.length === 0;
  $('deleteSample').disabled = !state.sample;
}

$('createSample').onclick = () => action(async () => {
  if (state.candidatesDirty && !window.confirm('当前识别候选尚未保存为 Pad。创建并切换到新样品会丢失本页候选，仍要继续吗？')) return;
  const sampleId = $('newSample').value.trim();
  await api('/api/samples', {sample_id: sampleId, recipe_id: $('recipe').value,
    notes: $('notes').value});
  await loadSamples();
  await selectSample(sampleId, false);
  await refreshLibrary();
  navigateView('samples');
  toast('样品已创建');
});

$('importPads').onclick = () => action(async () => {
  const file = await filePayload('padFile');
  const result = await api('/api/import-pads', {...file, sample_id: state.sample});
  await refresh();
  toast(`导入 ${result.imported} 个 Pad`);
});

$('saveTemplate').onclick = () => action(async () => {
  const result = await api('/api/templates', {sample_id: state.sample,
    name: $('templateName').value.trim()});
  await refresh();
  toast(`模板已保存：${result.saved} 个 Pad`);
});

$('applyTemplate').onclick = () => action(async () => {
  const result = await api('/api/apply-template', {sample_id: state.sample,
    name: $('templateSelect').value});
  await refresh();
  toast(`模板已应用：${result.imported} 个 Pad`);
});

$('importMeasurements').onclick = () => action(async () => {
  const file = await filePayload('measureFile');
  const result = await api('/api/import-measurements', {...file, sample_id: state.sample});
  await refresh();
  toast(`导入 ${result.imported} 条测试记录`);
});

$('refreshSummary').onclick = () => action(summary);

$('deleteSample').onclick = () => action(async () => {
  const id = state.sample;
  if (!id) throw Error('请先选择样品');
  const counts = await api('/api/sample-counts?sample_id=' + encodeURIComponent(id));
  const message = `删除样品「${id}」？\n关联内容：${counts.pads} 个 Pad、${counts.measurements} 条测试记录、${counts.plans} 份选点方案、${counts.images} 张图片。\n删除后可在“已删除样品”中恢复。${state.candidatesDirty ? '\n当前未入库的识别候选会丢失。' : ''}`;
  if (!window.confirm(message)) return;
  await api('/api/delete-sample', {sample_id: id});
  state.sample = ''; state.image = null; state.regionBoxes = []; state.plan = [];
  await loadSamples();
  navigateView('library');
  toast(`样品 ${id} 已删除，可在样品列表恢复`);
});

$('restoreSample').onclick = () => action(async () => {
  const id = $('deletedSelect').value;
  if (!id) throw Error('没有可恢复的样品');
  if (state.candidatesDirty && !window.confirm('当前识别候选尚未保存为 Pad。恢复并切换样品会丢失本页候选，仍要继续吗？')) return;
  await api('/api/restore-sample', {sample_id: id});
  await loadSamples();
  await selectSample(id, false);
  navigateView('samples');
  toast(`样品 ${id} 已恢复`);
});

$('deleteTemplate').onclick = () => action(async () => {
  const name = $('templateSelect').value;
  if (!name) throw Error('请先选择版图模板');
  if (!window.confirm(`删除版图模板「${name}」？\n已应用到样品的 Pad 不受影响。`)) return;
  await api('/api/delete-template', {name});
  await refresh();
  toast(`版图模板「${name}」已删除`);
});

$('groupSelect').onchange = () => {
  renderGroups(); clearPlanSelection(); renderPlanImage(); renderPads();
};
$('samplingMode').onchange = updateSamplingMode;
$('includeLayoutOnly').onchange = () => {
  if (!$('includeLayoutOnly').checked && state.plan.some(p => p.area_confidence === 'layout_only')) {
    state.plan = state.plan.filter(p => p.area_confidence !== 'layout_only');
    state.planDraftDirty = true; renderPlanResult();
  }
  renderPlanImage(); renderPads();
};
$('makePlan').onclick = () => action(async () => {
  const regions = selectedSamplingRegions();
  if (!regions.length) throw Error('请至少选择一个区域');
  const mode = $('samplingMode').value;
  const body = {sample_id: state.sample, mode, regions, count: Number($('sampleCount').value),
    seed: Number($('seed').value), include_layout_only: $('includeLayoutOnly').checked};
  if (mode === 'geometry') body.group_id = $('groupSelect').value;
  const result = await api('/api/plans', body);
  state.plan = result.pads;
  state.currentPlanId = result.plan_id; state.planDraftDirty = false;
  renderPlanResult();
  await refresh();
  toast('抽样方案已保存');
});
$('savePlanEdits').onclick = () => action(async () => {
  if (!state.planDraftDirty || !state.plan.length) throw Error('请先在图中选择 Pad');
  const mode = $('samplingMode').value;
  const body = {sample_id: state.sample, mode, regions: selectedSamplingRegions(),
    count: state.plan.length, seed: Number($('seed').value),
    include_layout_only: $('includeLayoutOnly').checked, pad_ids: state.plan.map(p => p.pad_id)};
  if (mode === 'geometry') body.group_id = $('groupSelect').value;
  const result = await api('/api/plans', body);
  state.plan = result.pads; state.currentPlanId = result.plan_id; state.planDraftDirty = false;
  renderPlanResult(); await refresh();
  toast(`手动调整已另存为方案 #${result.plan_id}`);
});
$('planZoom').oninput = renderPlanImage;
$('planReset').onclick = () => {
  $('planZoom').value = 1;
  renderPlanImage();
  $('planImage').scrollLeft = 0; $('planImage').scrollTop = 0;
};
$('planShowTested').onchange = renderPlanImage;
$('planShowExcluded').onchange = renderPlanImage;

async function selectSample(sampleId, warn = true) {
  if (sampleId === state.sample) return true;
  if (sampleId && !state.availableSamples.includes(sampleId)) {
    toast('样品不存在或已删除', true);
    $('sampleSelect').value = state.sample;
    return false;
  }
  if (warn && state.candidatesDirty && !window.confirm('当前识别候选尚未保存为 Pad。切换样品会丢失本页候选，仍要切换吗？')) {
    $('sampleSelect').value = state.sample;
    return false;
  }
  state.sample = sampleId;
  $('sampleSelect').value = sampleId;
  state.candidatesDirty = false;
  state.primaryRegionBoxes = []; state.padMapRegion = '';
  state.padMapActiveId = null;
  $('padMapZoom').value = 1;
  $('padMapInfo').textContent = '点击 Pad 查看区域、版图和行列编号。';
  state.image = null; state.regionBoxes = []; state.candidateEdits = []; state.latticeStats = {}; state.detected = []; state.candidate = null;
  state.addPointMode = false; $('clickAddCandidate').textContent = '点击放大图补点';
  $('clickAddCandidateHere').textContent = '点图补点';
  clearPlanSelection(); $('regions').value = '';
  await refresh();
  return true;
}
$('sampleSelect').onchange = () => action(async () => {
  const inLibrary = $('library').classList.contains('active');
  if (!await selectSample($('sampleSelect').value)) return;
  navigateView(inLibrary ? 'library' : 'samples');
  if (inLibrary && state.sample)
    requestAnimationFrame(() => $('libraryPadMap').scrollIntoView({behavior: 'smooth', block: 'start'}));
});
$('imageSelect').onchange = () => action(async () => {
  if (state.candidatesDirty && !window.confirm('当前识别候选尚未保存为 Pad。切换图像会丢失本页候选，仍要切换吗？')) {
    $('imageSelect').value = state.image;
    return;
  }
  state.candidatesDirty = false;
  state.image = $('imageSelect').value;
  state.regionBoxes = []; state.candidateEdits = []; state.latticeStats = {}; state.detected = []; state.candidate = null;
  state.addPointMode = false; $('clickAddCandidate').textContent = '点击放大图补点';
  $('clickAddCandidateHere').textContent = '点图补点';
  await loadRegionBoxes(selectedImage());
  await loadScaleBar(selectedImage());
});
$('imageZoom').oninput = renderImage;
$('drawScaleLine').onclick = () => action(async () => {
  const item = selectedImage();
  if (!item || item.role !== 'primary') throw Error('请先选择整片主图');
  if (!(Number($('scaleLengthUm').value) > 0)) throw Error('请先填写标尺实际长度（µm）');
  state.scaleDrawMode = !state.scaleDrawMode;
  $('drawScaleLine').textContent = state.scaleDrawMode ? '取消拉线标定' : '在主图上拉线标定';
  if (state.scaleDrawMode) {
    const box = state.scaleBar?.bar_box;
    const x = box ? (box[0] + box[2]) / 2 : item.width_px * .12;
    const y = box ? (box[1] + box[3]) / 2 : item.height_px * .94;
    state.focusBox = [x - 10, y - 10, x + 10, y + 10];
    $('imageZoom').value = Math.max(4, Number($('imageZoom').value));
    $('scaleBarInfo').textContent = '在放大图上沿标尺从一端拖到另一端；滚轮放大，中键拖动画面。';
  }
  renderImage();
});
$('scaleLengthUm').onchange = () => action(async () => applyManualScaleLine());
$('showReviewCandidates').onchange = renderImage;
$('showOmCandidates').onchange = renderImage;
$('showOmOutlines').onchange = renderImage;
$('showSavedPads').onchange = renderImage;
document.querySelector('nav button[data-tab="om"]').addEventListener('click', () => requestAnimationFrame(renderImage));
$('selectRoi').onclick = () => {
  if (selectedImage()?.role !== 'primary') { toast('请切换到整片主图添加区域框', true); return; }
  if (!($('newRegionId').value || '').trim()) { toast('请填写区域 ID', true); return; }
  state.roiMode = !state.roiMode;
  $('selectRoi').textContent = state.roiMode ? '在整图缩略图上拖动…' : '添加区域框（画完自动保存）';
  renderOverview(selectedImage());
};
function setRotationDegrees(value) {
  const angle = Math.max(-180, Math.min(180, Number(value) || 0));
  $('rotationDegrees').value = angle;
  $('rotationAngle').value = angle;
  updateRotationPreview(selectedImage(), $('overviewStage').querySelector('.overview-canvas img'));
}
$('rotationAngle').oninput = () => setRotationDegrees($('rotationAngle').value);
$('rotationDegrees').onchange = () => setRotationDegrees($('rotationDegrees').value);
$('rotateLeft').onclick = () => setRotationDegrees(Number($('rotationDegrees').value) - 90);
$('rotateRight').onclick = () => setRotationDegrees(Number($('rotationDegrees').value) + 90);
$('cancelRotation').onclick = () => setRotationDegrees(0);
$('setPrimary').onclick = () => action(async () => {
  const item = selectedImage();
  if (!item) throw Error('请先选择图片');
  if (item.role === 'primary') { toast('当前图片已经是整片主图'); return; }
  if (state.candidatesDirty && !window.confirm('当前识别候选尚未保存为 Pad。更换主图会清空本页候选，仍要继续吗？')) return;
  await api('/api/set-primary', {sample_id: state.sample, image_id: item.image_id});
  state.candidatesDirty = false; state.detected = []; state.candidate = null; state.latticeStats = {};
  await refresh(); toast('整片主图已更新');
});
