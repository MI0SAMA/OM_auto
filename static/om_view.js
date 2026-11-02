let overviewRotationThumb = null;
let overviewRotationImageId = null;

function updateRotationPreview(item, image) {
  const angle = Number($('rotationDegrees').value);
  const preview = $('overviewRotationPreview');
  const canvas = $('overviewStage').querySelector('.overview-canvas');
  const available = !!item && item.role === 'primary';
  $('rotateLeft').disabled = !available;
  $('rotateRight').disabled = !available;
  $('rotationAngle').disabled = !available;
  $('rotationDegrees').disabled = !available;
  $('applyRotation').disabled = !available || !angle || !!state.rotationApplying;
  $('cancelRotation').disabled = !available || !angle || !!state.rotationApplying;
  $('selectRoi').disabled = !available || !!angle || !!state.rotationApplying;
  $('detect').disabled = !!angle || !!state.rotationApplying || !!state.detecting;
  $('regionBoxList').querySelectorAll('[data-action="detect"]').forEach(button => button.disabled = !!angle || !!state.rotationApplying || !!state.detecting);
  if (!preview || !canvas || !angle || !available) {
    if (preview) preview.hidden = true;
    if (canvas) canvas.hidden = false;
    if (!state.rotationApplying) $('rotationStatus').textContent = '先调整角度预览；应用后再画区域框。原图会保留在图片列表中。';
    return;
  }
  canvas.hidden = true;
  preview.hidden = false;
  if (!image?.complete || !image.naturalWidth) {
    $('rotationStatus').textContent = '正在载入主图以预览旋转…';
    return;
  }
  if (!overviewRotationThumb) {
    const scale = Math.min(1, 1400 / Math.max(item.width_px, item.height_px));
    overviewRotationThumb = document.createElement('canvas');
    overviewRotationThumb.width = Math.max(1, Math.round(item.width_px * scale));
    overviewRotationThumb.height = Math.max(1, Math.round(item.height_px * scale));
    overviewRotationThumb.getContext('2d').drawImage(image, 0, 0, overviewRotationThumb.width, overviewRotationThumb.height);
  }
  const radians = angle * Math.PI / 180;
  const w = overviewRotationThumb.width, h = overviewRotationThumb.height;
  preview.width = Math.ceil(Math.abs(w * Math.cos(radians)) + Math.abs(h * Math.sin(radians)));
  preview.height = Math.ceil(Math.abs(w * Math.sin(radians)) + Math.abs(h * Math.cos(radians)));
  const context = preview.getContext('2d');
  context.fillStyle = '#f0f0f0';
  context.fillRect(0, 0, preview.width, preview.height);
  context.translate(preview.width / 2, preview.height / 2);
  context.rotate(radians);
  context.drawImage(overviewRotationThumb, -w / 2, -h / 2);
  $('rotationStatus').textContent = `预览：${Math.abs(angle)}° ${angle > 0 ? '顺时针' : '逆时针'}；点击“应用为新主图”后才能在校正图上画框。`;
}

