/* Sample library, workflow navigation, and explicit region review status. */
const WORK_STEPS = ['samples', 'om', 'review', 'sample', 'results'];
const WORK_LABELS = ['主图', '区域框', '核对', '选点', '结果'];
let historyPage = 1;
let historyTimer = null;
let historyRequest = 0;

function requestedView() {
  const view = new URLSearchParams(location.search).get('view');
  return WORK_STEPS.includes(view) ? view : 'library';
}

function writeWorkspaceUrl(view, replace = false) {
  const url = new URL(location.href);
  if (view === 'library' || !state.sample) {
    url.searchParams.delete('sample');
    url.searchParams.delete('view');
  } else {
    url.searchParams.set('sample', state.sample);
    url.searchParams.set('view', view);
  }
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

function activateView(view, updateUrl = true) {
  if (!WORK_STEPS.includes(view) || !state.sample) view = 'library';
  document.querySelectorAll('section.tab').forEach(tab => tab.classList.toggle('active', tab.id === view));
  document.querySelectorAll('nav button[data-tab]').forEach(button =>
    button.classList.toggle('active', button.dataset.tab === view));
  document.body.classList.toggle('library-view', view === 'library');
  $('workContext').hidden = view === 'library';
  $('stepNotice').hidden = true;
  if (updateUrl) writeWorkspaceUrl(view);
  if (view === 'library') {
    syncLibraryPadMap();
    action(refreshLibrary);
  }
  else {
    renderWorkspaceStatus();
    requestAnimationFrame(() => {
      if (view === 'om') renderOverview(selectedImage());
      if (view === 'review') {
        if (state.focusBox) focusRegionBox(state.focusBox);
        else renderImage();
      }
      if (view === 'sample') renderPlanImage();
    });
  }
}

function navigateView(view) { activateView(view, true); }

function syncLibraryPadMap() {
  const card = $('libraryPadMap');
  card.hidden = !state.sample;
  if (!state.sample) return;
  $('libraryPadMapTitle').textContent = `当前样品：${state.sample} · ${state.pads.length} 个 Pad。点击图上的 Pad 查看区域、版图和行列编号。`;
  requestAnimationFrame(renderPads);
}

function renderWorkspaceStatus() {
  if (!state.sample) return;
  const primary = primaryImage();
  const regions = state.structure || [];
  const confirmed = regions.filter(region => !!region.reviewed_at).length;
  $('workSampleName').textContent = state.sample;
  $('workSampleMeta').textContent = `${state.images.length} 张图 · ${regions.length} 个区域 · ${state.pads.length} 个 Pad`;
  const values = [!!primary, state.regionBoxes.length > 0, confirmed > 0,
    (state.plans || []).length > 0, (state.measurements || []).length > 0];
  $('stepProgress').innerHTML = WORK_LABELS.map((label, index) =>
    `<span class="progress-chip ${values[index] ? 'has-data' : ''}">${index + 1} ${label}${index === 2 && regions.length ? ` ${confirmed}/${regions.length}` : ''}</span>`).join('');
  $('setupImagePreview').innerHTML = primary
    ? `<img src="/api/image?image_id=${encodeURIComponent(primary.image_id)}" alt="当前整片主图"><span>整片主图 · ${esc(primary.original_name || primary.image_id)}</span>`
    : '<div class="empty-state">尚无整片主图。上传 ZHENGPIAN.jpg，或将已有图片设为主图。</div>';
  renderReviewRegions();
  const active = document.querySelector('section.tab.active')?.id;
  let message = '', target = '';
  if (active === 'om' && !primary) { message = '先上传或指定整片主图，才能在完整图上画区域框。'; target = 'samples'; }
  if (active === 'om' && primary && selectedImage()?.role !== 'primary') {
    message = '当前选择的是补充图。请在建档步骤切换到整片主图，再画区域框。'; target = 'samples';
  }
  if (active === 'review' && !state.regionBoxes.length) {
    message = state.pads.length
      ? '该样品的 Pad 来自导入表，暂无可对照的主图区域框；仍可逐区域确认数据，确认时会再次提示。'
      : '先在整片图上添加区域框并识别。';
    target = state.pads.length ? 'samples' : 'om';
  }
  if (active === 'sample' && !state.pads.length) { message = '先导入 Pad 表，或完成图像核对并保存 Pad。'; target = 'samples'; }
  if (active === 'results' && !state.pads.length) { message = '结果必须匹配已保存的 Pad；请先导入或保存 Pad。'; target = 'samples'; }
  const notice = $('stepNotice');
  notice.hidden = !message;
  if (message) {
    notice.innerHTML = `${esc(message)} <button type="button" data-go="${target}">前往${esc(WORK_LABELS[WORK_STEPS.indexOf(target)])}</button>`;
    notice.querySelector('button').onclick = () => navigateView(target);
  }
}

function markRegionUnreviewed(regionId) {
  const region = (state.structure || []).find(item => item.region_id === regionId);
  if (region) region.reviewed_at = null;
  renderWorkspaceStatus();
}

function renderReviewRegions() {
  const target = $('reviewRegionList');
  if (!target) return;
  const regions = state.structure || [];
  target.innerHTML = regions.length ? regions.map(region =>
    `<div class="review-region"><div><strong>${esc(region.region_id)}</strong><span class="review-state ${region.reviewed_at ? 'confirmed' : ''}">${region.reviewed_at ? '已核对' : '待核对'}</span><small>${region.pad_count} 个已保存 Pad · ${region.unit_count} 个重复版图</small></div><div class="review-region-actions"><button type="button" class="minor" data-focus="${esc(region.region_id)}">定位</button><button type="button" data-review="${esc(region.region_id)}" data-confirm="${region.reviewed_at ? 'false' : 'true'}" ${region.pad_count ? '' : 'disabled'}>${region.reviewed_at ? '撤销确认' : '核对完成'}</button></div></div>`).join('') : '<p class="muted">暂无区域。请先在整片图上画框。</p>';
  target.querySelectorAll('[data-focus]').forEach(button => button.onclick = () => {
    const box = state.regionBoxes.find(item => item.region_id === button.dataset.focus);
    if (box) focusRegionBox([box.x1, box.y1, box.x2, box.y2]);
    else toast('当前图片没有该区域框；可在样品与版图查看已导入的 Pad。', true);
  });
  target.querySelectorAll('[data-review]').forEach(button => button.onclick = () => action(async () => {
    const confirmed = button.dataset.confirm === 'true';
    if (confirmed && !primaryImage() && !window.confirm('当前样品没有整片主图，无法对照 OM 图核验。仍要确认该区域的 Pad 数据吗？')) return;
    await api('/api/region-review', {sample_id: state.sample,
      region_id: button.dataset.review, confirmed});
    await refresh();
    await refreshLibrary();
    toast(confirmed ? '区域核对状态已保存' : '已撤销区域核对确认');
  }));
}

function formatActivity(timestamp) {
  if (!timestamp) return '时间未知';
  const date = new Date(timestamp.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString('zh-CN', {hour12: false});
}

async function refreshLibrary() {
  const request = ++historyRequest;
  const query = new URLSearchParams({q: $('historySearch').value.trim(),
    scope: $('historyScope').value, page: historyPage, page_size: 25});
  const data = await api('/api/sample-overview?' + query);
  if (request !== historyRequest) return;
  const target = $('historyList');
  target.innerHTML = data.items.map(item => {
    const counts = `${item.region_count} 区域 · 已核对 ${item.confirmed_region_count} · ${item.image_count} 图 · ${item.pad_count} Pad · ${item.plan_count} 方案 · ${item.measurement_count} 结果`;
    const actionButton = item.deleted_at
      ? `<button type="button" data-restore="${esc(item.sample_id)}">恢复样品</button>`
      : `<button type="button" class="minor" data-map="${esc(item.sample_id)}">查看 Pad 分布</button><button type="button" data-open="${esc(item.sample_id)}">进入工作台</button>`;
    return `<div class="history-item"><div><strong>${esc(item.sample_id)}</strong><span class="muted">${esc(item.recipe_id || '未填工艺编号')}</span><p>${esc(counts)}</p><small>最近活动：${esc(formatActivity(item.last_activity_at))}</small></div><div class="history-item-actions">${actionButton}</div></div>`;
  }).join('') || '<div class="empty-state">没有符合条件的样品。</div>';
  $('historyPageInfo').textContent = `第 ${data.page} / ${Math.max(1, Math.ceil(data.total / data.page_size))} 页 · 共 ${data.total} 个`;
  $('historyPrev').disabled = data.page <= 1;
  $('historyNext').disabled = data.page * data.page_size >= data.total;
  target.querySelectorAll('[data-open]').forEach(button => button.onclick = () =>
    action(async () => { if (await selectSample(button.dataset.open)) navigateView('samples'); }));
  target.querySelectorAll('[data-map]').forEach(button => button.onclick = () => action(async () => {
    if (!await selectSample(button.dataset.map)) return;
    navigateView('library');
    requestAnimationFrame(() => $('libraryPadMap').scrollIntoView({behavior: 'smooth', block: 'start'}));
  }));
  target.querySelectorAll('[data-restore]').forEach(button => button.onclick = () => action(async () => {
    await api('/api/restore-sample', {sample_id: button.dataset.restore});
    await loadSamples(); await refreshLibrary();
    toast('样品已恢复');
  }));
}

async function bootstrapWorkspace() {
  await loadSamples();
  state.initialized = true;
  await refreshLibrary();
  activateView(requestedView(), false);
  if (requestedView() !== 'library' && !state.sample) writeWorkspaceUrl('library', true);
}

document.querySelectorAll('nav button[data-tab]').forEach(button => button.onclick = () => navigateView(button.dataset.tab));
$('homeButton').onclick = () => navigateView('library');
$('historySearch').oninput = () => {
  clearTimeout(historyTimer); historyPage = 1;
  historyTimer = setTimeout(() => action(refreshLibrary), 250);
};
$('historyScope').onchange = () => { historyPage = 1; action(refreshLibrary); };
$('historyPrev').onclick = () => { historyPage--; action(refreshLibrary); };
$('historyNext').onclick = () => { historyPage++; action(refreshLibrary); };
document.querySelector('.pad-table-details').addEventListener('toggle', renderPadTable);
enableCanvasPanZoom($('planImage'), $('planZoom'), renderPlanImage);
enableCanvasPanZoom($('padPlot'), $('padMapZoom'), renderPads);
enableCanvasPanZoom($('imageStage'), $('imageZoom'), () => renderImage({skipOverview: true}), {leftDrag: false});
window.addEventListener('beforeunload', event => {
  if (!state.candidatesDirty) return;
  event.preventDefault(); event.returnValue = '';
});
window.addEventListener('popstate', () => action(async () => {
  const wanted = new URLSearchParams(location.search).get('sample') || '';
  if (wanted && !state.availableSamples.includes(wanted)) {
    if (!await selectSample('')) {
      writeWorkspaceUrl(document.querySelector('section.tab.active')?.id || 'library', true);
      return;
    }
    activateView('library', false);
    writeWorkspaceUrl('library', true);
    return;
  }
  if (wanted !== state.sample && !await selectSample(wanted)) {
    writeWorkspaceUrl(document.querySelector('section.tab.active')?.id || 'library', true);
    return;
  }
  activateView(requestedView(), false);
}));
