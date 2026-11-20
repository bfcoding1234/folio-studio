import { aiPmDefaults as defaults, quickAiPm } from './presets.mjs';
import { buildPages, inspectMarkdown } from './pages.js';
import { api, isLocalImageURL, sanitizeCoverURL, uploadImageFile } from './studio/api.js';

const $ = id => document.getElementById(id);

const SAMPLES = [
  { src: '/assets/shoes.png', name: '帆布鞋 · 去底', origin: '示例' },
  { src: '/assets/context.png', name: '上下文取景框', origin: '示例' }
];

const IMAGE_STYLES = {
  ink: '去底线描：透明背景、墨线、极少量同色系强调，不要文字、边框或阴影',
  collage: '复古编辑纸张拼贴，细微纸纹与留白、单一强调色，不要文字',
  photo: '克制的编辑摄影，真实自然光、清晰主体，不要文字或水印',
  diagram: '简洁编辑图解，结构明确、少色、只有必要的图形，不要生成文字标签'
};

const PAGE_KINDS = { cover: '封面', body: '正文', hero: '主图', ending: '结尾' };
const PRESET_STYLE_KEYS = [
  'column', 'headerRight', 'theme', 'bodyFont', 'titleFont', 'bodySize',
  'lineHeight', 'imageStyle', 'cover', 'ending', 'endingVote',
  'endingLabel', 'endingInvite', 'endingSign'
];
const BASE_PRESET = quickAiPm;

// Workspace state
let project;
let projectRevision = '';
let baseline;
let draft;
let anchor;
let candidate;
let trialMode = 'original';
let mode = 'page';
let pageIndex = 0;
let dirty = false;
let articlePending = false;
let zoom = false;
let captionTimer;

let aiConfigured = false;
let generating = false;
let exporting = false;
let rendering = false;
let renderVersion = 0;
let trialVersion = 0;

let saveTimer;
let saveVersion = 0;
let writeQueue = Promise.resolve();
let toastTimer;
let busyUpload = false;
let stageSignature = '';
let layoutFrame;
let imageInsertRange;

// Preset & settings state
let presets = [];
let presetsBusy = false;
let presetsLoaded = false;
let presetLoadError = '';
let articleDraft;
let presetDraft;
let settingsSession = 0;
const stalePresets = new Set();

const dialog = $('settings');
const articleFields = [...$('settings-fields').querySelectorAll('[data-setting]')];

function notify(message, { error = false, persist: keepOpen = false } = {}) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!keepOpen) {
    toastTimer = setTimeout(() => { el.hidden = true; }, 4400);
  }
}

function persist() {
  if (!project) return;
  const version = ++saveVersion;
  const snapshot = JSON.parse(JSON.stringify(project));
  $('save-state').textContent = '保存中…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        const headers = projectRevision ? { 'If-Match': projectRevision } : {};
        const res = await api('/api/project', 'PUT', snapshot, headers);
        const etag = res.headers.get('etag');
        if (etag) projectRevision = etag;
        if (version === saveVersion) $('save-state').textContent = '已保存到本机';
      })
      .catch(err => {
        if (version === saveVersion) {
          $('save-state').textContent = err.status === 409 ? '检测到多端冲突' : '保存未完成';
        }
        notify(err.message, { error: true });
      });
  }, 180);
}

function chars() {
  const count = [...$('md').value.replace(/\s/g, '')].length;
  $('char-count').textContent = `${count.toLocaleString()} 字符${dirty ? ' · 待更新预览' : ''}`;
}

function markDirty() {
  if (!project) return;
  project.md = $('md').value;
  dirty = true;
  chars();
  persist();
  buttons();
}

function buttons() {
  const readyToExport = baseline?.pages?.length && !dirty && !rendering && !exporting;
  $('export-all').disabled = !readyToExport;
  $('export-page').disabled = !readyToExport;
  $('refresh').disabled = rendering || !project || !!articleDraft?.uploading;
  $('generate-image').disabled = !aiConfigured || generating || !anchor || dirty;
  $('adopt').disabled = !candidate || !draft || rendering || dirty;
}

function current() {
  return trialMode === 'trial' && draft ? draft : baseline;
}

function blank(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function mount(page, width, inert = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'paper-wrap';
  wrapper.style.width = `${width}px`;
  wrapper.style.height = `${(width * 4) / 3}px`;
  const clone = page.cloneNode(true);
  clone.style.transform = `scale(${width / 1080})`;
  if (inert) {
    clone.inert = true;
    clone.setAttribute('aria-hidden', 'true');
  }
  wrapper.append(clone);
  return wrapper;
}

function titleFor(page, i) {
  return `${String(i + 1).padStart(2, '0')} · ${PAGE_KINDS[page.dataset.kind] ?? '正文'}`;
}

function pageButton(page, i, width, thumb) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = thumb ? 'thumb' : 'griditem';
  const label = document.createElement('span');
  label.className = 'thumb-label';
  label.textContent = titleFor(page, i);
  el.append(mount(page, width, true), label);
  el.setAttribute('aria-label', label.textContent);
  if (pageIndex === i) el.setAttribute('aria-current', 'page');
  el.addEventListener('click', () => selectPage(i));
  return el;
}

function pageByKind(pages, kind) {
  return pages.findIndex(p => p.dataset.kind === kind);
}

function revealPage(container, button) {
  if (!button || !container.clientHeight) return;
  const { top, bottom } = button.getBoundingClientRect();
  const start = container.getBoundingClientRect().top + container.clientTop + 4;
  const end = start + container.clientHeight - 8;
  if (top < start || bottom - top > end - start) container.scrollTop += top - start;
  else if (bottom > end) container.scrollTop += bottom - end;
}

