function showUploadStatus(message, stateName = '', percent = null) {
  const status = $('uploadStatus'), progress = $('uploadProgress');
  status.hidden = false;
  status.className = `upload-status ${stateName}`.trim();
  $('uploadMessage').textContent = message;
  if (percent === null) progress.removeAttribute('value');
  else progress.value = percent;
}

function uploadImageFile(file, sampleId) {
  return new Promise((resolve, reject) => {
    const encodedLength = 4 * Math.ceil(file.size / 3);
    if (encodedLength + 2048 > 30_000_000) {
      reject(Error('图片文件过大：当前单次上传上限约 22.5 MB。'));
      return;
    }
    const reader = new FileReader();
    reader.onprogress = event => {
      if (event.lengthComputable) showUploadStatus(`读取图片… ${Math.round(event.loaded / event.total * 100)}%`, '', Math.round(event.loaded / event.total * 20));
    };
    reader.onerror = () => reject(Error('读取图片失败，请重新选择文件'));
    reader.onload = () => {
      const request = new XMLHttpRequest();
      request.open('POST', '/api/image');
      request.setRequestHeader('Content-Type', 'application/json');
      request.timeout = 180000;
      request.upload.onprogress = event => {
        if (event.lengthComputable) showUploadStatus(`上传中… ${Math.round(event.loaded / event.total * 100)}%`, '', 20 + Math.round(event.loaded / event.total * 75));
      };
      request.upload.onload = () => showUploadStatus('上传完成，正在校验并保存图片…');
      request.onerror = () => reject(Error('连接服务器失败，请检查服务是否仍在运行'));
      request.ontimeout = () => reject(Error('上传超时，请检查网络和图片大小'));
      request.onload = () => {
        let response;
        try { response = JSON.parse(request.responseText); }
        catch { reject(Error(`服务器返回了无法识别的响应（HTTP ${request.status}）`)); return; }
        if (request.status < 200 || request.status >= 300) {
          reject(Error(response.error || `上传失败（HTTP ${request.status}）`)); return;
        }
        resolve(response);
      };
      request.send(JSON.stringify({sample_id: sampleId, filename: file.name, data: reader.result.split(',')[1]}));
    };
    showUploadStatus('正在读取图片…', '', 0);
    reader.readAsDataURL(file);
  });
}

$('uploadImage').onclick = async () => {
  const file = $('imageFile').files[0];
  if (!file) { showUploadStatus('上传失败：请先选择 PNG 或 JPEG 图片', 'error', 0); return; }
  if (!state.sample) { showUploadStatus('上传失败：请先选择样品', 'error', 0); return; }
  if (!/\.(png|jpe?g)$/i.test(file.name)) {
    showUploadStatus('上传失败：仅支持 PNG/JPEG 图片', 'error', 0); return;
  }
  if (state.candidatesDirty && !window.confirm('当前识别候选尚未保存为 Pad。上传并切换图像会清空本页候选，仍要继续吗？')) return;
  const sampleId = state.sample;
  $('uploadImage').disabled = true;
  $('imageFile').disabled = true;
  $('sampleSelect').disabled = true;
  let saved = false;
  try {
    const result = await uploadImageFile(file, sampleId);
    saved = true;
    showUploadStatus(`上传成功：${file.name}（${result.width_px}×${result.height_px}），${result.role === 'primary' ? '已设为整片主图' : '已保存为补充图'}`, 'success', 100);
    state.candidatesDirty = false; state.detected = []; state.candidate = null; state.latticeStats = {};
    await refresh();
    if (state.sample === sampleId) {
      $('imageSelect').value = result.image_id;
      state.image = result.image_id;
      await loadRegionBoxes(selectedImage());
      await loadScaleBar(selectedImage());
    }
  } catch (error) {
    showUploadStatus(saved ? `图片已保存，但页面更新失败：${error.message}。请刷新页面。` : `上传失败：${error.message}`, 'error', saved ? 100 : 0);
  } finally {
    $('uploadImage').disabled = false;
    $('imageFile').disabled = false;
    $('sampleSelect').disabled = false;
  }
};

