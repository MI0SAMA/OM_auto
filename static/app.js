/* Shared browser state, API helpers, and read-only view helpers. */
const $ = id => document.getElementById(id);
const state = {sample: '', pads: [], groups: [], images: [], detected: [], candidate: null,
  image: null, plan: []};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

function toast(message, bad = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = 'show' + (bad ? ' error' : '');
  setTimeout(() => { element.className = ''; }, 5000);
}

async function api(path, body) {
  const response = await fetch(path, body ? {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  } : {});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || response.statusText);
  return data;
}

async function action(fn) {
  try { await fn(); }
  catch (error) { toast(error.message, true); }
}

async function filePayload(id) {
  const file = $(id).files[0];
  if (!file) throw Error('请先选择文件');
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return {filename: file.name, data};
}

function table(records, fields) {
  if (!records.length) return '<p class="muted">暂无数据</p>';
  const head = fields.map(field => `<th>${esc(field)}</th>`).join('');
  const body = records.map(record => `<tr>${fields.map(field =>
    `<td>${esc(record[field])}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderPadTable() {
  const details = document.querySelector('.pad-table-details');
  if (!details?.open) { $('padTable').innerHTML = ''; return; }
  $('padTable').innerHTML = table(state.pads, ['pad_id', 'region_id', 'layout_type_id',
    'layout_unit_id', 'unit_row', 'unit_col', 'pad_local_id', 'pad_row', 'pad_col',
    'shape', 'diameter_um', 'width_um', 'height_um', 'area_um2', 'tested', 'usable']);
}

async function fetchSampleData(sampleId) {
  const query = encodeURIComponent(sampleId);
  const [pads, groups, measurements, plans, images, templates] = await Promise.all([
    api('/api/pads?sample_id=' + query),
    api('/api/groups?sample_id=' + query),
    api('/api/measurements?sample_id=' + query),
    api('/api/plans?sample_id=' + query),
    api('/api/images?sample_id=' + query),
    api('/api/templates')
  ]);
  return {pads, groups, measurements, plans, images, templates};
}

async function loadSamples() {
  const samples = await api('/api/samples');
  state.availableSamples = samples.map(sample => sample.sample_id);
  const previous = state.initialized ? state.sample :
    (new URLSearchParams(window.location.search).get('sample') || '');
  const select = $('sampleSelect');
  select.innerHTML = '<option value="">选择样品</option>' + samples.map(sample =>
    `<option value="${esc(sample.sample_id)}">${esc(sample.sample_id)}</option>`).join('');
  state.sample = samples.some(sample => sample.sample_id === previous)
    ? previous : '';
  select.value = state.sample;
  await refresh();
  await refreshDeletedSamples();
}

function renderFallbackPads() {
  const located = state.pads.filter(pad => pad.x !== null && pad.y !== null);
  if (!located.length) {
    $('padPlot').innerHTML = '<p class="muted">没有坐标记录</p>';
  } else {
    const xs = located.map(pad => pad.x), ys = located.map(pad => pad.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const sx = x => 30 + (x - minX) / (maxX - minX || 1) * 740;
    const sy = y => 30 + (y - minY) / (maxY - minY || 1) * 420;
    const chosen = new Set(state.plan.map(pad => pad.pad_id));
    const marks = located.map(pad => `<circle cx="${sx(pad.x)}" cy="${sy(pad.y)}" r="${chosen.has(pad.pad_id) ? 8 : 5}" fill="${chosen.has(pad.pad_id) ? '#ee7934' : pad.tested ? '#778a97' : pad.usable ? '#249a91' : '#c64e55'}"><title>${esc(pad.pad_id)} · ${esc(pad.region_id)} / ${esc(pad.layout_unit_id)}</title></circle>`).join('');
    const zoom = Number($('padMapZoom').value) || 1;
    const width = Math.max(800, $('padPlot').clientWidth - 20) * zoom;
    $('padPlot').innerHTML = `<div class="pad-map-canvas" style="width:${width}px;height:${width * .6}px"><svg viewBox="0 0 800 480" aria-label="Pad 空间分布">${marks}</svg></div><p class="muted">绿色可用，橙色选中，灰色已测，红色排除</p>`;
  }
  renderPadTable();
}

function enableCanvasPanZoom(viewport, slider, render, {leftDrag = true} = {}) {
  let drag = null;
  let suppressClick = false;
  let wheelFrame = 0;
  let pendingZoom = null;
  let wheelPoint = null;

  viewport.addEventListener('dragstart', event => event.preventDefault());
  viewport.addEventListener('mousedown', event => {
    if (event.button === 1) event.preventDefault();
  });
  viewport.addEventListener('auxclick', event => {
    if (event.button === 1) event.preventDefault();
  });
  viewport.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || (event.button !== 1 && !(leftDrag && event.button === 0))) return;
    const middle = event.button === 1;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY,
      left: viewport.scrollLeft, top: viewport.scrollTop, moved: middle, middle};
    if (middle) {
      event.preventDefault();
      viewport.classList.add('is-panning');
      viewport.setPointerCapture(event.pointerId);
    }
  });
  viewport.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      viewport.classList.add('is-panning');
      viewport.setPointerCapture(event.pointerId);
    }
    viewport.scrollLeft = drag.left - dx;
    viewport.scrollTop = drag.top - dy;
    event.preventDefault();
  });
  function stopPan(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved && !drag.middle) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }
    viewport.classList.remove('is-panning');
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    drag = null;
  }
  viewport.addEventListener('pointerup', stopPan);
  viewport.addEventListener('pointercancel', stopPan);
  viewport.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  viewport.addEventListener('wheel', event => {
    if (!viewport.querySelector('.image-canvas, .pad-map-canvas')) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    const current = pendingZoom ?? Number(slider.value);
    pendingZoom = Math.max(Number(slider.min), Math.min(Number(slider.max), current * Math.exp(-delta * .0015)));
    wheelPoint = {x: event.clientX, y: event.clientY};
    if (wheelFrame) return;
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = 0;
      const oldCanvas = viewport.querySelector('.image-canvas, .pad-map-canvas');
      if (!oldCanvas) { pendingZoom = null; return; }
      const oldRect = oldCanvas.getBoundingClientRect();
      const anchorX = wheelPoint.x - oldRect.left;
      const anchorY = wheelPoint.y - oldRect.top;
      slider.value = pendingZoom.toFixed(2);
      pendingZoom = null;
      render();
      const newCanvas = viewport.querySelector('.image-canvas, .pad-map-canvas');
      if (!newCanvas) return;
      const newRect = newCanvas.getBoundingClientRect();
      viewport.scrollLeft += newRect.left + anchorX * newRect.width / oldRect.width - wheelPoint.x;
      viewport.scrollTop += newRect.top + anchorY * newRect.height / oldRect.height - wheelPoint.y;
    });
  }, {passive: false});
}

