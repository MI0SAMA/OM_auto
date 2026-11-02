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
