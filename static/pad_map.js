function padOrdinal(pad) {
  const unitPads = state.pads.filter(p => p.region_id === pad.region_id &&
    p.layout_unit_id === pad.layout_unit_id).sort((a, b) =>
      (a.pad_row ?? Infinity) - (b.pad_row ?? Infinity) ||
      (a.pad_col ?? Infinity) - (b.pad_col ?? Infinity) ||
      a.pad_local_id.localeCompare(b.pad_local_id, undefined, {numeric: true}));
  return {index: unitPads.findIndex(p => p.pad_id === pad.pad_id) + 1, total: unitPads.length};
}

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

function renderPads() {
  if (!state.sample || $('libraryPadMap').hidden || !$('library').classList.contains('active')) return;
  const image = primaryImage();
  if (!image) {
    const previousLeft = $('padPlot').scrollLeft, previousTop = $('padPlot').scrollTop;
    renderFallbackPads();
    $('padPlot').scrollLeft = previousLeft; $('padPlot').scrollTop = previousTop;
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
}

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
window.addEventListener('resize', () => {
  if ($('library').classList.contains('active') && state.sample) requestAnimationFrame(renderPads);
});