$('applyRotation').onclick = async () => {
  const item = selectedImage();
  const angle = Number($('rotationDegrees').value);
  if (!item || item.role !== 'primary' || !angle) return;
  const oldBoxes = state.regionBoxes.length;
  const oldPads = state.pads.filter(pad => pad.image_id === item.image_id).length;
  if ((oldBoxes || oldPads) && !window.confirm(`原主图已有 ${oldBoxes} 个区域框、${oldPads} 个关联 Pad。旋转会生成新主图，旧坐标不会自动迁移；原图仍保留，可切回。确定继续吗？`)) return;
  if (state.candidatesDirty && !window.confirm('当前识别候选尚未保存，切换到校正主图后需重新识别。确定继续吗？')) return;
  state.rotationApplying = true;
  $('sampleSelect').disabled = true; $('imageSelect').disabled = true;
  updateRotationPreview(item, $('overviewStage').querySelector('.overview-canvas img'));
  $('rotationStatus').textContent = '正在生成校正后的主图，请稍候…';
  let saved = false;
  try {
    const result = await api('/api/rotate-image', {sample_id: state.sample, image_id: item.image_id, angle_deg: angle});
    saved = true;
    state.candidatesDirty = false; state.detected = []; state.candidate = null; state.latticeStats = {};
    state.roiMode = false;
    await refresh();
    $('imageSelect').value = result.image_id;
    state.image = result.image_id;
    await loadRegionBoxes(selectedImage());
    await loadScaleBar(selectedImage());
    $('rotationStatus').textContent = `已生成校正主图：${result.width_px} × ${result.height_px} px。请在新主图上重新画区域框。`;
    toast('校正主图已保存；原图仍在图片列表中');
  } catch (error) {
    $('rotationStatus').textContent = saved ? `新主图已保存，但页面更新失败：${error.message}。请刷新页面。` : `旋转失败：${error.message}`;
    toast(error.message, true);
  } finally {
    const message = $('rotationStatus').textContent;
    state.rotationApplying = false;
    $('sampleSelect').disabled = false; $('imageSelect').disabled = false;
    updateRotationPreview(selectedImage(), $('overviewStage').querySelector('.overview-canvas img'));
    $('rotationStatus').textContent = message;
  }
};

