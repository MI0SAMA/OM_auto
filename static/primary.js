/* The whole-sample photograph anchors coordinates and the selected-pad map. */
state.regionBoxes = [];
state.candidateEdits = [];
state.latticeStats = {};
state.roiMode = false;
state.focusBox = null;
state.addPointMode = false;
state.scaleBarImage = null;
state.scaleBar = null;
state.primaryRegionBoxes = [];
state.padMapRegion = '';
state.padMapActiveId = null;
state.currentPlanId = null;
state.planDraftDirty = false;
state.samplingSample = null;

function clearPlanSelection() {
  state.plan = [];
  state.currentPlanId = null;
  state.planDraftDirty = false;
  $('savePlanEdits').disabled = true;
  $('planResult').innerHTML = '<p class="muted">点击图中的 Pad 可手动加入清单，或先生成自动方案。</p>';
}

function renderPlanResult() {
  const count = state.plan.length;
  const saved = state.currentPlanId && !state.planDraftDirty;
  const title = state.currentPlanId ? `方案 #${state.currentPlanId}` : '手动选择';
  const note = state.planDraftDirty ? ' · 修改未保存' : '';
  $('planResult').innerHTML = `<p>${title} · ${count} 个 Pad${note}</p>` +
    (saved ? `<a href="/api/task.csv?plan_id=${state.currentPlanId}">下载任务 CSV</a>` : '') +
    table(state.plan, ['pad_id', 'region_id', 'layout_type_id', 'layout_unit_id', 'pad_local_id', 'shape', 'x', 'y']);
  $('savePlanEdits').disabled = !state.planDraftDirty || count === 0;
}

function padOrdinal(pad) {
  const unitPads = state.pads.filter(p => p.region_id === pad.region_id &&
    p.layout_unit_id === pad.layout_unit_id).sort((a, b) =>
      (a.pad_row ?? Infinity) - (b.pad_row ?? Infinity) ||
      (a.pad_col ?? Infinity) - (b.pad_col ?? Infinity) ||
      a.pad_local_id.localeCompare(b.pad_local_id, undefined, {numeric: true}));
  return {index: unitPads.findIndex(p => p.pad_id === pad.pad_id) + 1, total: unitPads.length};
}

function padClassName(kind) {
  return ({tiny: '微', small: '小', medium: '中', large: '大'})[kind] || '未知';
}

function regularLayoutLabel(lattice) {
  const parts = [];
  if (lattice.top_small_rows) parts.push(`${lattice.top_small_rows}×${lattice.small_cols} 顶部小方 Pad`);
  parts.push(`${lattice.large_rows}×${lattice.large_cols} 大 Pad`);
  if (lattice.bottom_small_rows) parts.push(`${lattice.bottom_small_rows}×${lattice.small_cols} 底部小 Pad`);
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
    info.textContent = item ? '补充图的标尺不能用于整片主图坐标；请切换到主图。' : '选择整片主图后自动读取图中标尺。';
    return;
  }
  if (state.scaleBarImage !== item.image_id) {
    $('umPerPx').value = '';
    state.scaleBarImage = item.image_id;
    state.scaleBar = null;
  }
  info.textContent = '正在读取主图左下角的标尺…';
  try {
    const result = await api('/api/scale-bar?image_id=' + encodeURIComponent(item.image_id));
    if (selectedImage()?.image_id !== item.image_id) return;
    state.scaleBar = result.found ? result : null;
    if (result.found) {
      if (!$('umPerPx').value) $('umPerPx').value = result.um_per_px;
      info.textContent = `主图标尺：${result.label_um} µm ÷ ${result.bar_length_px} px = ${result.um_per_px} µm/像素（自动读取，可核对或修改）。`;
    } else {
      info.textContent = '未能可靠读出主图标尺，请核对标尺文字和端点后填写 µm/像素。';
    }
  } catch (error) {
    if (selectedImage()?.image_id === item.image_id)
      info.textContent = `主图标尺读取失败：${error.message}`;
  }
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
  renderImage();
}