function renderGroups() {
  const select = $('groupSelect'), current = select.value;
  select.innerHTML = state.groups.map(group =>
    `<option value="${group.id}">${group.id} ${group.shape} ${group.dimensions_um.map(size => size.toFixed(1)).join('×')} µm · 可用 ${group.available}</option>`).join('');
  if (state.groups.some(group => group.id === current)) select.value = current;
  const analysis = $('analysisGroup'), analysisCurrent = analysis.value;
  analysis.innerHTML = '<option value="">全部规格（仅描述性）</option>' + state.groups.map(group =>
    `<option value="${group.id}">${group.id} ${group.shape} ${group.dimensions_um.map(size => size.toFixed(1)).join('×')} µm</option>`).join('');
  analysis.value = analysisCurrent;
  const group = state.groups.find(item => item.id === select.value);
  $('groupInfo').innerHTML = group
    ? `<p>总数 ${group.total}；已测 ${group.tested}；可用 ${group.available}；覆盖 ${group.regions.length} 个 Region、${group.unit_count} 个 Unit</p>`
    : '<p class="muted">无已知尺寸的几何组</p>';
  if (group && !$('regions').value) $('regions').value = group.regions.join(',');
}

async function summary() {
  if (!state.sample) return;
  let query = 'sample_id=' + encodeURIComponent(state.sample);
  const regions = $('analysisRegions').value.trim();
  if (regions) query += '&regions=' + encodeURIComponent(regions);
  const group = $('analysisGroup').value;
  if (group) query += '&group_id=' + encodeURIComponent(group);
  const result = await api('/api/summary?' + query);
  const percent = value => value === null ? '—' : (value * 100).toFixed(1) + '%';
  const metric = (name, data, unit) => `<div class="stat">${name}<strong>${data ? data.mean.toFixed(2) : '—'}</strong>${unit} · 有效数据 ${data?.n || 0}</div>`;
  $('summary').innerHTML = `<div class="stat">已测<strong>${result.tested}</strong>Pad</div><div class="stat">有效<strong>${result.valid}</strong>${percent(result.valid_rate)}</div><div class="stat">有效率 95% Wilson CI<strong>${result.valid_rate_ci95 ? result.valid_rate_ci95.map(percent).join('–') : '—'}</strong></div><div class="stat">击穿率<strong>${percent(result.breakdown_rate)}</strong></div>${metric('Pr', result.pr_uc_cm2, 'µC/cm²')}${metric('Ec', result.ec_mv_cm, 'MV/cm')}<p>${esc(result.note)}</p><h2>状态计数</h2>${table(Object.entries(result.status_counts).map(([status, count]) => ({status, count})), ['status', 'count'])}<h2>各区域</h2>${table(Object.entries(result.by_region).map(([region, data]) => ({region, ...data, rate: percent(data.rate)})), ['region', 'tested', 'valid', 'rate'])}`;
}