async function detectBoxes(boxes) {
  if ($('detect').disabled) return;
  const item = selectedImage();
  if (!item) { toast('请先选择图片', true); return; }
  if (!boxes.length && item.role === 'primary') { toast('请先添加至少一个区域框', true); return; }
  const targets = boxes.length ? boxes : [{region_id: '', x1: 0, y1: 0, x2: item.width_px, y2: item.height_px}];
  $('detect').disabled = true;
  state.detecting = true;
  $('sampleSelect').disabled = true;
  $('imageSelect').disabled = true;
  $('selectRoi').disabled = true;
  $('detectProgress').hidden = false;
  const progress = $('detectProgress').querySelector('progress');
  progress.max = targets.length; progress.value = 0;
  const errors = [];
  let completed = 0;
  try {
    for (const box of targets) {
      $('detectProgress').querySelector('span:nth-child(2)').textContent = `识别 ${box.region_id || '当前图片'}（${completed + 1}/${targets.length}）…`;
      $('detectNote').textContent = `正在识别 ${box.region_id || '当前图片'}（${completed + 1}/${targets.length}）…`;
      await new Promise(requestAnimationFrame);
      try {
        const r = await api('/api/detect', {image_id: item.image_id,
          bbox: [box.x1, box.y1, box.x2, box.y2], polarity: $('polarity').value,
          min_size: Number($('minCandidate').value), max_size: Number($('maxCandidate').value),
          region_id: box.region_id});
        state.detected = state.detected.filter(p => p.region_id !== box.region_id);
        state.detected.push(...r.candidates.map(p => ({...p, region_id: box.region_id})));
        state.latticeStats[box.region_id] = r.lattice || {applied: false, inferred: 0, blocks: 0};
        if (box.region_id) markRegionUnreviewed(box.region_id);
      } catch (error) {
        errors.push(`${box.region_id || '当前图片'}：${error.message}`);
      }
      completed++;
      progress.value = completed;
    }
    state.candidate = null;
    const complete = targets.filter(box => state.latticeStats[box.region_id]?.applied);
    const rawOnly = targets.filter(box => state.latticeStats[box.region_id] && !state.latticeStats[box.region_id].applied);
    const layoutOnly = state.detected.filter(p => p.confidence === 'layout_only').length;
    const summary = complete.length
      ? `${complete.length}/${targets.length} 个区域完成规则格点；${layoutOnly} 个灰色位置仅由布局推断。${rawOnly.length ? `${rawOnly.map(box => box.region_id).join('、')} 未拟合规则格点，仅显示原始候选。` : ''}`
      : `找到 ${state.detected.length} 个原始候选；尚未拟合出可补齐的规则格点。`;
    $('detectNote').textContent = `${completed - errors.length}/${completed} 个区域识别完成；${summary}${errors.length ? '失败：' + errors.join('；') : '点击格点可查看版图、行列与大致尺寸。'}`;
    focusRegionBox([targets[0].x1, targets[0].y1, targets[0].x2, targets[0].y2]);
    if (completed > errors.length) {
      state.candidatesDirty = true;
      navigateView('review');
    }
    if (errors.length) toast(errors.join('；'), true);
  } finally {
    state.detecting = false;
    $('detect').disabled = false;
    $('sampleSelect').disabled = false;
    $('imageSelect').disabled = false;
    $('selectRoi').disabled = false;
    $('detectProgress').hidden = true;
    updateRotationPreview(selectedImage(), $('overviewStage').querySelector('.overview-canvas img'));
  }
}
$('detect').onclick = () => detectBoxes(state.regionBoxes);
async function addCandidateAt(x, y) {
  const item = selectedImage();
  if (!item || item.role !== 'primary') throw Error('请切换整片主图补点');
  if (![x, y].every(Number.isFinite) || x < 0 || x >= item.width_px || y < 0 || y >= item.height_px)
    throw Error('补点中心须在图片内');
  const matched = state.regionBoxes.filter(b => b.x1 <= x && x < b.x2 && b.y1 <= y && y < b.y2);
  if (matched.length !== 1) throw Error('补点中心须落在且只落在一个区域框内');
  const region_id = matched[0].region_id;
  const sizes = state.detected.filter(p => p.region_id === region_id).map(p =>
    [p.width_px, p.height_px]).filter(pair => pair.every(Number.isFinite));
  sizes.sort((a, b) => a[0] * a[1] - b[0] * b[1]);
  const typical = sizes[Math.floor(sizes.length / 2)];
  const width_px = $('manualWidth').value.trim() ? Number($('manualWidth').value) : typical?.[0];
  const height_px = $('manualHeight').value.trim() ? Number($('manualHeight').value) : typical?.[1];
  if (!Number.isFinite(width_px) || !Number.isFinite(height_px) || width_px <= 0 || height_px <= 0)
    throw Error('请先识别该区域，或填写补点宽高');
  if (state.detected.some(p => p.region_id === region_id &&
      Math.hypot(p.x - x, p.y - y) < Math.max(5, Math.min(width_px, height_px) * .35)))
    throw Error('附近已有候选；请直接选择现有点');
  const edit = await api('/api/candidate-edits', {sample_id: state.sample, image_id: item.image_id,
    region_id, action: 'add', x, y, width_px, height_px});
  state.candidateEdits.push(edit);
  state.detected.push(candidateFromEdit(edit));
  state.candidatesDirty = true;
  markRegionUnreviewed(region_id);
  $('showReviewCandidates').checked = true;
  state.candidate = state.detected.length - 1;
  $('omRegion').value = region_id;
  renderImage();
  $('candidateInfo').textContent = `${region_id} · 手动补点已保存：(${x.toFixed(1)}, ${y.toFixed(1)})，${width_px}×${height_px} px`;
}