function selectPage(index, keepMode = false) {
  if (index < 0 || index >= (current()?.pages.length ?? 0)) return;
  if (!keepMode) mode = 'page';
  pageIndex = index;
  draw(true);
  const rail = $('rail');
  revealPage(rail, rail.children[index]);
  if (mode === 'grid') {
    const stage = $('stage');
    revealPage(stage, stage.querySelector('.griditem[aria-current=page]'));
  }
}

function jumpToKind(kind) {
  selectPage(pageByKind(current()?.pages ?? [], kind), true);
}

function draw(force = false) {
  const payload = current();
  const stage = $('stage');
  const rail = $('rail');
  const pages = payload?.pages ?? [];
  pageIndex = Math.max(0, Math.min(pageIndex, Math.max(0, pages.length - 1)));
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  const railW = rail.clientWidth;
  const signature = [renderVersion, trialVersion, mode, pageIndex, trialMode, anchor?.id, zoom, stageW, stageH, railW].join(':');
  if (!force && signature === stageSignature) return;
  stageSignature = signature;

  const scroll = stage.scrollTop;
  const railScroll = rail.scrollTop;
  stage.replaceChildren();
  rail.replaceChildren();

  if (!pages.length) {
    stage.append(blank(rendering ? '正在排版…' : '没有页面，请先写一点正文。'));
  } else {
    const thumbWidth = Math.max(35, Math.min(74, railW - 25));
    pages.forEach((page, i) => rail.append(pageButton(page, i, thumbWidth, true)));
    if (mode === 'grid') {
      const grid = document.createElement('div');
      grid.className = 'previews-grid';
      const usable = Math.max(150, stageW - 34);
      const cols = Math.max(1, Math.floor((Math.min(1050, usable) + 13) / 193));
      const w = Math.max(116, Math.min(350, Math.floor((Math.min(1050, usable) - (cols - 1) * 13) / cols) - 26));
      pages.forEach((page, i) => grid.append(pageButton(page, i, w, false)));
      stage.append(grid);
    } else {
      const width = Math.max(
        110,
        Math.floor(zoom ? Math.min(850, stageW - 32) : Math.min(730, stageW - 32, (stageH - 32) * 0.75))
      );
      const paper = mount(pages[pageIndex], width);
      stage.append(paper);
      if (anchor) {
        for (const el of paper.querySelectorAll('[data-block-id]')) {
          if (el.dataset.blockId === anchor.id) el.classList.add('active-block');
        }
      }
      for (const el of paper.querySelectorAll('[data-block-id]')) {
        el.tabIndex = 0;
        el.title = '试配图';
      }
    }
  }

  stage.scrollTop = force && mode === 'page' ? 0 : scroll;
  rail.scrollTop = railScroll;
  $('page-count').textContent = `${pages.length} 页`;
  $('turn-indicator').textContent = pages.length ? `${pageIndex + 1} / ${pages.length}` : '—';
  $('current-kind').textContent = pages.length ? (PAGE_KINDS[pages[pageIndex].dataset.kind] ?? '正文') : '';
  $('zoom-page').textContent = zoom ? '适应窗口' : '放大';
  $('zoom-page').setAttribute('aria-pressed', zoom);
  $('zoom-page').disabled = mode === 'grid';
  $('view-page').setAttribute('aria-pressed', mode === 'page');
  $('view-grid').setAttribute('aria-pressed', mode === 'grid');
  $('prev-page').disabled = pageIndex === 0;
  $('next-page').disabled = pageIndex >= pages.length - 1;
  $('jump-cover').disabled = pageByKind(pages, 'cover') < 0;
  $('jump-ending').disabled = pageByKind(pages, 'ending') < 0;

  const warnings = payload?.warnings ?? [];
  $('warnings').hidden = !warnings.length;
  $('warnings').textContent = warnings.length
    ? `${warnings.slice(0, 3).join(' · ')}${warnings.length > 3 ? `（共 ${warnings.length} 条）` : ''}`
    : '';
  buttons();
}

function scheduleDraw() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => draw());
}

function pageOf(result, id, preferFigure = false) {
  if (!result || !id) return -1;
  for (const [i, p] of result.pages.entries()) {
    const blocks = [...p.querySelectorAll('[data-block-id]')];
    if (blocks.some(n => n.dataset.blockId === id && (!preferFigure || p.dataset.kind === 'hero'))) {
      return i;
    }
  }
  return -1;
}

function gotoAnchor() {
  const res = current();
  let idx = trialMode === 'trial' && candidate?.layout === 'hero' ? pageOf(res, anchor?.id, true) : -1;
  if (idx < 0) idx = pageOf(res, anchor?.id);
  if (idx >= 0) pageIndex = idx;
}

function selectComparison(next) {
  trialMode = next;
  gotoAnchor();
  syncTrial();
  draw(true);
}