function renderOverview(item) {
  const stage = $('overviewStage');
  if (!item) {
    stage.innerHTML = ''; $('regionBoxList').innerHTML = ''; $('candidateEditList').innerHTML = '';
    overviewRotationImageId = null; overviewRotationThumb = null;
    $('rotationAngle').value = 0; $('rotationDegrees').value = 0;
    $('roiSizeHint').textContent = '点击“添加区域框”，再在整图上按住鼠标拖动；画框时显示宽高和坐标。';
    updateRotationPreview(null, null);
    return;
  }
  if (overviewRotationImageId !== item.image_id) {
    overviewRotationImageId = item.image_id; overviewRotationThumb = null;
    $('rotationAngle').value = 0; $('rotationDegrees').value = 0;
    $('roiSizeHint').textContent = '点击“添加区域框”，再在整图上按住鼠标拖动；画框时显示宽高和坐标。';
  }
  const rectangle = state.regionBoxes.map(box => {
    const labelY = box.y1 >= 120 ? box.y1 - 28 : Math.min(item.height_px - 20, box.y2 + 75);
    return `<rect x="${box.x1}" y="${box.y1}" width="${box.x2-box.x1}" height="${box.y2-box.y1}"></rect><text x="${box.x1}" y="${labelY}">${esc(box.region_id)}</text>`;
  }).join('');
  stage.innerHTML = `<div class="overview-canvas ${state.roiMode ? 'selecting' : ''}" style="width:min(100%, ${70 * item.width_px / item.height_px}vh)"><img draggable="false" src="/api/image?image_id=${item.image_id}" alt="完整 OM 图缩略图"><svg viewBox="0 0 ${item.width_px} ${item.height_px}" preserveAspectRatio="none">${rectangle}<rect class="dragging" hidden></rect></svg><div class="overview-drag-readout" hidden></div></div><canvas class="overview-rotation-preview" id="overviewRotationPreview" hidden aria-label="旋转预览，应用后才能画区域框"></canvas>`;
  renderRegionBoxList();
  renderCandidateEdits();
  const canvas = stage.querySelector('.overview-canvas');
  const image = canvas.querySelector('img');
  const drag = canvas.querySelector('.dragging');
  const readout = canvas.querySelector('.overview-drag-readout');
  image.onload = () => updateRotationPreview(item, image);
  updateRotationPreview(item, image);
  let start = null;
  canvas.onpointerdown = event => {
    if (!state.roiMode || Number($('rotationDegrees').value) || event.button !== 0) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    start = imagePoint(event, image, item);
    drag.hidden = false;
    readout.hidden = false;
    $('roiSizeHint').textContent = `正在画 ${$('newRegionId').value.trim()}：拖动到区域右下角。`;
  };
  canvas.onpointermove = event => {
    if (!start) return;
    const end = imagePoint(event, image, item);
    const x1 = Math.floor(Math.min(start[0], end[0])), y1 = Math.floor(Math.min(start[1], end[1]));
    const width = Math.ceil(Math.abs(start[0] - end[0]));
    const height = Math.ceil(Math.abs(start[1] - end[1]));
    drag.setAttribute('x', x1); drag.setAttribute('y', y1);
    drag.setAttribute('width', width); drag.setAttribute('height', height);
    readout.textContent = `${width} × ${height} px · (${x1}, ${y1})`;
    readout.style.left = `${Math.max(4, Math.min(image.clientWidth - readout.offsetWidth - 4, (event.clientX - image.getBoundingClientRect().left) + 12))}px`;
    readout.style.top = `${Math.max(4, (event.clientY - image.getBoundingClientRect().top) - 32)}px`;
    $('roiSizeHint').textContent = `正在画 ${$('newRegionId').value.trim()}：${width} × ${height} 原图像素；左上 (${x1}, ${y1})。`;
  };
  canvas.onpointerup = async event => {
    if (!start) return;
    const end = imagePoint(event, image, item);
    const box = [Math.floor(Math.min(start[0], end[0])), Math.floor(Math.min(start[1], end[1])),
      Math.ceil(Math.max(start[0], end[0])), Math.ceil(Math.max(start[1], end[1]))];
    start = null;
    readout.hidden = true;
    if (box[2] - box[0] < 30 || box[3] - box[1] < 30) {
      drag.hidden = true; $('roiSizeHint').textContent = '区域框太小；请至少画 30 × 30 原图像素。'; toast('请框选更大的区域', true); return;
    }
    const regionId = $('newRegionId').value.trim();
    $('roiSizeHint').textContent = `正在保存 ${regionId}：${box[2]-box[0]} × ${box[3]-box[1]} 原图像素…`;
    try {
      const saved = await api('/api/region-boxes', {sample_id: state.sample,
        image_id: item.image_id, region_id: regionId, box});
      state.regionBoxes.push({region_id: saved.region_id, x1: box[0], y1: box[1], x2: box[2], y2: box[3]});
      state.regionBoxes.sort((a, b) => a.region_id.localeCompare(b.region_id));
      state.roiMode = false;
      $('selectRoi').textContent = '添加区域框（画完自动保存）';
      $('newRegionId').value = nextRegionId();
      $('detectNote').textContent = `区域框 ${saved.region_id} 已自动保存到当前样品；可继续画框或识别。`;
      $('roiSizeHint').textContent = `已保存 ${saved.region_id}：${box[2]-box[0]} × ${box[3]-box[1]} 原图像素；左上 (${box[0]}, ${box[1]})。`;
      await refresh();
      focusRegionBox(box);
    } catch (error) {
      drag.hidden = true;
      $('roiSizeHint').textContent = `保存区域框失败：${error.message}`;
      toast(error.message, true);
    }
  };
  canvas.onpointercancel = () => { start = null; drag.hidden = true; readout.hidden = true; };
}