function renderRegionBoxList() {
  const list = $('regionBoxList');
  list.innerHTML = state.regionBoxes.map(box => {
    const count = state.detected.filter(p => p.region_id === box.region_id).length;
    const lattice = state.latticeStats[box.region_id];
    const layout = lattice?.applied ? lattice.row_groups
      ? ` · ${lattice.unit_rows} 条版图，每条 ${lattice.row_groups.map(g => `${g.rows}×${g.cols} ${padClassName(g.pad_class)} Pad（约 ${g.size_px} px）`).join('＋')}；共 ${count} 格点`
      : ` · ${lattice.unit_rows}×${lattice.unit_cols} 个版图，每版图 ${regularLayoutLabel(lattice)}；${lattice.shape_guess === 'circle' ? '近圆形' : '形状待核验'}，约 ${lattice.large_size_px}${lattice.small_size_px ? '/' + lattice.small_size_px : ''} px；共 ${count} 格点`
      : ` · ${count} 个候选`;
    return `<div class="region-box-item"><strong>${esc(box.region_id)}</strong><span>${box.x1}, ${box.y1} → ${box.x2}, ${box.y2}</span><span>${layout}</span><button type="button" data-region="${esc(box.region_id)}" data-action="focus">定位</button><button type="button" data-region="${esc(box.region_id)}" data-action="detect">识别该区域</button><button type="button" data-region="${esc(box.region_id)}" data-action="delete" class="minor">删除框</button></div>`;
  }).join('') || '<p class="muted">还没有区域框；在整图缩略图上添加区域。</p>';
  list.querySelectorAll('button').forEach(button => button.onclick = () => {
    const box = state.regionBoxes.find(b => b.region_id === button.dataset.region);
    if (!box) return;
    if (button.dataset.action === 'focus') {
      $('omRegion').value = box.region_id;
      focusRegionBox([box.x1, box.y1, box.x2, box.y2]);
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
        renderImage();
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

function renderPlanImage() {
  const image = primaryImage();
  const target = $('planImage');
  const group = state.groups.find(g => g.id === $('groupSelect').value);
  const groupIds = $('samplingMode').value === 'geometry' ? new Set(group?.pad_ids || []) : null;
  const chosen = new Set(state.plan.map(p => p.pad_id));
  const scope = new Set($('regions').value.split(',').map(x => x.trim()).filter(Boolean));
  const all = state.pads.filter(p => !groupIds || groupIds.has(p.pad_id));
  const withCoordinates = all.filter(p => p.x !== null && p.y !== null &&
    (!image || p.image_id === image.image_id));
  const visible = withCoordinates.filter(p =>
    (p.usable || $('planShowExcluded').checked) && (!p.tested || $('planShowTested').checked));
  const zoom = Number($('planZoom').value) || 1;
  const previousLeft = target.scrollLeft, previousTop = target.scrollTop;
  let width, height, point, background = '';
  if (image) {
    width = image.width_px; height = image.height_px;
    point = p => [p.x, p.y];
    background = `<img src="/api/image?image_id=${image.image_id}" alt="整片 OM 主图">`;
  } else if (withCoordinates.length) {
    const xs = withCoordinates.map(p => p.x), ys = withCoordinates.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    width = 800; height = 520;
    point = p => [45 + 710 * (p.x - minX) / (maxX - minX || 1),
                  45 + 430 * (p.y - minY) / (maxY - minY || 1)];
    background = '<div style="position:absolute;inset:0;background:#f5f9fa"></div>';
  } else {
    target.innerHTML = '<p class="muted" style="padding:20px">当前选点范围没有可绘制的 Pad 坐标。</p>';
    $('planLegend').innerHTML = '';
    return;
  }
  const base = image ? 14 : 3;
  const regionPadding = image ? 110 : 20;
  const byRegion = {};
  for (const p of withCoordinates) (byRegion[p.region_id] ||= []).push(p);
  const boxes = Object.entries(byRegion).map(([region, pads]) => {
    const points = pads.map(point);
    const left = Math.max(0, Math.min(...points.map(q => q[0])) - regionPadding);
    const top = Math.max(0, Math.min(...points.map(q => q[1])) - regionPadding);
    const right = Math.min(width, Math.max(...points.map(q => q[0])) + regionPadding);
    const bottom = Math.min(height, Math.max(...points.map(q => q[1])) + regionPadding);
    const selectedClass = scope.has(region) ? ' selected' : '';
    return `<rect class="region-box${selectedClass}" x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" style="stroke-width:${(image ? 15 : 2) / zoom};stroke-dasharray:${(image ? 45 : 8) / zoom} ${(image ? 30 : 5) / zoom}"></rect><text class="region-label${selectedClass}" x="${left + (image ? 25 : 5)}" y="${top + (image ? 100 : 24)}" style="font-size:${(image ? 105 : 18) / zoom}px;stroke-width:${(image ? 22 : 3) / zoom}">${esc(region)}</text>`;
  }).join('');
  const marks = visible.map(p => {
    const [x, y] = point(p);
    const selected = chosen.has(p.pad_id);
    const inferred = p.area_confidence === 'layout_only';
    const color = !p.usable ? '#ca4a53' : p.tested ? '#788998' : inferred ? '#8c949c' : '#159c8c';
    return `<circle class="pad-mark" data-id="${esc(p.pad_id)}" cx="${x}" cy="${y}" r="${(selected ? base * 2 : base) / zoom}" fill="${selected || inferred ? 'none' : color}" fill-opacity=".8" stroke="${selected ? '#d63333' : inferred ? color : 'none'}" stroke-width="${(selected ? base * .52 : inferred ? base * .35 : 0) / zoom}" ${selected ? `stroke-dasharray="${base * .85 / zoom} ${base * .65 / zoom}"` : ''}><title>${esc(p.pad_id)} · ${esc(p.region_id)}/${esc(p.layout_unit_id)} · ${selected ? '本轮选点' : p.tested ? '已测' : inferred ? '纯布局推断' : p.usable ? '可用' : '排除'}</title></circle>`;
  }).join('');
  target.innerHTML = `<div class="image-canvas" style="width:${zoom * 100}%;aspect-ratio:${width}/${height}">${background}<svg class="${image ? '' : 'fallback'}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${boxes}${marks}</svg></div>`;
  target.scrollLeft = previousLeft; target.scrollTop = previousTop;
  const img = target.querySelector('img');
  if (img) img.onload = () => { target.scrollLeft = previousLeft; target.scrollTop = previousTop; };
  target.querySelector('svg').onclick = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const pixelX = event.clientX - rect.left, pixelY = event.clientY - rect.top;
    let p = null, distance = Infinity;
    for (const candidate of visible) {
      const [x, y] = point(candidate);
      const d = Math.hypot(pixelX - x / width * rect.width, pixelY - y / height * rect.height);
      if (d < distance) { p = candidate; distance = d; }
    }
    if (!p || distance > 14) return;
    const unitGrid = p.unit_row && p.unit_col ? `版图(${p.unit_row},${p.unit_col})` : '版图行列未登记';
    const padGrid = p.pad_row && p.pad_col ? `Pad(${p.pad_row},${p.pad_col})` : 'Pad 行列未登记';
    const details = `${p.pad_id} | ${p.region_id} / ${p.layout_type_id} / ${p.layout_unit_id} / ${p.pad_local_id} | ${unitGrid} · ${padGrid} | ${p.shape} | 面积 ${p.area_um2 == null ? '未知' : p.area_um2.toFixed(1) + ' µm²'}`;
    if (chosen.has(p.pad_id)) {
      state.plan = state.plan.filter(item => item.pad_id !== p.pad_id);
      state.planDraftDirty = true;
      $('padInspect').textContent = details + ' | 已从清单取消';
      renderPlanResult(); renderPlanImage(); renderPads();
      return;
    }
    if (!scope.has(p.region_id)) { $('padInspect').textContent = details + ' | 请先勾选此区域'; return; }
    if (!p.usable || p.tested) { $('padInspect').textContent = details + (p.tested ? ' | 已测，不能加入方案' : ' | 已排除，不能加入方案'); return; }
    if (p.area_confidence === 'layout_only' && !chosen.has(p.pad_id) && !$('includeLayoutOnly').checked) {
      $('padInspect').textContent = details + ' | 纯布局推断，请先核实并勾选纳入'; return;
    }
    state.plan = [...state.plan, p];
    state.planDraftDirty = true;
    $('padInspect').textContent = details + ' | 已加入清单';
    renderPlanResult(); renderPlanImage(); renderPads();
  };
  const covered = new Set(withCoordinates.map(p => p.pad_id));
  const unmapped = all.length - covered.size;
  $('planLegend').innerHTML = `<span><i style="background:#159c8c"></i>非纯布局推断可用 ${all.filter(p => p.usable && !p.tested && p.area_confidence !== 'layout_only').length}</span><span><i style="border:2px dashed #d63333;background:white"></i>当前清单 ${chosen.size}</span><span><i style="border:2px solid #8c949c;background:white"></i>纯布局推断 ${all.filter(p => p.area_confidence === 'layout_only').length}</span><span><i style="background:#788998"></i>已测 ${all.filter(p => p.tested).length}</span><span><i style="background:#ca4a53"></i>排除 ${all.filter(p => !p.usable).length}</span><span>虚线框：Region</span>${unmapped ? `<span class="error">${unmapped} 个 Pad 无法叠加到${image ? '主图' : '坐标图'}</span>` : ''}`;
}

function selectedSamplingRegions() {
  return [...$('samplingRegionChoices').querySelectorAll('input:checked')].map(input => input.value);
}

function renderSamplingRegions(preferred = null) {
  const counts = new Map();
  for (const p of state.pads) {
    if (!counts.has(p.region_id)) counts.set(p.region_id, {pads: 0, units: new Set()});
    const item = counts.get(p.region_id);
    item.pads++; item.units.add(p.layout_unit_id);
  }
  const wanted = preferred || new Set($('regions').value.split(',').map(s => s.trim()).filter(Boolean));
  const defaultAll = wanted.size === 0;
  $('samplingRegionChoices').innerHTML = [...counts].sort(([a], [b]) => a.localeCompare(b, undefined, {numeric: true})).map(([id, item]) =>
    `<label><input type="checkbox" value="${esc(id)}" ${defaultAll || wanted.has(id) ? 'checked' : ''}><strong>${esc(id)}</strong><small>${item.units.size} 版图 · ${item.pads} Pad</small></label>`).join('') || '<span class="muted">该样品尚无 Pad</span>';
  $('samplingRegionChoices').querySelectorAll('input').forEach(input => input.onchange = () => {
    $('regions').value = selectedSamplingRegions().join(',');
    clearPlanSelection(); renderPlanImage(); renderPads();
  });
  $('regions').value = selectedSamplingRegions().join(',');
}

function updateSamplingMode() {
  $('geometryFilter').hidden = $('samplingMode').value !== 'geometry';
  clearPlanSelection(); renderPlanImage(); renderPads();
}

const originalRenderPads = renderPads;
function regionLabelPosition(box, image, sourcePerScreen) {
  const width = 36 * sourcePerScreen;
  const height = 24 * sourcePerScreen;
  const gap = 7 * sourcePerScreen;
  const clamp = (value, maximum) => Math.max(0, Math.min(value, maximum));
  if (box.x1 >= width + gap)
    return {x: box.x1 - width - gap, y: clamp(box.y1, image.height_px - height), width, height};
  if (image.width_px - box.x2 >= width + gap)
    return {x: box.x2 + gap, y: clamp(box.y1, image.height_px - height), width, height};
  if (box.y1 >= height + gap)
    return {x: clamp(box.x1, image.width_px - width), y: box.y1 - height - gap, width, height};
  return {x: clamp(box.x1, image.width_px - width),
          y: clamp(box.y2 + gap, image.height_px - height), width, height};
}

renderPads = function () {
  const image = primaryImage();
  if (!image) {
    originalRenderPads();
    $('padMapLegend').innerHTML = '';
    const svg = $('padPlot').querySelector('svg');
    const located = state.pads.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (svg && located.length) {
      const minX = Math.min(...located.map(p => p.x)), maxX = Math.max(...located.map(p => p.x));
      const minY = Math.min(...located.map(p => p.y)), maxY = Math.max(...located.map(p => p.y));
      const point = p => [30 + (p.x - minX) / (maxX - minX || 1) * 740,
                          30 + (p.y - minY) / (maxY - minY || 1) * 420];
      const active = located.find(p => p.pad_id === state.padMapActiveId);
      if (active) {
        const [x, y] = point(active), ordinal = padOrdinal(active);
        const label = `${active.region_id}/${active.layout_unit_id} 第${ordinal.index}号 · ${active.pad_local_id}`;
        svg.insertAdjacentHTML('beforeend', `<circle cx="${x}" cy="${y}" r="10" fill="none" stroke="#d63333" stroke-width="2" pointer-events="none"/><text x="${Math.min(x + 12, 620)}" y="${Math.max(y - 12, 20)}" fill="#b3282e" stroke="white" stroke-width="3" paint-order="stroke" style="font-size:13px" font-weight="700" pointer-events="none">${esc(label)}</text>`);
      }
      svg.onclick = event => {
        const box = svg.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width * 800;
        const y = (event.clientY - box.top) / box.height * 480;
        const nearest = located.map(p => ({p, d: Math.hypot(point(p)[0] - x, point(p)[1] - y)}))
          .sort((a, b) => a.d - b.d)[0];
        if (!nearest || nearest.d * box.width / 800 > 14) return;
        state.padMapActiveId = nearest.p.pad_id;
        const ordinal = padOrdinal(nearest.p);
        $('padMapInfo').textContent = `${nearest.p.region_id}/${nearest.p.layout_unit_id} 第${ordinal.index}/${ordinal.total}号 · ${nearest.p.pad_id}`;
        renderPads();
      };
    }
    return;
  }
  const target = $('padPlot');
  const oldCanvas = target.querySelector('.pad-map-canvas');
  const centerX = oldCanvas && oldCanvas.clientWidth > target.clientWidth
    ? (target.scrollLeft + target.clientWidth / 2) / oldCanvas.clientWidth : .5;
  const centerY = oldCanvas && oldCanvas.clientHeight > target.clientHeight
    ? (target.scrollTop + target.clientHeight / 2) / oldCanvas.clientHeight : .5;
  const pads = state.pads.filter(p => p.image_id === image.image_id &&
    Number.isFinite(p.x) && Number.isFinite(p.y) &&
    0 <= p.x && p.x <= image.width_px && 0 <= p.y && p.y <= image.height_px);
  const unmapped = state.pads.length - pads.length;
  const boxMap = new Map(state.primaryRegionBoxes.map(box => [box.region_id, box]));
  const regions = [...new Set([...boxMap.keys(), ...pads.map(p => p.region_id)])].sort();
  const palette = ['#167b91', '#a04f9f', '#d26a2a', '#228563', '#7673bf', '#a87722'];
  const colors = new Map(regions.map((region, index) => [region, palette[index % palette.length]]));
  const focus = $('padMapFocus');
  const current = state.padMapRegion;
  focus.innerHTML = '<option value="">整片</option>' + regions.map(region =>
    `<option value="${esc(region)}">${esc(region)}</option>`).join('');
  state.padMapRegion = regions.includes(current) ? current : '';
  focus.value = state.padMapRegion;
  const zoom = Number($('padMapZoom').value) || 1;
  const availableWidth = Math.max(260, target.clientWidth - 20);
  const fitScale = Math.min(740 / image.height_px, availableWidth / image.width_px);
  const canvasWidth = image.width_px * fitScale * zoom;
  const canvasHeight = image.height_px * fitScale * zoom;
  const sourcePerScreen = 1 / (fitScale * zoom);
  const selected = new Set(state.plan.map(p => p.pad_id));
  const activePad = pads.find(p => p.pad_id === state.padMapActiveId);
  const activeOrdinal = activePad ? padOrdinal(activePad).index : 0;
  const boxes = regions.map(region => {
    let box = boxMap.get(region);
    if (!box) {
      const points = pads.filter(p => p.region_id === region);
      if (!points.length) return '';
      box = {x1: Math.max(0, Math.min(...points.map(p => p.x)) - 80),
             y1: Math.max(0, Math.min(...points.map(p => p.y)) - 80),
             x2: Math.min(image.width_px, Math.max(...points.map(p => p.x)) + 80),
             y2: Math.min(image.height_px, Math.max(...points.map(p => p.y)) + 80)};
    }
    const color = colors.get(region);
    const opacity = state.padMapRegion && state.padMapRegion !== region ? .3 : 1;
    const label = regionLabelPosition(box, image, sourcePerScreen);
    return `<rect x="${box.x1}" y="${box.y1}" width="${box.x2-box.x1}" height="${box.y2-box.y1}" fill="none" stroke="${color}" stroke-width="${2.4*sourcePerScreen}" stroke-dasharray="${9*sourcePerScreen} ${6*sourcePerScreen}" opacity="${opacity}"></rect><text x="${label.x + label.width/2}" y="${label.y + label.height/2}" dominant-baseline="middle" text-anchor="middle" fill="${color}" style="font-size:${18*sourcePerScreen}px" font-weight="700" pointer-events="none" opacity="${opacity}">${esc(region)}</text>`;
  }).join('');
  const marks = pads.map(p => {
    const inferredOnly = p.area_confidence === 'layout_only';
    const chosenPad = selected.has(p.pad_id);
    const color = !p.usable ? '#c94c57' :
      p.tested ? '#7b8b96' : inferredOnly ? '#5c6875' : colors.get(p.region_id) || '#167b91';
    const opacity = state.padMapRegion && state.padMapRegion !== p.region_id ? .14 :
      p.area_confidence === 'grid_inferred' ? .58 : .9;
    return `<circle cx="${p.x}" cy="${p.y}" r="${p.pad_id === state.padMapActiveId ? 16 : chosenPad ? 12 : 7}" fill="${chosenPad || inferredOnly ? 'none' : color}" fill-opacity="${opacity}" ${p.pad_id === state.padMapActiveId ? 'stroke="#e12d35" stroke-width="4"' : chosenPad ? 'stroke="#d63333" stroke-width="3" stroke-dasharray="5 4"' : inferredOnly ? `stroke="${color}" stroke-width="2.5" stroke-opacity="${opacity}"` : ''}><title>${esc(p.pad_id)} · ${esc(p.region_id)} / ${esc(p.layout_unit_id)} · ${inferredOnly ? '仅布局推断' : p.area_confidence === 'grid_inferred' ? '图像支持的补漏' : '已检测'}</title></circle>`;
  }).join('');
  const badge = activePad ? (() => {
    const label = `${activePad.region_id}/${activePad.layout_unit_id} 第${activeOrdinal}号 · ${activePad.pad_local_id}`;
    const badgeWidth = Math.max(155, label.length * 10) * sourcePerScreen;
    const badgeHeight = 27 * sourcePerScreen;
    const x = Math.max(0, Math.min(image.width_px - badgeWidth, activePad.x + 16 * sourcePerScreen));
    const y = Math.max(badgeHeight, Math.min(image.height_px, activePad.y - 12 * sourcePerScreen));
    return `<g pointer-events="none"><rect x="${x}" y="${y - badgeHeight}" width="${badgeWidth}" height="${badgeHeight}" rx="${5 * sourcePerScreen}" fill="#fff" stroke="#d63333" stroke-width="${2 * sourcePerScreen}"></rect><text x="${x + 6 * sourcePerScreen}" y="${y - 8 * sourcePerScreen}" fill="#a91f2a" style="font-size:${14 * sourcePerScreen}px" font-weight="700">${esc(label)}</text></g>`;
  })() : '';
  const background = $('padMapShowImage').checked
    ? `<img src="/api/image?image_id=${encodeURIComponent(image.image_id)}" alt="整片 OM 主图">`
    : '<div class="pad-map-blank"></div>';
  target.innerHTML = `<div class="pad-map-canvas" style="width:${canvasWidth}px;height:${canvasHeight}px">${background}<svg viewBox="0 0 ${image.width_px} ${image.height_px}" preserveAspectRatio="none" aria-label="整片主图上的 Pad 和区域">${marks}${boxes}${badge}</svg></div>`;
  target.scrollLeft = centerX * canvasWidth - target.clientWidth / 2;
  target.scrollTop = centerY * canvasHeight - target.clientHeight / 2;
  $('padMapLegend').innerHTML = regions.map(region => `<span><i style="background:${colors.get(region)}"></i>${esc(region)}：${pads.filter(p => p.region_id === region).length} Pad</span>`).join('') +
    `<span><i style="border:2px dashed #d63333;background:white"></i>当前选点</span><span>灰色空心：仅布局推断 ${pads.filter(p => p.area_confidence === 'layout_only').length}</span>${unmapped ? `<span class="error">${unmapped} 个 Pad 没有主图像素坐标</span>` : ''}`;
  target.querySelector('svg').onclick = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * image.width_px;
    const y = (event.clientY - rect.top) / rect.height * image.height_px;
    let nearest = null, distance = Infinity;
    for (const p of pads) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < distance) { nearest = p; distance = d; }
    }
    if (!nearest || distance > 12 * sourcePerScreen) return;
    const unit = nearest.unit_row && nearest.unit_col ? `版图(${nearest.unit_row},${nearest.unit_col})` : nearest.layout_unit_id;
    const cell = nearest.pad_row && nearest.pad_col ? `Pad(${nearest.pad_row},${nearest.pad_col})` : nearest.pad_local_id;
    const evidence = nearest.area_confidence === 'layout_only' ? '仅布局推断，须核对' :
      nearest.area_confidence === 'grid_inferred' ? '局部图像信号支持' : '图像检测或人工确认';
    state.padMapActiveId = nearest.pad_id;
    renderPads();
    const ordinal = padOrdinal(nearest);
    $('padMapInfo').textContent = `${nearest.region_id}/${nearest.layout_unit_id} 第${ordinal.index}/${ordinal.total}号 · ${nearest.pad_id} · ${unit} · ${cell} · 主图坐标 (${nearest.x.toFixed(1)}, ${nearest.y.toFixed(1)}) px · ${nearest.shape} · 面积 ${nearest.area_um2 == null ? '未知' : nearest.area_um2.toFixed(1) + ' µm²'} · ${evidence}`;
  };
};