function syncTrial() {
  const show = !!anchor;
  $('inspector').hidden = !show;
  $('anchor-text').textContent = anchor?.text || '';
  $('candidate-preview').hidden = !candidate;
  $('layout-controls').hidden = !candidate;
  $('remove-placement').hidden = !anchor || !project.placements[anchor.id];
  if (candidate) {
    $('candidate-img').src = candidate.src;
    $('placement-layout').value = candidate.layout;
    $('placement-caption').value = candidate.caption || '';
  } else {
    $('candidate-img').removeAttribute('src');
  }
  $('trial-banner').hidden = !draft;
  $('trial-original').setAttribute('aria-pressed', trialMode === 'original');
  $('trial-view').setAttribute('aria-pressed', trialMode === 'trial');
  if (draft && baseline) {
    const oldCount = baseline.pages.length;
    const nextCount = draft.pages.length;
    $('trial-delta').textContent = oldCount === nextCount
      ? `页数不变 · ${nextCount} 页，正文已重新排版`
      : `全篇 ${oldCount} → ${nextCount} 页 · 采用后更新分页`;
  }
  buttons();
}

function catalog() {
  return [
    ...SAMPLES,
    ...project.library.filter(x => isLocalImageURL(x?.src) && !SAMPLES.some(y => y.src === x.src))
  ];
}

function drawLibrary() {
  const list = $('library-items');
  list.replaceChildren();
  for (const item of catalog()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = item.name;
    const img = document.createElement('img');
    img.src = item.src;
    img.alt = '';
    const label = document.createElement('span');
    label.textContent = item.name;
    button.append(img, label);
    button.onclick = () => pick(item);
    list.append(button);
  }
}

function addAsset(item) {
  if (!catalog().some(x => x.src === item.src)) {
    project.library.push(item);
    persist();
  }
  drawLibrary();
}

function openTrial(id) {
  if (dirty) {
    notify('先生成预览，再给更新后的段落配图。');
    return;
  }
  const block = baseline?.blocks?.find(x => x.id === id);
  if (!block) return;
  if (anchor?.id === id) {
    $('inspector').hidden = false;
    return;
  }
  ++trialVersion;
  anchor = block;
  candidate = null;
  draft = null;
  trialMode = 'original';
  $('image-prompt').value = '';
  $('trial-status').textContent = '';
  $('library').hidden = false;
  drawLibrary();
  syncTrial();
  draw(true);
  const existing = project.placements[id];
  if (existing?.src) {
    candidate = { ...existing };
    syncTrial();
  }
}

function closeTrial() {
  clearTimeout(captionTimer);
  ++trialVersion;
  anchor = null;
  candidate = null;
  draft = null;
  trialMode = 'original';
  syncTrial();
  draw(true);
}

async function pick(item) {
  if (!anchor || !isLocalImageURL(item.src)) return;
  candidate = {
    src: item.src,
    layout: candidate?.layout || 'spot',
    caption: candidate?.caption || ''
  };
  syncTrial();
  await previewTrial();
}

async function previewTrial() {
  if (!anchor || !candidate || dirty) return;
  const seq = ++trialVersion;
  const data = { ...project, placements: { ...project.placements, [anchor.id]: { ...candidate } } };
  draft = null;
  $('trial-status').textContent = '正在试排…';
  buttons();
  try {
    const result = await buildPages(data, data.placements);
    if (seq !== trialVersion) return;
    draft = result;
    $('trial-status').textContent = '未采用，正式排版未改变。';
    selectComparison('trial');
  } catch (err) {
    if (seq === trialVersion) {
      $('trial-status').textContent = err.message;
      notify('试排未完成：' + err.message, { error: true });
      syncTrial();
    }
  }
}

async function refresh({ keepPosition = true } = {}) {
  const seq = ++renderVersion;
  rendering = true;
  closeTrial();
  buttons();
  $('preview-hint').textContent = '正在按版心测量并分页…';
  const snapshot = JSON.parse(JSON.stringify(project));
  try {
    const result = await buildPages(snapshot, snapshot.placements);
    if (seq !== renderVersion) return;
    baseline = result;
    dirty = articlePending || project.md !== snapshot.md;
    if (!keepPosition) {
      pageIndex = Math.max(0, result.pages.findIndex(x => x.dataset.kind === 'body'));
    }
    const ids = new Set(result.blocks.map(x => x.id));
    const lost = Object.keys(snapshot.placements).filter(id => !ids.has(id)).length;
    if (lost) {
      baseline = {
        ...baseline,
        warnings: [...(baseline.warnings || []), `${lost} 处配图的原段落已改变，图片仍可从素材库重新采用`]
      };
    }
    chars();
    $('preview-hint').textContent = '点击正文段落试配图；不采用就不进成稿。';
    draw(true);
  } catch (err) {
    if (seq === renderVersion) {
      dirty = true;
      notify('排版未完成：' + err.message, { error: true });
      $('preview-hint').textContent = '请检查原稿或设置后重新生成。';
    }
  } finally {
    if (seq === renderVersion) {
      rendering = false;
      buttons();
    }
  }
}

function insert(str, range) {
  const ed = $('md');
  const [start, end] = range || [ed.selectionStart, ed.selectionEnd];
  ed.setRangeText(str, start, end, 'end');
  ed.focus();
  markDirty();
}

async function insertImage(file, range) {
  if (!file || busyUpload) return;
  busyUpload = true;
  const old = $('md').value;
  try {
    const asset = await uploadImageFile(file);
    addAsset(asset);
    const at = old === $('md').value ? range : undefined;
    const alt = asset.name.replace(/[[\]\\\r\n]/g, ' ').replace(/\.[a-z]+$/i, '');
    insert(`\n\n![${alt}](${asset.src})\n\n`, at);
    notify('已插入 Markdown 图片引用，点「生成预览」查看。');
  } catch (err) {
    notify(err.message, { error: true });
  } finally {
    busyUpload = false;
  }
}

