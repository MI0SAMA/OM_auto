function padClassName(kind) {
  return ({tiny: '微', small: '小', medium: '中', large: '大'})[kind] || '未知';
}

function regularLayoutLabel(lattice) {
  const parts = [];
  if (lattice.top_small_rows) parts.push(`${lattice.top_small_rows}×${lattice.small_cols} 顶部小方 Pad`);
  parts.push(`${lattice.large_rows}×${lattice.large_cols} 大 Pad`);
  if (lattice.bottom_small_rows) parts.push(`${lattice.bottom_small_rows}×${lattice.small_cols} 底部小 Pad`);
  if (lattice.left_small_cols) parts.push(`${lattice.left_small_rows}×${lattice.left_small_cols} 左侧微 Pad`);
  if (lattice.small_rows && !lattice.top_small_rows && !lattice.bottom_small_rows)
    parts.push(`${lattice.small_rows}×${lattice.small_cols} 小 Pad`);
  return parts.join('＋');
}

async function loadScaleBar(item) {
  const info = $('scaleBarInfo');
  if (!item || item.role !== 'primary') {
    $('umPerPx').value = '';
    state.scaleBarImage = null;
    state.scaleBar = null;
    state.scaleDrawMode = false;
    state.manualScaleLine = null;
    $('drawScaleLine').textContent = '在主图上拉线标定';
    info.textContent = item ? '补充图的标尺不能用于整片主图坐标；请切换到主图。' : '选择整片主图后自动读取图中标尺。';
    return;
  }
  if (state.scaleBarImage !== item.image_id) {
    $('umPerPx').value = '';
    $('scaleLengthUm').value = '';
    state.scaleBarImage = item.image_id;
    state.scaleBar = null;
    state.scaleDrawMode = false;
    state.manualScaleLine = null;
    $('drawScaleLine').textContent = '在主图上拉线标定';
  }
  if (state.scaleBar?.source === 'manual_line') return;
  info.textContent = '正在读取主图左下角的标尺…';
  try {
    const result = await api('/api/scale-bar?image_id=' + encodeURIComponent(item.image_id));
    if (selectedImage()?.image_id !== item.image_id) return;
    if (state.scaleBar?.source === 'manual_line') return;
    state.scaleBar = result.found ? result : null;
    if (result.found) {
      if (!$('umPerPx').value) $('umPerPx').value = result.um_per_px;
      if (!$('scaleLengthUm').value) $('scaleLengthUm').value = result.label_um;
      info.textContent = `主图标尺：${result.label_um} µm ÷ ${result.bar_length_px} px = ${result.um_per_px} µm/像素（自动读取，可核对或修改）。`;
    } else {
      info.textContent = '未能可靠读出主图标尺。可输入标尺实际长度，在图上拉线标定，或直接填写 µm/像素。';
    }
  } catch (error) {
    if (selectedImage()?.image_id === item.image_id)
      info.textContent = `主图标尺读取失败：${error.message}`;
  }
}

function applyManualScaleLine() {
  const line = state.manualScaleLine;
  if (!line) return;
  const lengthUm = Number($('scaleLengthUm').value);
  if (!(lengthUm > 0) || !Number.isFinite(lengthUm)) throw Error('请填写大于 0 的标尺实际长度（µm）');
  const lengthPx = Math.hypot(line[2] - line[0], line[3] - line[1]);
  if (lengthPx < 10) throw Error('拉线太短，请沿标尺完整长度重新画线');
  const scale = lengthUm / lengthPx;
  state.scaleBar = {source: 'manual_line', label_um: lengthUm,
    bar_length_px: Number(lengthPx.toFixed(1)), um_per_px: scale};
  state.scaleBarImage = selectedImage()?.image_id;
  $('umPerPx').value = Number(scale.toPrecision(8));
  $('scaleBarInfo').textContent = `手动标定：${lengthUm} µm ÷ ${lengthPx.toFixed(1)} px = ${scale.toPrecision(8)} µm/像素。保存 Pad 时会记录这次标定来源。`;
}