function renderImage(options = {}) {
  const item = selectedImage();
  const stage = $('imageStage');
  if (!item) { stage.innerHTML = ''; renderOverview(null); return; }
  state.image = item.image_id;
  stage.classList.toggle('adding-point', state.addPointMode);
  stage.classList.toggle('drawing-scale', state.scaleDrawMode);
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
    const color = p.confidence === 'manual' ? '#267eaa' : p.confidence === 'grid_inferred' ? '#8e5ac7' : p.confidence === 'layout_only' ? '#4b5663' : p.confidence === 'review' ? '#d58228' : '#d91f32';
    const label = p.pad_row ? `${p.layout_unit_id} · 第 ${p.pad_row} 行第 ${p.pad_col} 列 · ${padClassName(p.pad_class)} Pad` : `候选 ${i + 1}`;
    const evidence = p.confidence === 'manual' ? '手动补点' : p.confidence === 'grid_inferred' ? '图像支持的规则格点，须核验' : p.confidence === 'layout_only' ? '仅布局推断，须核验' : p.confidence === 'review' ? '原始待复核点' : '图像检测到的规则格点';
    const selected = state.candidate === i;
    const radius = Math.min(2.6, Math.max(1.5, Math.min(p.width_px, p.height_px) / sourcePerScreen * .2)) * sourcePerScreen;
    const hollow = p.confidence === 'layout_only';
    const center = `<circle cx="${p.x}" cy="${p.y}" r="${radius}" fill="${hollow ? 'none' : color}" stroke="${hollow ? color : '#fff'}" stroke-width="${(hollow ? 1.1 : .9) * sourcePerScreen}" pointer-events="none"><title>${esc(p.region_id || '未分区')} · ${esc(label)} · ${evidence}</title></circle>`;
    const outline = $('showOmOutlines').checked ? `<circle cx="${p.x}" cy="${p.y}" r="${Math.max(3 * sourcePerScreen, Math.min(p.width_px, p.height_px) / 2)}" fill="none" stroke="${color}" stroke-opacity=".65" stroke-width="${.85 * sourcePerScreen}" stroke-dasharray="${3 * sourcePerScreen} ${3 * sourcePerScreen}" pointer-events="none"></circle>` : '';
    const active = selected ? `<circle cx="${p.x}" cy="${p.y}" r="${8 * sourcePerScreen}" fill="none" stroke="#182e3e" stroke-width="${3.4 * sourcePerScreen}" pointer-events="none"></circle><circle cx="${p.x}" cy="${p.y}" r="${8 * sourcePerScreen}" fill="none" stroke="#ffdb4d" stroke-width="${1.8 * sourcePerScreen}" pointer-events="none"></circle>` : '';
    return outline + center + active;
  }).join('') : '';
  const rectangle = state.regionBoxes.map(box => `<rect class="roi" x="${box.x1}" y="${box.y1}" width="${box.x2-box.x1}" height="${box.y2-box.y1}" style="stroke-width:${2 * sourcePerScreen};fill:none"></rect>`).join('');
  const scaleLine = state.manualScaleLine && state.scaleBarImage === item.image_id ?
    `<line x1="${state.manualScaleLine[0]}" y1="${state.manualScaleLine[1]}" x2="${state.manualScaleLine[2]}" y2="${state.manualScaleLine[3]}" stroke="#152c39" stroke-width="${5 * sourcePerScreen}" pointer-events="none"/><line x1="${state.manualScaleLine[0]}" y1="${state.manualScaleLine[1]}" x2="${state.manualScaleLine[2]}" y2="${state.manualScaleLine[3]}" stroke="#ffe66a" stroke-width="${2 * sourcePerScreen}" pointer-events="none"/>` : '';
  stage.innerHTML = `<div class="image-canvas" style="width:${zoom * 100}%;aspect-ratio:${item.width_px}/${item.height_px}"><img draggable="false" src="/api/image?image_id=${item.image_id}" alt="OM 图像"><svg viewBox="0 0 ${item.width_px} ${item.height_px}" preserveAspectRatio="none">${confirmed}${marks}${rectangle}${scaleLine}<line id="scaleDragPreview" hidden stroke="#ffe66a" stroke-width="${2 * sourcePerScreen}" pointer-events="none"/></svg></div>`;
  if (!options.skipOverview) renderOverview(item);
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
    if (state.roiMode || state.scaleDrawMode || state.skipNextImageClick) {
      state.skipNextImageClick = false;
      return;
    }
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
  const overlay = stage.querySelector('svg');
  overlay.onclick = handleImageClick;
  let scaleStart = null;
  const scalePoint = event => {
    const rect = overlay.getBoundingClientRect();
    return [Math.max(0, Math.min(item.width_px, (event.clientX - rect.left) / rect.width * item.width_px)),
      Math.max(0, Math.min(item.height_px, (event.clientY - rect.top) / rect.height * item.height_px))];
  };
  overlay.onpointerdown = event => {
    if (!state.scaleDrawMode || event.button !== 0) return;
    event.preventDefault();
    overlay.setPointerCapture(event.pointerId);
    scaleStart = scalePoint(event);
    const line = $('scaleDragPreview');
    line.hidden = false;
    line.setAttribute('x1', scaleStart[0]); line.setAttribute('y1', scaleStart[1]);
    line.setAttribute('x2', scaleStart[0]); line.setAttribute('y2', scaleStart[1]);
  };
  overlay.onpointermove = event => {
    if (!scaleStart) return;
    const point = scalePoint(event), line = $('scaleDragPreview');
    line.setAttribute('x2', point[0]); line.setAttribute('y2', point[1]);
  };
  overlay.onpointerup = event => {
    if (!scaleStart) return;
    const end = scalePoint(event);
    const line = [scaleStart[0], scaleStart[1], end[0], end[1]];
    scaleStart = null;
    $('scaleDragPreview').hidden = true;
    if (Math.hypot(line[2] - line[0], line[3] - line[1]) < 10) {
      toast('拉线太短，请沿标尺完整长度重新画线', true); return;
    }
    state.manualScaleLine = line;
    state.scaleDrawMode = false;
    state.skipNextImageClick = true;
    setTimeout(() => { state.skipNextImageClick = false; }, 0);
    $('drawScaleLine').textContent = '重新拉线标定';
    try {
      applyManualScaleLine();
      renderImage();
    } catch (error) {
      toast(error.message, true);
    }
  };
  overlay.onpointercancel = () => { scaleStart = null; $('scaleDragPreview').hidden = true; };
  image.onclick = handleImageClick;
}