function fileAction(inputId, fn) {
  $(inputId).addEventListener('change', e => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (file) fn(file);
  });
}

async function download(one) {
  if (!baseline || dirty || exporting) return;
  if (draft && trialMode === 'trial') {
    notify('当前是试排。先采用，或切到原版再导出。');
    return;
  }
  exporting = true;
  buttons();
  notify(one ? '正在导出 PNG…' : `正在打包全篇 ${baseline.pages.length} 页高清 PNG…`, { persist: true });
  try {
    const title = baseline.title || '纸间';
    const options = {
      html: (one ? [baseline.pages[pageIndex]] : baseline.pages).map(p => p.outerHTML),
      title
    };
    if (one) options.index = 0;
    const res = await api('/api/export', 'POST', options);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || '纸间').replace(/[\\/:*?"<>|]/g, '-')}${one ? '-' + String(pageIndex + 1).padStart(2, '0') + '.png' : '.zip'}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    notify(one ? '本页 PNG 已导出。' : '全篇 PNG 已打包。');
  } catch (err) {
    notify('导出失败：' + err.message, { error: true });
  } finally {
    exporting = false;
    buttons();
  }
}

// Preset & style form helpers
const findPreset = name => presets.find(p => p.name === name);
const articleSelection = () => findPreset($('preset-select').value);
const managerSelection = () => findPreset($('preset-manage-select').value);
const canUpdatePreset = p => p?.editable === true && p.revision != null && p.revision !== '' && !stalePresets.has(p.name);

function mountStyleFields(id, prefix) {
  const root = $(id);
  root.append($('style-fields-template').content.cloneNode(true));
  const fields = Object.fromEntries([...root.querySelectorAll('[data-style]')].map(el => {
    const key = el.dataset.style;
    el.id = prefix + key;
    el.dataset.testid = el.id;
    return [key, el];
  }));
  const notes = [...root.querySelectorAll('[data-note]')];
  notes.forEach((el, i) => { el.id = `${prefix}note-${i + 1}`; });
  const vote = fields.endingVote.closest('.ending-vote');
  vote.id = prefix ? 'preset-ending-vote-option' : 'ending-vote-option';
  const hint = vote.querySelector('p');
  hint.id = prefix ? 'preset-ending-vote-hint' : 'ending-vote-hint';
  fields.endingVote.setAttribute('aria-describedby', hint.id);
  return { fields, notes, vote };
}

const articleStyle = mountStyleFields('article-style-fields', '');
const managerStyle = mountStyleFields('preset-style-fields', 'preset-edit-');

function fillSetting(el, value) {
  if (el.type === 'checkbox') el.checked = value === true;
  else el.value = value ?? '';
}

function readSetting(el, fallback, { strict = true } = {}) {
  if (el.type === 'number') {
    if (!el.checkValidity()) {
      if (!strict) return undefined;
      const parent = el.closest('details');
      if (parent) parent.open = true;
      el.reportValidity();
      throw Error('请先检查字号和行高。');
    }
    return el.valueAsNumber || fallback;
  }
  return el.type === 'checkbox' ? el.checked : el.value.trim();
}

function syncEnding({ fields, vote }, locked = false) {
  vote.hidden = !fields.ending.checked;
  fields.endingVote.disabled = locked || vote.hidden;
}

function fillStyle(editor, settings) {
  for (const key of PRESET_STYLE_KEYS) fillSetting(editor.fields[key], settings[key] ?? BASE_PRESET[key]);
  editor.notes.forEach((el, i) => fillSetting(el, settings.endingActionNotes?.[i] ?? BASE_PRESET.endingActionNotes[i]));
  syncEnding(editor);
}

function readStyle(editor, { strict = true } = {}) {
  const out = {};
  for (const key of PRESET_STYLE_KEYS) {
    const value = readSetting(editor.fields[key], BASE_PRESET[key], { strict });
    if (value !== undefined) out[key] = value;
  }
  out.endingActionNotes = editor.notes.map(el => readSetting(el, '', { strict }));
  return out;
}

function presetFeedback(message, error = false) {
  const status = $('preset-status');
  status.textContent = message;
  status.classList.toggle('error', error);
}

function setCoverPreview(id, src) {
  const img = $(id);
  img.hidden = !src;
  if (src) img.src = src;
  else img.removeAttribute('src');
}

function showArticleCover() {
  const own = articleDraft.coverImage;
  const inherited = articleDraft.presetCoverImage;
  setCoverPreview('cover-preview', own || inherited);
  $('cover-status').textContent = articleDraft.uploading
    ? '正在上传本篇封面…'
    : own
      ? '使用本篇上传的封面图。'
      : inherited
        ? '没有本篇封面图，使用已套用预设的固定封面。'
        : '未设置图片；启用封面时使用文字版。';
  $('cover-clear').disabled = articleDraft.uploading || !own;
  $('cover-pick').disabled = articleDraft.uploading;
  buttons();
  $('article-question-hint').textContent = articleDraft.presetQuestion
    ? `本篇留空时使用预设默认追问：${articleDraft.presetQuestion}`
    : '本篇和预设都留空时，不显示追问。';
}

function showManagerCover() {
  const src = presetDraft?.coverImage || '';
  setCoverPreview('preset-cover-preview', src);
  $('preset-cover-status').textContent = presetDraft?.uploading
    ? '正在上传固定封面…'
    : src
      ? '已设置固定封面图。'
      : '未设置固定图；没有本篇封面时，使用文字版。';
}

function syncPresetControls() {
  const picked = articleSelection();
  const managed = managerSelection();
  const managerLocked = presetsBusy || !presetsLoaded || (!!managed && !canUpdatePreset(managed));
  const editorBusy = presetsBusy || !!presetDraft?.uploading;
  $('preset-select').disabled = presetsBusy || !presets.length;
  $('preset-apply').disabled = presetsBusy || !picked;
  $('preset-reload').disabled = editorBusy;
  $('preset-manage-select').disabled = presetsBusy || !presetsLoaded;
  $('preset-new').disabled = presetsBusy || !presetsLoaded;
  $('preset-editor').hidden = !presetsLoaded;
  $('preset-update').disabled = editorBusy || !canUpdatePreset(managed);
  $('preset-delete').hidden = managed?.editable !== true;
  $('preset-delete').disabled = editorBusy || !canUpdatePreset(managed);
  $('preset-create').disabled = $('preset-name').disabled = editorBusy || !presetsLoaded;
  for (const el of [...Object.values(managerStyle.fields), ...managerStyle.notes, $('preset-edit-question')]) {
    el.disabled = managerLocked;
  }
  syncEnding(managerStyle, managerLocked);
  $('preset-cover-pick').disabled = $('preset-cover-file').disabled = managerLocked || editorBusy;
  $('preset-cover-clear').disabled = managerLocked || editorBusy || !presetDraft?.coverImage;
  syncArticlePresetStatus();
}

function syncArticlePresetStatus() {
  if (!articleDraft) return;
  const hint = $('article-preset-status');
  const picked = articleSelection();
  if (presetsBusy && !presetsLoaded) hint.textContent = '正在读取预设…';
  else if (presetLoadError) hint.textContent = `${presetLoadError} 本篇现有样式仍可使用。`;
  else if (picked && articleDraft.applied) hint.textContent = '点「生成预览」查看本篇所选版式（设置已自动保存）。';
  else if (articleDraft.presetName) {
    const latest = findPreset(articleDraft.presetName);
    hint.textContent = !latest
      ? `本篇保留「${articleDraft.presetName}」的样式快照；列表中已找不到此预设。`
      : (latest.revision ?? '') !== articleDraft.presetRevision
        ? `「${latest.label || latest.name}」有更新，可重新套用。`
        : '已套用，预设更新不会自动改动本篇。';
  } else {
    hint.textContent = '未选预设，保留本篇现有样式。';
  }
}

function fillManagerForm() {
  const p = managerSelection();
  const settings = p?.settings ?? BASE_PRESET;
  presetDraft = { coverImage: sanitizeCoverURL(settings.coverImage), uploading: false };
  fillStyle(managerStyle, settings);
  fillSetting($('preset-edit-question'), settings.question);
  $('preset-name').value = '';
  showManagerCover();
  syncPresetControls();
  if (!p) presetFeedback('新建草稿。填写设置和名称后，点「另存为预设」。');
  else if (!p.editable) presetFeedback('内置预设为只读，可另存一份后再编辑。');
  else if (!canUpdatePreset(p)) presetFeedback('预设版本不可用，请重新读取后再更新。', true);
  else presetFeedback('可编辑此预设，或另存一份。修改不会同步到本篇。');
}

function drawPresetLists(articleName, managerName) {
  const groups = [['内置 · 只读', false], ['自定义', true]];
  for (const [id, selected, placeholder] of [
    ['preset-select', articleName, '选择预设…'],
    ['preset-manage-select', managerName, '新预设草稿']
  ]) {
    const select = $(id);
    select.replaceChildren(new Option(placeholder, ''));
    for (const [label, editable] of groups) {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const p of presets) {
        if (p.editable === editable) group.append(new Option(p.label || p.name, p.name));
      }
      if (group.children.length) select.append(group);
    }
    select.value = findPreset(selected) ? selected : '';
    if (id === 'preset-select') select.options[0].disabled = true;
  }
}