async function loadRegionBoxes(item) {
  if (item) {
    const query = '?sample_id=' + encodeURIComponent(state.sample) + '&image_id=' + encodeURIComponent(item.image_id);
    [state.regionBoxes, state.candidateEdits] = await Promise.all([
      api('/api/region-boxes' + query), api('/api/candidate-edits' + query)]);
    if (item.role === 'primary') state.primaryRegionBoxes = state.regionBoxes.map(box => ({...box}));
  } else {
    state.regionBoxes = []; state.candidateEdits = [];
  }
  state.detected = state.detected.filter(p => !p.edit_id || state.candidateEdits.some(e => e.edit_id === p.edit_id));
  for (const edit of state.candidateEdits.filter(e => e.action === 'add')) {
    if (!state.detected.some(p => p.edit_id === edit.edit_id))
      state.detected.push(candidateFromEdit(edit));
  }
  if (state.regionBoxes.some(box => box.region_id === $('newRegionId').value.trim()))
    $('newRegionId').value = nextRegionId();
  renderImage();
  renderPads();
}

function candidateFromEdit(edit) {
  return {x: edit.x, y: edit.y, width_px: edit.width_px, height_px: edit.height_px,
    region_id: edit.region_id, shape_guess: 'other', fill: null,
    grid_support: null, confidence: 'manual', edit_id: edit.edit_id};
}

function renderCandidateEdits() {
  const list = $('candidateEditList');
  list.innerHTML = state.candidateEdits.length ?
    `<strong class="muted">已保存的人工修正 (${state.candidateEdits.length})</strong>` +
    state.candidateEdits.map(edit => `<div class="region-box-item"><span>${esc(edit.region_id)} · ${edit.action === 'add' ? '补点' : '删点'} (${edit.x.toFixed(1)}, ${edit.y.toFixed(1)})</span><button type="button" data-edit="${edit.edit_id}" class="minor">撤销</button></div>`).join('') : '';
  list.querySelectorAll('button[data-edit]').forEach(button => button.onclick = () => action(async () => {
    const edit = state.candidateEdits.find(e => e.edit_id === Number(button.dataset.edit));
    if (!edit) return;
    await api('/api/delete-candidate-edit', {sample_id: state.sample,
      image_id: selectedImage().image_id, edit_id: edit.edit_id});
    markRegionUnreviewed(edit.region_id);
    state.candidateEdits = state.candidateEdits.filter(e => e.edit_id !== edit.edit_id);
    if (edit.action === 'add') {
      state.detected = state.detected.filter(p => p.edit_id !== edit.edit_id);
    } else {
      const box = state.regionBoxes.find(b => b.region_id === edit.region_id);
      if (box) {
        await detectBoxes([box]);
        return;
      }
    }
    state.candidate = null;
    renderImage();
  }));
}

function nextRegionId() {
  const ids = new Set(state.regionBoxes.map(box => box.region_id));
  let n = 1;
  while (ids.has('R' + n)) n++;
  return 'R' + n;
}

function focusRegionBox(box) {
  const item = selectedImage();
  if (!item) return;
  const stage = $('imageStage');
  const viewportWidth = stage.clientWidth || 1000;
  const viewportHeight = stage.clientHeight || Math.min(window.innerHeight * .7, 780);
  const widthZoom = item.width_px / (box[2] - box[0]);
  const heightZoom = viewportHeight * item.width_px /
    (viewportWidth * (box[3] - box[1]));
  const slider = $('imageZoom');
  const zoom = Math.max(Number(slider.min), Math.min(Number(slider.max),
    .9 * Math.min(widthZoom, heightZoom)));
  slider.value = zoom.toFixed(1);
  state.focusBox = box;
  const region = state.regionBoxes.find(b => b.x1 === box[0] && b.y1 === box[1] && b.x2 === box[2] && b.y2 === box[3]);
  $('viewingRegion').textContent = region ? `当前区域：${region.region_id}` : '';
  if (document.querySelector('section.tab.active')?.id === 'review') renderImage();
}