function focusPadMapRegion(region) {
  state.padMapRegion = region;
  $('padMapZoom').value = region ? 3 : 1;
  renderPads();
  const image = primaryImage(), target = $('padPlot');
  let box = state.primaryRegionBoxes.find(item => item.region_id === region);
  if (!box && region && image) {
    const points = state.pads.filter(p => p.region_id === region && p.image_id === image.image_id &&
      Number.isFinite(p.x) && Number.isFinite(p.y));
    if (points.length) box = {x1: Math.min(...points.map(p => p.x)), x2: Math.max(...points.map(p => p.x)),
                              y1: Math.min(...points.map(p => p.y)), y2: Math.max(...points.map(p => p.y))};
  }
  if (!region || !box || !image) { target.scrollLeft = 0; target.scrollTop = 0; return; }
  const canvas = target.querySelector('.pad-map-canvas');
  const position = () => {
    target.scrollLeft = (box.x1 + box.x2) / 2 / image.width_px * canvas.clientWidth - target.clientWidth / 2;
    target.scrollTop = (box.y1 + box.y2) / 2 / image.height_px * canvas.clientHeight - target.clientHeight / 2;
  };
  position();
  const img = canvas.querySelector('img');
  if (img) img.onload = position;
}

$('padMapFocus').onchange = () => focusPadMapRegion($('padMapFocus').value);
let padMapRenderFrame = 0;
$('padMapZoom').oninput = () => {
  cancelAnimationFrame(padMapRenderFrame);
  padMapRenderFrame = requestAnimationFrame(renderPads);
};
$('padMapReset').onclick = () => focusPadMapRegion('');
$('padMapShowImage').onchange = renderPads;
document.querySelector('nav button[data-tab="samples"]').addEventListener('click', () => requestAnimationFrame(renderPads));
window.addEventListener('resize', () => {
  if ($('samples').classList.contains('active')) requestAnimationFrame(renderPads);
});