function drawPresetWarnings(warnings = []) {
  const box = $('preset-warnings');
  box.replaceChildren();
  box.hidden = !warnings.length;
  if (!warnings.length) return;
  const label = document.createElement('strong');
  label.textContent = '读取提示';
  const list = document.createElement('ul');
  for (const warning of warnings) {
    const item = document.createElement('li');
    item.textContent = warning;
    list.append(item);
  }
  box.append(label, list);
}

async function loadPresets() {
  if (presetsBusy || presetDraft?.uploading) return;
  const articleName = $('preset-select').value || articleDraft?.presetName;
  const managerName = $('preset-manage-select').value;
  presetsBusy = true;
  presetLoadError = '';
  syncPresetControls();
  presetFeedback('正在读取预设…');
  try {
    const data = await (await api('/api/presets')).json();
    presets = data.presets;
    presetsLoaded = true;
    stalePresets.clear();
    drawPresetLists(articleName, managerName);
    drawPresetWarnings(data.warnings);
    fillManagerForm();
  } catch (err) {
    presets = [];
    presetsLoaded = false;
    drawPresetLists('', '');
    drawPresetWarnings();
    presetLoadError = `读取预设失败：${err.message}`;
    presetFeedback(presetLoadError, true);
  } finally {
    presetsBusy = false;
    syncPresetControls();
  }
}