function renderRegionBoxList() {
  const list = $('regionBoxList');
  $('detect').textContent = state.regionBoxes.length
    ? `识别全部 ${state.regionBoxes.length} 个区域` : '识别全部区域';
  const savedCounts = new Map();
  for (const pad of state.pads) savedCounts.set(pad.region_id, (savedCounts.get(pad.region_id) || 0) + 1);
  list.innerHTML = state.regionBoxes.map(box => {
    const count = state.detected.filter(p => p.region_id === box.region_id).length;
    const lattice = state.latticeStats[box.region_id];
    const layout = lattice?.applied ? lattice.row_groups
      ? ` · ${lattice.unit_rows} 条版图，每条 ${lattice.row_groups.map(g => `${g.rows}×${g.cols} ${padClassName(g.pad_class)} Pad（约 ${g.size_px} px）`).join('＋')}；共 ${count} 格点`
      : ` · ${lattice.unit_rows}×${lattice.unit_cols} 个版图，每版图 ${regularLayoutLabel(lattice)}；${lattice.shape_guess === 'circle' ? '近圆形' : '形状待核验'}，约 ${lattice.large_size_px}${lattice.small_size_px ? '/' + lattice.small_size_px : ''} px；共 ${count} 格点`
      : ` · 规则格点未拟合，仅显示 ${count} 个原始候选`;
    return `<div class="region-box-item"><strong>${esc(box.region_id)}</strong><span>${box.x1}, ${box.y1} → ${box.x2}, ${box.y2} · ${box.x2-box.x1} × ${box.y2-box.y1} px</span><span>${layout} · 已保存 ${savedCounts.get(box.region_id) || 0} 个 Pad</span><button type="button" data-region="${esc(box.region_id)}" data-action="focus">定位</button><button type="button" data-region="${esc(box.region_id)}" data-action="detect">识别该区域</button><button type="button" data-region="${esc(box.region_id)}" data-action="delete" class="minor">删除框</button></div>`;
  }).join('') || '<p class="muted">还没有区域框；在整图缩略图上添加区域。</p>';
  list.querySelectorAll('button').forEach(button => button.onclick = () => {
    const box = state.regionBoxes.find(b => b.region_id === button.dataset.region);
    if (!box) return;
    if (button.dataset.action === 'focus') {
      $('omRegion').value = box.region_id;
      focusRegionBox([box.x1, box.y1, box.x2, box.y2]);
      navigateView('review');
    } else if (button.dataset.action === 'detect') {
      detectBoxes([box]);
    } else {
      action(async () => {
        await api('/api/delete-region-box', {sample_id: state.sample, image_id: selectedImage().image_id,
          region_id: box.region_id});
        state.regionBoxes = state.regionBoxes.filter(b => b.region_id !== box.region_id);
        state.candidateEdits = state.candidateEdits.filter(e => e.region_id !== box.region_id);
        delete state.latticeStats[box.region_id];
        state.detected = state.detected.filter(p => p.region_id !== box.region_id);
        state.candidate = null;
        await refresh();
      });
    }
  });
}

function primaryImage() {
  return state.images.find(i => i.role === 'primary');
}

function selectedImage() {
  return state.images.find(i => i.image_id === $('imageSelect').value) || primaryImage();
}

function imagePoint(event, image, metadata) {
  const rect = image.getBoundingClientRect();
  return [
    Math.max(0, Math.min(metadata.width_px, (event.clientX - rect.left) / rect.width * metadata.width_px)),
    Math.max(0, Math.min(metadata.height_px, (event.clientY - rect.top) / rect.height * metadata.height_px))
  ];
}