function renderOverview(item) {
  const stage = $('overviewStage');
  if (!item) { stage.innerHTML = ''; $('regionBoxList').innerHTML = ''; $('candidateEditList').innerHTML = ''; return; }
  const rectangle = state.regionBoxes.map(box => {
    const labelY = box.y1 >= 120 ? box.y1 - 28 : Math.min(item.height_px - 20, box.y2 + 75);
    return `<rect x="${box.x1}" y="${box.y1}" width="${box.x2-box.x1}" height="${box.y2-box.y1}"></rect><text x="${box.x1}" y="${labelY}">${esc(box.region_id)}</text>`;
  }).join('');
  stage.innerHTML = `<div class="overview-canvas ${state.roiMode ? 'selecting' : ''}" style="width:min(100%, ${70 * item.width_px / item.height_px}vh)"><img draggable="false" src="/api/image?image_id=${item.image_id}" alt="完整 OM 图缩略图"><svg viewBox="0 0 ${item.width_px} ${item.height_px}" preserveAspectRatio="none">${rectangle}<rect class="dragging" hidden></rect></svg></div>`;
  renderRegionBoxList();
  renderCandidateEdits();
  const canvas = stage.querySelector('.overview-canvas');
  const image = canvas.querySelector('img');
  const drag = canvas.querySelector('.dragging');
  let start = null;
  canvas.onpointerdown = event => {
    if (!state.roiMode || event.button !== 0) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    start = imagePoint(event, image, item);
    drag.hidden = false;
  };
  canvas.onpointermove = event => {
    if (!start) return;
    const end = imagePoint(event, image, item);
    drag.setAttribute('x', Math.min(start[0], end[0]));
    drag.setAttribute('y', Math.min(start[1], end[1]));
    drag.setAttribute('width', Math.abs(start[0] - end[0]));
    drag.setAttribute('height', Math.abs(start[1] - end[1]));
  };
  canvas.onpointerup = event => {
    if (!start) return;
    const end = imagePoint(event, image, item);
    const box = [Math.floor(Math.min(start[0], end[0])), Math.floor(Math.min(start[1], end[1])),
      Math.ceil(Math.max(start[0], end[0])), Math.ceil(Math.max(start[1], end[1]))];
    start = null;
    if (box[2] - box[0] < 30 || box[3] - box[1] < 30) {
      drag.hidden = true; toast('请框选更大的区域', true); return;
    }
    const regionId = $('newRegionId').value.trim();
    action(async () => {
      const saved = await api('/api/region-boxes', {sample_id: state.sample,
        image_id: item.image_id, region_id: regionId, box});
      state.regionBoxes.push({region_id: saved.region_id, x1: box[0], y1: box[1], x2: box[2], y2: box[3]});
      state.regionBoxes.sort((a, b) => a.region_id.localeCompare(b.region_id));
      state.roiMode = false;
      $('selectRoi').textContent = '添加区域框（画完自动保存）';
      $('newRegionId').value = nextRegionId();
      $('detectNote').textContent = `区域框 ${saved.region_id} 已自动保存到当前样品；可继续画框或识别。`;
      focusRegionBox(box);
    });
  };
  canvas.onpointercancel = () => { start = null; drag.hidden = true; };
}