async function savePreset(p) {
  if (presetsBusy || !presetsLoaded || presetDraft.uploading || (p && !canUpdatePreset(p))) return;
  const nameField = $('preset-name');
  if (!p && !nameField.reportValidity()) return;
  const name = p ? p.name : nameField.value;
  let settings;
  try {
    settings = {
      ...readStyle(managerStyle),
      question: $('preset-edit-question').value.trim(),
      coverImage: presetDraft.coverImage
    };
  } catch (err) {
    presetFeedback(err.message, true);
    return;
  }
  if (settings.ending && !settings.question) {
    presetFeedback('启用互动结尾时，请填写预设默认追问。', true);
    $('preset-edit-question').focus();
    return;
  }
  const session = settingsSession;
  presetsBusy = true;
  syncPresetControls();
  presetFeedback(p ? '正在更新预设…' : '正在另存预设…');
  try {
    const url = p ? `/api/presets/${encodeURIComponent(name)}` : '/api/presets';
    const body = p ? { settings, revision: p.revision } : { name, settings };
    const { preset } = await (await api(url, p ? 'PUT' : 'POST', body)).json();
    presets = presets.filter(item => item.name !== preset.name).concat(preset);
    const sameSession = session === settingsSession && dialog.open;
    drawPresetLists(
      $('preset-select').value || articleDraft?.presetName,
      sameSession ? preset.name : $('preset-manage-select').value
    );
    fillManagerForm();
    presetFeedback(`已${p ? '更新' : '另存'}预设「${preset.name}」，未修改本篇。`);
  } catch (err) {
    if (p && [404, 409, 412].includes(err.status)) {
      stalePresets.add(p.name);
      presetFeedback(`${err.message} 请重新读取预设后再编辑。`, true);
    } else {
      presetFeedback(`${p ? '更新' : '另存'}失败：${err.message}`, true);
    }
  } finally {
    presetsBusy = false;
    syncPresetControls();
  }
}

async function removePreset(p) {
  if (presetsBusy || presetDraft?.uploading || !canUpdatePreset(p)) return;
  if (!confirm(`删除自定义预设「${p.name}」？已保存稿件会保留当前样式。`)) return;
  const articleName = $('preset-select').value || articleDraft?.presetName;
  presetsBusy = true;
  syncPresetControls();
  presetFeedback('正在删除预设…');
  try {
    await api(`/api/presets/${encodeURIComponent(p.name)}/delete`, 'POST', { revision: p.revision });
    presets = presets.filter(item => item.name !== p.name);
    drawPresetLists(articleName, '');
    fillManagerForm();
    presetFeedback(`已删除「${p.name}」，已保存稿件不受影响。`);
  } catch (err) {
    if ([404, 409, 412].includes(err.status)) stalePresets.add(p.name);
    presetFeedback(`删除失败：${err.message}`, true);
  } finally {
    presetsBusy = false;
    syncPresetControls();
  }
}

function commitArticleDraft({ strict = false } = {}) {
  const next = { ...project.settings };
  const styleValues = readStyle(articleStyle, { strict });
  Object.assign(next, styleValues);
  for (const el of articleFields) {
    if (el.value !== articleDraft.initialFields.get(el)) {
      next[el.dataset.setting] = readSetting(el, '', { strict });
      articleDraft.initialFields.set(el, el.value);
    }
  }
  if (articleDraft.coverChanged) {
    next.coverImage = articleDraft.coverImage;
  }
  if (articleDraft.applied) {
    for (const key of ['presetName', 'presetRevision', 'presetCoverImage', 'presetQuestion']) {
      next[key] = articleDraft[key];
    }
  }
  const item = articleDraft.coverAsset;
  if (item && !catalog().some(x => x.src === item.src)) {
    project.library.push(item);
  }
  project.settings = next;
}

function markArticleDirty() {
  if (!project || !articleDraft) return;
  commitArticleDraft({ strict: false });
  articlePending = true;
  dirty = true;
  chars();
  persist();
  buttons();
}

function fillArticleForm() {
  const { settings } = project;
  for (const el of articleFields) fillSetting(el, settings[el.dataset.setting]);
  fillStyle(articleStyle, settings);
  articleDraft = {
    coverImage: sanitizeCoverURL(settings.coverImage),
    presetName: settings.presetName ?? '',
    presetRevision: settings.presetRevision ?? '',
    presetCoverImage: sanitizeCoverURL(settings.presetCoverImage),
    presetQuestion: settings.presetQuestion ?? ''
  };
  articleDraft.initialFields = new Map(articleFields.map(el => [el, el.value]));
  $('title').placeholder = inspectMarkdown(project.md).title || '留空取 Markdown 一级标题';
  drawPresetLists(articleDraft.presetName, $('preset-manage-select').value);
  showArticleCover();
  syncArticlePresetStatus();
}

async function generatePreview(options) {
  if (!project || !articleDraft || articleDraft.uploading || rendering) return;
  if (!articlePending) return refresh(options);
  try {
    commitArticleDraft({ strict: true });
  } catch {
    return; // readSetting reveals and focuses the invalid input.
  }
  articlePending = false;
  fillArticleForm();
  persist();
  return refresh(options);
}

// Event bindings
$('md').addEventListener('input', () => {
  markDirty();
  $('title').placeholder = inspectMarkdown(project.md).title || '留空取 Markdown 一级标题';
});
$('md').addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!$('refresh').disabled) generatePreview();
  }
});
$('md').addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
});
$('md').addEventListener('drop', e => {
  const file = e.dataTransfer.files?.[0];
  if (file?.type.startsWith('image/')) {
    e.preventDefault();
    insertImage(file);
  }
});