$('clickAddCandidate').onclick = () => {
  if (selectedImage()?.role !== 'primary') { toast('请切换整片主图补点', true); return; }
  state.addPointMode = !state.addPointMode;
  $('clickAddCandidate').textContent = state.addPointMode ? '结束点图补点' : '点击放大图补点';
  $('clickAddCandidateHere').textContent = state.addPointMode ? '结束补点' : '点图补点';
  $('detectNote').textContent = state.addPointMode ? '补点模式：直接点击放大图中的遗漏 Pad。' : '补点模式已结束。';
  renderImage();
};
$('clickAddCandidateHere').onclick = () => $('clickAddCandidate').click();
$('removeCandidateHere').onclick = () => $('removeCandidate').click();
$('manualCandidate').onclick = () => action(async () => {
  const x = Number($('manualX').value), y = Number($('manualY').value);
  if (!$('manualX').value.trim() || !$('manualY').value.trim()) throw Error('请先填写中心坐标');
  await addCandidateAt(x, y);
});
$('removeCandidate').onclick = () => action(async () => {
  const point = state.detected[state.candidate];
  if (!point) throw Error('请先点击一个候选点');
  const item = selectedImage();
  if (point.edit_id) {
    await api('/api/delete-candidate-edit', {sample_id: state.sample, image_id: item.image_id,
      edit_id: point.edit_id});
    state.candidateEdits = state.candidateEdits.filter(e => e.edit_id !== point.edit_id);
  } else {
    const edit = await api('/api/candidate-edits', {sample_id: state.sample,
      image_id: item.image_id, region_id: point.region_id, action: 'remove',
      x: point.x, y: point.y, width_px: point.width_px, height_px: point.height_px});
    state.candidateEdits.push(edit);
  }
  state.detected.splice(state.candidate, 1);
  state.candidatesDirty = true;
  markRegionUnreviewed(point.region_id);
  state.candidate = null;
  $('candidateInfo').textContent = '候选点已删除；人工修正已保存，可在下方撤销。';
  renderImage();
});
function candidatePadRow(p, item, scale, layout) {
  const region = p.region_id;
  if (!region) throw Error('存在未分区候选，请先为图片添加区域框');
  const gridded = Boolean(p.layout_unit_id && p.pad_row && p.pad_col);
  if (!gridded && !p.edit_id) throw Error(`${region} 存在未编号的原始候选；请先完成规则识别或删除误检点`);
  const unit = gridded ? p.layout_unit_id : 'U-MANUAL';
  const local = gridded
    ? `r${String(p.pad_row).padStart(2, '0')}c${String(p.pad_col).padStart(2, '0')}`
    : `M${p.edit_id}`;
  const shape = ['circle', 'square', 'other'].includes(p.shape_guess) ? p.shape_guess : 'other';
  const row = {pad_id: [state.sample, region, layout, unit, local].join(':'),
    region_id: region, layout_type_id: layout, layout_unit_id: unit,
    unit_row: gridded ? p.unit_row : null, unit_col: gridded ? p.unit_col : null,
    pad_local_id: local, pad_row: gridded ? p.pad_row : null,
    pad_col: gridded ? p.pad_col : null, shape, x: p.x, y: p.y,
    image_id: item.image_id, area_source: calibrationSource(scale),
    area_confidence: p.confidence || 'review'};
  if (shape === 'circle') row.diameter_um = (p.width_px + p.height_px) / 2 * scale;
  else { row.width_um = p.width_px * scale; row.height_um = p.height_px * scale; }
  return row;
}

function calibrationSource(scale) {
  const bar = state.scaleBar;
  if (bar && state.scaleBarImage === selectedImage()?.image_id &&
      Math.abs(scale - bar.um_per_px) < 1e-5)
    return `OM calibration: ${bar.source === 'manual_line' ? 'drawn line' : 'image bar'} ${bar.label_um} um / ${bar.bar_length_px} px`;
  return 'OM calibration: manual';
}