renderImage = function () {
  const item = selectedImage();
  const stage = $('imageStage');
  if (!item) { stage.innerHTML = ''; renderOverview(null); return; }
  state.image = item.image_id;
  stage.classList.toggle('adding-point', state.addPointMode);
  $('imageRole').textContent = item.role === 'primary' ? '当前：整片主图 · 坐标用于选点定位' : '当前：补充图 · 仅用于局部核对';
  const left = stage.scrollLeft, top = stage.scrollTop;
  const zoom = Number($('imageZoom').value) || 1;
  const sourcePerScreen = item.width_px / (Math.max(stage.clientWidth, 1000) * zoom);
  const confirmed = $('showSavedPads').checked ? state.pads.filter(p => p.image_id === item.image_id &&
    p.x !== null && p.y !== null).map(p =>
      `<circle cx="${p.x}" cy="${p.y}" r="${3 * sourcePerScreen}" fill="none" stroke="#286fbd" stroke-width="${1.3 * sourcePerScreen}" pointer-events="none"><title>${esc(p.pad_id)}</title></circle>`).join('') : '';
  const canRemove = state.candidate !== null && !!state.detected[state.candidate]?.region_id;
  $('removeCandidate').disabled = !canRemove;
  $('removeCandidateHere').disabled = !canRemove;
  const marks = $('showOmCandidates').checked ? state.detected.map((p, i) => {
    if (p.confidence === 'review' && !$('showReviewCandidates').checked) return '';
    const color = p.confidence === 'manual' ? '#267eaa' : p.confidence === 'grid_inferred' ? '#8e5ac7' : p.confidence === 'layout_only' ? '#4b5663' : p.confidence === 'review' ? '#d58228' : '#079a7c';
    const label = p.pad_row ? `${p.layout_unit_id} · 第 ${p.pad_row} 行第 ${p.pad_col} 列 · ${padClassName(p.pad_class)} Pad` : `候选 ${i + 1}`;
    const evidence = p.confidence === 'manual' ? '手动补点' : p.confidence === 'grid_inferred' ? '图像支持的规则格点，须核验' : p.confidence === 'layout_only' ? '仅布局推断，须核验' : p.confidence === 'review' ? '原始待复核点' : '图像检测到的规则格点';
    const selected = state.candidate === i;
    const radius = Math.min(3, Math.max(1.2, Math.min(p.width_px, p.height_px) / sourcePerScreen * .2)) * sourcePerScreen;
    const center = `<circle cx="${p.x}" cy="${p.y}" r="${radius}" fill="${p.confidence === 'layout_only' ? 'none' : color}" stroke="${color}" stroke-width="${p.confidence === 'layout_only' ? 1.1 * sourcePerScreen : 0}" pointer-events="none"><title>${esc(p.region_id || '未分区')} · ${esc(label)} · ${evidence}</title></circle>`;
    const outline = $('showOmOutlines').checked ? `<circle cx="${p.x}" cy="${p.y}" r="${Math.max(3 * sourcePerScreen, Math.min(p.width_px, p.height_px) / 2)}" fill="none" stroke="${color}" stroke-opacity=".65" stroke-width="${.85 * sourcePerScreen}" stroke-dasharray="${3 * sourcePerScreen} ${3 * sourcePerScreen}" pointer-events="none"></circle>` : '';
    const active = selected ? `<circle cx="${p.x}" cy="${p.y}" r="${8 * sourcePerScreen}" fill="none" stroke="#e64d22" stroke-width="${2 * sourcePerScreen}" pointer-events="none"></circle>` : '';
    return outline + center + active;
  }).join('') : '';
  const rectangle = state.regionBoxes.map(box => `<rect class="roi" x="${box.x1}" y="${box.y1}" width="${box.x2-box.x1}" height="${box.y2-box.y1}" style="stroke-width:${2 * sourcePerScreen};fill:none"></rect>`).join('');
  stage.innerHTML = `<div class="image-canvas" style="width:${zoom * 100}%"><img draggable="false" src="/api/image?image_id=${item.image_id}" alt="OM 图像"><svg viewBox="0 0 ${item.width_px} ${item.height_px}" preserveAspectRatio="none">${confirmed}${marks}${rectangle}</svg></div>`;
  renderOverview(item);
  const focus = state.focusBox;
  const position = () => {
    if (focus) {
      const canvas = stage.querySelector('.image-canvas');
      stage.scrollLeft = (focus[0]+focus[2])/2/item.width_px*canvas.clientWidth-stage.clientWidth/2;
      stage.scrollTop = (focus[1]+focus[3])/2/item.height_px*canvas.clientHeight-stage.clientHeight/2;
      state.focusBox = null;
    } else { stage.scrollLeft = left; stage.scrollTop = top; }
  };
  position();
  const image = stage.querySelector('img');
  image.onload = position;
  const selectCandidate = index => {
    state.candidate = index;
    const p = state.detected[state.candidate];
    const grid = p.pad_row ? `${p.layout_unit_id} · 第 ${p.pad_row} 行第 ${p.pad_col} 列 · ${padClassName(p.pad_class)} Pad` : `候选 ${state.candidate + 1}`;
    $('candidateInfo').textContent = `${p.region_id || '未分区'} · ${grid}: (${p.x}, ${p.y})，约 ${p.width_px}×${p.height_px} px，${p.confidence === 'manual' ? '手动补点' : p.confidence === 'grid_inferred' ? '图像支持的格点，须核验' : p.confidence === 'layout_only' ? '仅布局推断，图像证据不足' : p.confidence === 'high' ? '图像检测到的格点' : '待复核'}，形状建议 ${p.shape_guess}`;
    if (p.region_id) $('omRegion').value = p.region_id;
    if (p.region_id) $('viewingRegion').textContent = `当前区域：${p.region_id}`;
    if (p.layout_unit_id) {
      $('omUnit').value = p.layout_unit_id;
      $('omUnitRow').value = p.unit_row;
      $('omUnitCol').value = p.unit_col;
      $('omPadRow').value = p.pad_row;
      $('omPadCol').value = p.pad_col;
      $('omLocal').value = `r${String(p.pad_row).padStart(2, '0')}c${String(p.pad_col).padStart(2, '0')}`;
    } else {
      $('omLocal').value = 'P' + String(state.candidate + 1).padStart(2, '0');
    }
    $('omShape').value = p.shape_guess;
    renderImage();
  };
  const handleImageClick = event => {
    if (state.roiMode) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(item.width_px, (event.clientX - rect.left) / rect.width * item.width_px));
    const y = Math.max(0, Math.min(item.height_px, (event.clientY - rect.top) / rect.height * item.height_px));
    $('manualX').value = x.toFixed(1);
    $('manualY').value = y.toFixed(1);
    if (state.addPointMode) { action(async () => addCandidateAt(x, y)); return; }
    if (!$('showOmCandidates').checked) return;
    let nearest = -1, best = Infinity;
    for (let i = 0; i < state.detected.length; i++) {
      const p = state.detected[i];
      if (p.confidence === 'review' && !$('showReviewCandidates').checked) continue;
      const distance = Math.hypot((p.x - x) * rect.width / item.width_px,
                                  (p.y - y) * rect.height / item.height_px);
      if (distance < best) { nearest = i; best = distance; }
    }
    if (nearest >= 0 && best <= 12) selectCandidate(nearest);
  };
  stage.querySelector('svg').onclick = handleImageClick;
  image.onclick = handleImageClick;
};