$('import-md').onclick = () => $('md-file').click();
fileAction('md-file', async file => {
  if (file.size > 220000) {
    notify('原稿文件过大，建议拆成多篇', { error: true });
    return;
  }
  try {
    const text = await file.text();
    const hasExisting = project.md.trim() || project.settings.title || project.settings.question || project.settings.coverImage;
    if (hasExisting && !confirm('导入新稿将替换当前正文，并重置本篇标题、追问、本篇封面图及配图位置（保留当前预设与素材库）。继续吗？')) {
      return;
    }
    project.placements = {};
    project.settings = { ...project.settings, title: '', question: '', coverImage: '' };
    project.md = text;
    $('md').value = text;
    articlePending = false;
    fillArticleForm();
    markDirty();
    await generatePreview({ keepPosition: false });
  } catch (err) {
    notify(err.message, { error: true });
  }
});

$('insert-break').onclick = () => insert('\n\n<!-- pagebreak -->\n\n');
$('insert-img').onclick = () => {
  imageInsertRange = [$('md').selectionStart, $('md').selectionEnd];
  $('md-image').click();
};
fileAction('md-image', file => insertImage(file, imageInsertRange));
$('refresh').onclick = () => generatePreview();
$('zoom-page').onclick = () => { zoom = !zoom; draw(true); };
$('jump-source').onclick = () => {
  if (anchor) {
    const ed = $('md');
    ed.focus();
    ed.setSelectionRange(anchor.start, anchor.end);
  }
};
$('view-page').onclick = () => { mode = 'page'; draw(true); };
$('view-grid').onclick = () => { mode = 'grid'; draw(true); };
$('prev-page').onclick = () => selectPage(pageIndex - 1);
$('next-page').onclick = () => selectPage(pageIndex + 1);
$('jump-cover').onclick = () => jumpToKind('cover');
$('jump-ending').onclick = () => jumpToKind('ending');

$('stage').addEventListener('click', e => {
  const b = e.target.closest('[data-block-id]');
  if (b && mode === 'page') {
    e.preventDefault();
    openTrial(b.dataset.blockId);
  }
});
$('stage').addEventListener('keydown', e => {
  const b = e.target.closest('[data-block-id]');
  if (b && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openTrial(b.dataset.blockId);
  }
});

$('close-trial').onclick = closeTrial;
$('trial-original').onclick = () => selectComparison('original');
$('trial-view').onclick = () => selectComparison('trial');
$('upload-trial').onclick = () => $('trial-file').click();
fileAction('trial-file', async file => {
  const id = anchor?.id;
  try {
    $('trial-status').textContent = '正在读取图片…';
    const item = await uploadImageFile(file);
    addAsset(item);
    if (anchor?.id === id) await pick(item);
  } catch (err) {
    notify(err.message, { error: true });
    $('trial-status').textContent = err.message;
  }
});
$('show-library').onclick = () => { $('library').hidden = !$('library').hidden; };
$('placement-layout').onchange = () => {
  if (candidate) {
    candidate.layout = $('placement-layout').value;
    previewTrial();
  }
};
$('placement-caption').oninput = () => {
  if (candidate) {
    candidate.caption = $('placement-caption').value;
    draft = null;
    ++trialVersion;
    buttons();
    clearTimeout(captionTimer);
    captionTimer = setTimeout(previewTrial, 350);
  }
};
$('adopt').onclick = async () => {
  if (!anchor || !candidate || !draft || dirty) return;
  project.placements[anchor.id] = { ...candidate };
  baseline = draft;
  persist();
  selectComparison('trial');
  closeTrial();
  notify('已采用，配图随原稿段落移动。');
};
$('discard').onclick = () => {
  closeTrial();
  notify('未更改成稿，图仍留在素材库。');
};
$('remove-placement').onclick = () => {
  if (!anchor) return;
  delete project.placements[anchor.id];
  persist();
  refresh();
};
$('generate-image').onclick = async () => {
  if (!anchor || dirty || generating || !aiConfigured) return;
  const prompt = $('image-prompt').value.trim();
  const id = anchor.id;
  const text = anchor.text;
  if (!confirm('将把当前段落和画面要求发送给已配置的生图服务，可能产生费用。继续生成一张候选图吗？')) return;
  generating = true;
  buttons();
  $('trial-status').textContent = '正在生成候选图，先不改变正式排版…';
  try {
    const theme = { clay: '砖红', blue: '靛蓝', sage: '墨绿' }[project.settings.theme] || '砖红';
    const result = await (await api('/api/generate', 'POST', {
      prompt: prompt || '为此段绘制一种能说明核心意思的视觉主体。',
      text: text.slice(0, 1500),
      style: `${IMAGE_STYLES[project.settings.imageStyle] || IMAGE_STYLES.ink}；强调色：${theme}`,
      layout: candidate?.layout || 'spot',
      background: project.settings.imageStyle === 'ink' ? 'transparent' : 'auto'
    })).json();
    if (!isLocalImageURL(result.src)) throw Error('未收到可用图片');
    const item = { src: result.src, name: prompt.slice(0, 20) || 'AI 候选图', origin: 'AI' };
    addAsset(item);
    if (anchor?.id === id && !dirty) await pick(item);
    else notify('候选图已存入本篇素材库。');
  } catch (err) {
    $('trial-status').textContent = err.message;
    notify(err.message, { error: true });
  } finally {
    generating = false;
    buttons();
  }
};

$('export-all').onclick = () => download(false);
$('export-page').onclick = () => download(true);