$('saveAllCandidates').onclick = () => action(async () => {
  const item = selectedImage();
  if (!item || item.role !== 'primary') throw Error('请切换到整片主图');
  if (!state.regionBoxes.length) throw Error('请先添加区域框并识别');
  const missing = state.regionBoxes.filter(box => !state.latticeStats[box.region_id]?.applied);
  if (missing.length) throw Error(`以下区域尚未完成规则版图识别：${missing.map(box => box.region_id).join('、')}`);
  const scale = Number($('umPerPx').value);
  if (!(scale > 0) || !Number.isFinite(scale)) throw Error('请先填写有效的 µm/像素 标尺');
  const existingLayouts = new Map(state.pads.map(p => [p.region_id, p.layout_type_id]));
  const fallbackLayout = $('omLayoutType').value.trim() || 'L1';
  const all = state.detected.map(p => candidatePadRow(p, item, scale,
    existingLayouts.get(p.region_id) || fallbackLayout));
  const ids = new Set();
  for (const row of all) {
    if (ids.has(row.pad_id)) throw Error(`候选编号重复：${row.pad_id}，请检查区域内的格点`);
    ids.add(row.pad_id);
  }
  const existing = new Map(state.pads.map(p => [p.pad_id, p]));
  const regions = new Set(state.regionBoxes.map(box => box.region_id));
  const stale = state.pads.filter(p => p.image_id === item.image_id &&
    regions.has(p.region_id) && p.area_source?.startsWith('OM calibration') && !ids.has(p.pad_id));
  if (stale.length) throw Error(`已有 ${stale.length} 个 Pad 不在当前候选中（例如 ${stale[0].pad_id}）；请核对旧数据，批量保存不会自动删除它们`);
  const changed = all.filter(row => existing.has(row.pad_id) &&
    (Math.hypot(existing.get(row.pad_id).x - row.x, existing.get(row.pad_id).y - row.y) > 1 ||
     existing.get(row.pad_id).image_id !== item.image_id));
  if (changed.length) throw Error(`已有 ${changed.length} 个同编号 Pad 的位置与当前候选不一致（例如 ${changed[0].pad_id}）；请先核对，系统不会自动覆盖已保存数据`);
  const pending = all.filter(row => !existing.has(row.pad_id));
  if (!pending.length) { state.candidatesDirty = false; toast(`全部 ${all.length} 个候选 Pad 已入库`); return; }
  const button = $('saveAllCandidates');
  button.disabled = true;
  try {
    const result = await api('/api/pads', {sample_id: state.sample, rows: pending});
    state.candidatesDirty = false;
    await refresh();
    $('batchSaveNote').textContent = `已新增 ${result.imported} 个 Pad；已有 ${all.length - pending.length} 个跳过。人工补点使用 U-MANUAL 编号。`;
    toast(`已保存 ${result.imported} 个 Pad`);
  } finally { button.disabled = false; }
});

$('confirmCandidate').onclick = () => action(async () => {
  const item = selectedImage();
  if (primaryImage() && item.role !== 'primary') throw Error('请回到整片主图确认位置；补充图仅用于局部核对');
  const p = state.detected[state.candidate];
  if (!p) throw Error('请先点击图上的候选');
  const scale = Number($('umPerPx').value);
  if (!(scale > 0)) throw Error('请填写有效的 µm/像素 标尺');
  const region = $('omRegion').value.trim(), layout = $('omLayoutType').value.trim();
  const unit = $('omUnit').value.trim(), local = $('omLocal').value.trim();
  if (!region || !layout || !unit || !local) throw Error('区域、版图类型、重复版图及 Pad 局部 ID 均必填');
  if (p.region_id && region !== p.region_id)
    throw Error(`该候选属于区域 ${p.region_id}；请使用对应的区域 ID`);
  const gridValue = id => {
    const raw = $(id).value.trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw Error(`${id} 必须是正整数`);
    return value;
  };
  const unitRow = gridValue('omUnitRow'), unitCol = gridValue('omUnitCol');
  const padRow = gridValue('omPadRow'), padCol = gridValue('omPadCol');
  if ((unitRow === null) !== (unitCol === null) || (padRow === null) !== (padCol === null))
    throw Error('行列编号必须成对填写');
  const shape = $('omShape').value;
  const row = {pad_id: [state.sample, region, layout, unit, local].join(':'), region_id: region,
    layout_type_id: layout, layout_unit_id: unit, unit_row: unitRow, unit_col: unitCol,
    pad_local_id: local, pad_row: padRow, pad_col: padCol, shape, x: p.x, y: p.y,
    image_id: item.image_id, area_source: calibrationSource(scale), area_confidence: 'manual-reviewed'};
  if (shape === 'circle') row.diameter_um = ((p.width_px + p.height_px) / 2) * scale;
  else {row.width_um = p.width_px * scale; row.height_um = p.height_px * scale;}
  await api('/api/pads', {sample_id: state.sample, rows: [row]});
  await refresh(); toast('Pad 已保存到整片图坐标系');
});

action(bootstrapWorkspace);