const originalRefresh = refresh;
refresh = async function () {
  if (state.samplingSample !== state.sample) {
    $('includeLayoutOnly').checked = true;
    state.samplingSample = state.sample;
  }
  if (!state.sample) {
    state.pads = []; state.groups = []; state.images = []; state.plan = [];
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
  await originalRefresh();
  $('deleteTemplate').disabled = !$('templateSelect').value;
  renderSamplingRegions(previousRegions);
  const hierarchy = await api('/api/structure?sample_id=' + encodeURIComponent(state.sample));
  $('sampleStructure').innerHTML = hierarchy.map(region => `<div class="region-summary"><strong>${esc(region.region_id)}</strong> · 版图类型 ${esc(region.layout_type_id)} · ${region.unit_count} 个重复版图 · ${region.pad_count} 个 Pad<div>${region.units.map(unit => `<span class="chip">${esc(unit.layout_unit_id)} (${unit.unit_row ?? '—'}, ${unit.unit_col ?? '—'}) · ${unit.pad_count} Pad</span>`).join('')}</div></div>`).join('') || '<p class="muted">尚未登记区域和重复版图。</p>';
  $('padTable').innerHTML = table(state.pads, ['pad_id', 'region_id', 'layout_type_id', 'layout_unit_id', 'unit_row', 'unit_col', 'pad_local_id', 'pad_row', 'pad_col', 'shape', 'diameter_um', 'width_um', 'height_um', 'area_um2', 'tested', 'usable']);
  $('imageSelect').innerHTML = state.images.map(i => `<option value="${i.image_id}">${i.role === 'primary' ? '★ 主图' : '补充'} · ${esc(i.original_name || i.image_id.slice(0, 8))} · ${i.width_px}×${i.height_px}</option>`).join('');
  const selected = state.images.find(i => i.image_id === previous) || primaryImage() || state.images[0];
  if (selected) {
    $('imageSelect').value = selected.image_id; state.image = selected.image_id;
    await loadRegionBoxes(selected);
    await loadScaleBar(selected);
  } else await loadScaleBar(null);
  $('deleteSample').disabled = false;
  renderPlanImage();
  const plans = state.sample ? await api('/api/plans?sample_id=' + encodeURIComponent(state.sample)) : [];
  $('planHistory').innerHTML = plans.map(p => `<p>方案 #${p.plan_id} · ${esc(p.created_at)} · ${p.mode === 'region' ? '按区域/版图' : '按几何规格'}${p.purpose === 'manual_adjusted' ? ' · 手动调整' : ''} · ${esc(p.regions.join(','))} · ${p.count} 个 · 种子 ${p.seed} · <button type="button" data-plan="${p.plan_id}">在图上查看</button> <a href="/api/task.csv?plan_id=${p.plan_id}">下载 CSV</a></p>`).join('') || '<p class="muted">暂无方案</p>';
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
};

async function refreshDeletedSamples() {
  const archived = await api('/api/deleted-samples');
  $('deletedSelect').innerHTML = archived.map(s => `<option value="${esc(s.sample_id)}">${esc(s.sample_id)} · ${esc(s.deleted_at)}</option>`).join('');
  $('restoreSample').disabled = archived.length === 0;
  $('deleteSample').disabled = !state.sample;
}

const originalLoadSamples = loadSamples;
loadSamples = async function () {
  await originalLoadSamples();
  await refreshDeletedSamples();
};

$('deleteSample').onclick = () => action(async () => {
  const id = state.sample;
  if (!id) throw Error('请先选择样品');
  const counts = await api('/api/sample-counts?sample_id=' + encodeURIComponent(id));
  const message = `删除样品「${id}」？\n关联内容：${counts.pads} 个 Pad、${counts.measurements} 条测试记录、${counts.plans} 份选点方案、${counts.images} 张图片。\n删除后可在“已删除样品”中恢复。`;
  if (!window.confirm(message)) return;
  await api('/api/delete-sample', {sample_id: id});
  state.sample = ''; state.image = null; state.regionBoxes = []; state.plan = [];
  await loadSamples();
  toast(`样品 ${id} 已删除，可在样品与版图页恢复`);
});

$('restoreSample').onclick = () => action(async () => {
  const id = $('deletedSelect').value;
  if (!id) throw Error('没有可恢复的样品');
  await api('/api/restore-sample', {sample_id: id});
  state.sample = id; state.image = null; state.regionBoxes = []; state.plan = [];
  await loadSamples();
  toast(`样品 ${id} 已恢复`);
});

action(refreshDeletedSamples);

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

$('sampleSelect').onchange = () => {
  state.sample = $('sampleSelect').value;
  state.primaryRegionBoxes = []; state.padMapRegion = '';
  state.padMapActiveId = null;
  $('padMapZoom').value = 1;
  $('padMapInfo').textContent = '点击 Pad 查看区域、版图和行列编号。';
  state.image = null; state.regionBoxes = []; state.candidateEdits = []; state.latticeStats = {}; state.detected = []; state.candidate = null;
  state.addPointMode = false; $('clickAddCandidate').textContent = '点击放大图补点';
  $('clickAddCandidateHere').textContent = '点图补点';
  clearPlanSelection(); $('regions').value = '';
  action(refresh);
};
$('imageSelect').onchange = () => action(async () => {
  state.image = $('imageSelect').value;
  state.regionBoxes = []; state.candidateEdits = []; state.latticeStats = {}; state.detected = []; state.candidate = null;
  state.addPointMode = false; $('clickAddCandidate').textContent = '点击放大图补点';
  $('clickAddCandidateHere').textContent = '点图补点';
  await loadRegionBoxes(selectedImage());
  await loadScaleBar(selectedImage());
});
$('imageZoom').oninput = renderImage;
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
$('setPrimary').onclick = () => action(async () => {
  const item = selectedImage();
  if (!item) throw Error('请先选择图片');
  await api('/api/set-primary', {sample_id: state.sample, image_id: item.image_id});
  await refresh(); toast('整片主图已更新');
});
async function detectBoxes(boxes) {
  if ($('detect').disabled) return;
  const item = selectedImage();
  if (!item) { toast('请先选择图片', true); return; }
  if (!boxes.length && item.role === 'primary') { toast('请先添加至少一个区域框', true); return; }
  const targets = boxes.length ? boxes : [{region_id: '', x1: 0, y1: 0, x2: item.width_px, y2: item.height_px}];
  $('detect').disabled = true;
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
      } catch (error) {
        errors.push(`${box.region_id || '当前图片'}：${error.message}`);
      }
      completed++;
      progress.value = completed;
    }
    state.candidate = null;
    const complete = Object.values(state.latticeStats).filter(value => value.applied);
    const layoutOnly = state.detected.filter(p => p.confidence === 'layout_only').length;
    const summary = complete.length ? `已生成 ${state.detected.length} 个规则格点，其中 ${layoutOnly} 个灰色位置仅由布局推断。` : `找到 ${state.detected.length} 个原始候选。`;
    $('detectNote').textContent = `${completed - errors.length}/${completed} 个区域识别完成；${summary}${errors.length ? '失败：' + errors.join('；') : '点击格点可查看版图、行列与大致尺寸。'}`;
    focusRegionBox([targets[0].x1, targets[0].y1, targets[0].x2, targets[0].y2]);
    if (errors.length) toast(errors.join('；'), true);
  } finally {
    $('detect').disabled = false;
    $('sampleSelect').disabled = false;
    $('imageSelect').disabled = false;
    $('selectRoi').disabled = false;
    $('detectProgress').hidden = true;
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
    return `OM calibration: image bar ${bar.label_um} um / ${bar.bar_length_px} px`;
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
  if (!pending.length) { toast(`全部 ${all.length} 个候选 Pad 已入库`); return; }
  const button = $('saveAllCandidates');
  button.disabled = true;
  try {
    const result = await api('/api/pads', {sample_id: state.sample, rows: pending});
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