$('preset-select').onchange = () => {
  $('preset-apply').onclick();
  syncPresetControls();
};
$('preset-manage-select').onchange = fillManagerForm;
$('preset-new').onclick = () => {
  $('preset-manage-select').value = '';
  fillManagerForm();
  managerStyle.fields.column.focus();
};
$('preset-reload').onclick = loadPresets;
$('preset-create').onclick = () => savePreset();
$('preset-update').onclick = () => {
  const p = managerSelection();
  if (p) savePreset(p);
};
$('preset-delete').onclick = () => {
  const p = managerSelection();
  if (p) removePreset(p);
};
$('preset-apply').onclick = () => {
  const p = articleSelection();
  if (presetsBusy || !p) return;
  fillStyle(articleStyle, p.settings);
  Object.assign(articleDraft, {
    presetName: p.name,
    presetRevision: p.revision ?? '',
    presetCoverImage: sanitizeCoverURL(p.settings.coverImage),
    presetQuestion: p.settings.question ?? '',
    applied: true
  });
  markArticleDirty();
  showArticleCover();
  syncArticlePresetStatus();
};

$('open-settings').onclick = () => {
  if (!project || dialog.open) return;
  settingsSession++;
  $('preset-manager').scrollTop = 0;
  fillManagerForm();
  dialog.showModal();
  loadPresets();
};
$('settings-close').onclick = () => dialog.close();
articleStyle.fields.ending.onchange = () => syncEnding(articleStyle);
$('settings-fields').addEventListener('input', e => {
  if (e.target.matches('[data-setting],[data-style],[data-note]')) markArticleDirty();
});
managerStyle.fields.ending.onchange = () => syncEnding(managerStyle);

$('cover-pick').onclick = () => $('cover-file').click();
$('cover-clear').onclick = () => {
  articleDraft.coverImage = '';
  articleDraft.coverChanged = true;
  articleDraft.coverAsset = null;
  markArticleDirty();
  showArticleCover();
};
fileAction('cover-file', async file => {
  const currentDraft = articleDraft;
  if (!currentDraft || currentDraft.uploading) return;
  currentDraft.uploading = true;
  showArticleCover();
  try {
    const item = await uploadImageFile(file);
    if (currentDraft === articleDraft) {
      currentDraft.coverImage = item.src;
      currentDraft.coverChanged = true;
      currentDraft.coverAsset = item;
      markArticleDirty();
    }
  } catch (err) {
    notify(err.message, { error: true });
  } finally {
    currentDraft.uploading = false;
    if (currentDraft === articleDraft) showArticleCover();
  }
});

$('preset-cover-pick').onclick = () => $('preset-cover-file').click();
$('preset-cover-clear').onclick = () => {
  presetDraft.coverImage = '';
  showManagerCover();
  syncPresetControls();
};
fileAction('preset-cover-file', async file => {
  const currentDraft = presetDraft;
  if (!currentDraft || $('preset-cover-file').disabled || !dialog.open) return;
  currentDraft.uploading = true;
  showManagerCover();
  syncPresetControls();
  try {
    const item = await uploadImageFile(file);
    if (dialog.open && currentDraft === presetDraft) currentDraft.coverImage = item.src;
  } catch (err) {
    if (dialog.open && currentDraft === presetDraft) presetFeedback(err.message, true);
  } finally {
    currentDraft.uploading = false;
    if (dialog.open && currentDraft === presetDraft) {
      showManagerCover();
      syncPresetControls();
    }
  }
});

const obs = new ResizeObserver(scheduleDraw);
obs.observe($('stage'));
obs.observe($('rail'));

async function init() {
  let existing;
  try {
    const res = await api('/api/project');
    projectRevision = res.headers.get('etag') || '';
    existing = await res.json();
    if ('project' in (existing ?? {})) existing = existing.project;
    $('save-state').textContent = existing ? '已读取本地项目' : '示例项目';
  } catch (err) {
    $('save-state').textContent = '本地保存不可用';
    notify(err.message, { error: true });
  }

  const sample = await fetch('/assets/sample.md').then(r => (r.ok ? r.text() : '')).catch(() => '');
  const mutablePlacements = Object.create(null);
  for (const [id, value] of Object.entries(existing?.placements || {})) {
    if (value && isLocalImageURL(value.src)) mutablePlacements[id] = value;
  }

  // Migrate in memory; the saved project is only rewritten on the next normal save.
  const stored = existing?.settings ?? {};
  const settings = existing
    ? { ...defaults, title: '', question: '', coverImage: '', ...stored }
    : { ...defaults };
  if (!Object.hasOwn(stored, 'headerRight') && typeof stored.issue === 'string') {
    settings.headerRight = stored.issue;
  }
  settings.headerRight ??= '';
  settings.endingVote = settings.endingVote === true;
  delete settings.issue;
  delete settings.subtitle;
  delete settings.endQuote;

  project = {
    md: typeof existing?.md === 'string' ? existing.md : sample,
    settings,
    placements: mutablePlacements,
    library: Array.isArray(existing?.library) ? existing.library : []
  };

  $('md').value = project.md;
  chars();
  fillArticleForm();
  loadPresets();

  api('/api/status')
    .then(r => r.json())
    .then(data => {
      aiConfigured = data.aiConfigured === true;
      $('ai-status').textContent = aiConfigured
        ? '生成只添加候选图，不直接改原稿。'
        : '未配置生图密钥；仍可上传图片，或使用本篇素材。';
      buttons();
    })
    .catch(() => {
      $('ai-status').textContent = '生图服务状态不可用。';
    });

  await refresh({ keepPosition: false });
}

init();
