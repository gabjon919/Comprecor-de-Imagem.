'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let images = [];          // Array<ImageItem>
let mode = 'better-quality';
let targetSize = '500';
let targetUnit = 'KB';
let isCompressing = false;
let isZipping = false;
let dragCounter = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dropzone         = $('dropzone');
const fileInput        = $('file-input');
const addMoreInput     = $('add-more-input');
const imageList        = $('image-list');
const btnCompress      = $('btn-compress');
const btnDownload      = $('btn-download');
const btnDownloadLabel = $('btn-download-label');
const btnRecompress    = $('btn-recompress');
const btnClear         = $('btn-clear');
const btnAddMore       = $('btn-add-more');
const progressSection  = $('progress-section');
const progressBar      = $('progress-bar');
const progressLabel    = $('progress-label');
const progressPct      = $('progress-pct');
const resultsSummary   = $('results-summary');
const resultDone       = $('result-done');
const resultSaved      = $('result-saved');
const resultPct        = $('result-pct');
const specificPanel    = $('specific-size-panel');
const targetSizeInput  = $('target-size');
const targetDesc       = $('target-desc');
const fileBar          = $('file-bar');
const fileCount        = $('file-count');
const skippedNotice    = $('skipped-notice');
const largeBatchNotice = $('large-batch-notice');
const dragOverlay      = $('drag-overlay');

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatBytes(bytes, dec = 1) {
  if (!+bytes) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dec))} ${sizes[i]}`;
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function deduplicateFilenames(names) {
  const seen = new Map();
  return names.map(name => {
    const dot = name.lastIndexOf('.');
    const base = dot >= 0 ? name.slice(0, dot) : name;
    const ext  = dot >= 0 ? name.slice(dot) : '';
    const key  = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? name : `${base}_${count}${ext}`;
  });
}

// ── File ingestion ─────────────────────────────────────────────────────────────
const VALID = ['image/jpeg','image/png','image/webp','image/gif'];

function ingestFiles(files) {
  const arr = Array.from(files);
  const valid = arr.filter(f => VALID.includes(f.type));
  const existingKeys = new Set(images.map(img => `${img.file.name}::${img.file.size}`));
  const deduped = valid.filter(f => !existingKeys.has(`${f.name}::${f.size}`));
  const skipped = arr.length - deduped.length;

  if (skipped > 0) showSkippedNotice(skipped);

  deduped.forEach(f => {
    images.push({
      id: uid(),
      file: f,
      thumbnail: URL.createObjectURL(f),
      originalSize: f.size,
      compressedBlob: null,
      compressedSize: null,
      status: 'waiting',
      error: null,
    });
  });

  if (deduped.length > 0) {
    renderAll();
  }
}

let skippedTimer = null;
function showSkippedNotice(count) {
  skippedNotice.className = 'notice notice-amber';
  skippedNotice.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>` +
    `${count} arquivo${count > 1 ? 's' : ''} ignorado${count > 1 ? 's' : ''} — formato invalido ou duplicado`;
  clearTimeout(skippedTimer);
  skippedTimer = setTimeout(() => { skippedNotice.className = 'notice notice-amber hidden'; }, 4000);
}

// ── Compression options ────────────────────────────────────────────────────────
function buildOptions() {
  if (mode === 'better-quality') {
    return { maxSizeMB: 2048, useWebWorker: true, initialQuality: 0.85, alwaysKeepResolution: true };
  }
  if (mode === 'smaller-size') {
    return { maxSizeMB: 2048, useWebWorker: true, initialQuality: 0.60, alwaysKeepResolution: true };
  }
  const sizeNum = Math.max(0.001, parseFloat(targetSize) || 500);
  const sizeMB  = targetUnit === 'KB' ? sizeNum / 1024 : sizeNum;
  return { maxSizeMB: sizeMB, useWebWorker: true, alwaysKeepResolution: true };
}

// ── Compress ──────────────────────────────────────────────────────────────────
async function compressAll() {
  const pending = images.filter(img => img.status === 'waiting' || img.status === 'error');
  if (!pending.length || isCompressing) return;

  const opts = buildOptions();
  isCompressing = true;
  renderAll();

  const total = images.length;
  let done = total - pending.length;

  // mark all pending → compressing
  pending.forEach(img => { img.status = 'compressing'; img.error = null; });
  renderAll();
  updateProgress(done, total);

  const concurrency = 3;
  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    const results = {};

    await Promise.all(batch.map(async item => {
      try {
        const compressed = await imageCompression(item.file, { ...opts, fileType: item.file.type });
        const best = compressed.size < item.file.size ? compressed : item.file;
        results[item.id] = { status: 'done', compressedBlob: best, compressedSize: best.size };
      } catch (err) {
        results[item.id] = { status: 'error', error: err && err.message ? err.message : 'Falha ao comprimir' };
      }
    }));

    // Apply batch results to state — single mutation per batch
    batch.forEach(item => {
      const r = results[item.id];
      if (!r) return;
      Object.assign(item, r);
    });
    done += batch.length;
    updateProgress(done, total);
    renderAll();
  }

  isCompressing = false;
  renderAll();
  showResultsSummary();
}

function updateProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  progressLabel.textContent = `${done} de ${total} concluidas`;
  progressPct.textContent = pct + '%';
}

// ── Download ZIP ──────────────────────────────────────────────────────────────
async function downloadZip() {
  const done = images.filter(img => img.status === 'done' && img.compressedBlob);
  if (!done.length || isZipping) return;
  isZipping = true;
  btnDownload.disabled = true;
  btnDownloadLabel.textContent = 'Gerando ZIP...';

  const names = deduplicateFilenames(done.map(img => img.file.name));
  const zip = new JSZip();
  done.forEach((item, idx) => zip.file(names[idx], item.compressedBlob));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  saveAs(blob, 'compactado.zip');

  isZipping = false;
  btnDownload.disabled = false;
  btnDownloadLabel.textContent = `Baixar Todas (${done.length})`;
}

// ── Results summary ───────────────────────────────────────────────────────────
function showResultsSummary() {
  const done = images.filter(img => img.status === 'done');
  const errors = images.filter(img => img.status === 'error');
  if (!done.length) return;

  const origTotal = done.reduce((a, img) => a + img.originalSize, 0);
  const compTotal = done.reduce((a, img) => a + (img.compressedSize || img.originalSize), 0);
  const saved = Math.max(0, origTotal - compTotal);
  const pct = origTotal ? Math.round((saved / origTotal) * 100) : 0;

  resultDone.textContent = done.length + (errors.length ? ` (${errors.length} com erro)` : '');
  resultSaved.textContent = formatBytes(saved);
  resultPct.textContent = pct + '%';
  resultsSummary.className = 'results-summary';
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderAll() {
  renderDropzone();
  renderFileBar();
  renderButtons();
  renderProgress();
  renderImageList();
  renderLargeBatch();
}

function renderDropzone() {
  const isEmpty = images.length === 0;
  dropzone.style.display = isEmpty ? '' : 'none';
}

function renderFileBar() {
  if (images.length === 0) { fileBar.className = 'file-bar hidden'; return; }
  fileBar.className = 'file-bar';
  const waiting = images.filter(img => img.status === 'waiting').length;
  let text = `${images.length} arquivo${images.length !== 1 ? 's' : ''}`;
  if (waiting > 0 && !isCompressing) text += ` · ${waiting} aguardando`;
  fileCount.textContent = text;
  btnAddMore.disabled = isCompressing;
}

function renderButtons() {
  const hasPending = images.some(img => img.status === 'waiting' || img.status === 'error');
  const allFinished = images.length > 0 && !isCompressing &&
    images.every(img => img.status === 'done' || img.status === 'error');
  const doneCount = images.filter(img => img.status === 'done').length;

  // Compress
  btnCompress.disabled = !images.length || isCompressing || !hasPending;
  if (isCompressing) {
    btnCompress.innerHTML = `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg> Comprimindo...`;
  } else {
    btnCompress.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z" clip-rule="evenodd" /></svg> Comprimir Imagens`;
  }

  // Download
  if (allFinished && doneCount > 0) {
    btnDownload.className = 'btn btn-outline';
    btnDownloadLabel.textContent = `Baixar Todas (${doneCount})`;
  } else {
    btnDownload.className = 'btn btn-outline hidden';
  }

  // Re-compress
  btnRecompress.className = allFinished ? 'btn btn-ghost' : 'btn btn-ghost hidden';

  // Clear
  btnClear.className = images.length > 0 && !isCompressing ? 'btn btn-danger' : 'btn btn-danger hidden';
}

function renderProgress() {
  if (isCompressing) {
    progressSection.className = 'progress-section';
  } else {
    progressSection.className = 'progress-section hidden';
  }
}

function renderLargeBatch() {
  if (images.length > 80 && !isCompressing) {
    largeBatchNotice.className = 'notice notice-amber';
    largeBatchNotice.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>` +
      `<span><strong>${images.length} imagens detectadas.</strong> Lotes grandes podem demorar varios minutos. Mantenha a aba aberta.</span>`;
  } else {
    largeBatchNotice.className = 'notice notice-amber hidden';
  }
}

function renderImageList() {
  // Sync DOM rows with state (add new, update existing, remove deleted)
  const existingRows = new Map();
  imageList.querySelectorAll('.image-row').forEach(el => {
    existingRows.set(el.dataset.id, el);
  });

  const currentIds = new Set(images.map(img => img.id));

  // Remove rows for deleted images
  existingRows.forEach((el, id) => {
    if (!currentIds.has(id)) el.remove();
  });

  // Update or create rows in order
  images.forEach((img, index) => {
    let row = existingRows.get(img.id);
    if (!row) {
      row = createRow(img);
      imageList.appendChild(row);
    } else {
      updateRow(row, img);
    }
    // Maintain order
    if (imageList.children[index] !== row) {
      imageList.insertBefore(row, imageList.children[index] || null);
    }
  });
}

function createRow(img) {
  const row = document.createElement('div');
  row.className = 'image-row';
  row.dataset.id = img.id;
  row.innerHTML = rowHTML(img);
  bindRowEvents(row, img);
  return row;
}

function updateRow(row, img) {
  row.innerHTML = rowHTML(img);
  bindRowEvents(row, img);
}

function rowHTML(img) {
  const saved = img.compressedSize !== null && img.compressedSize < img.originalSize;
  const pct   = img.compressedSize !== null && img.originalSize > 0
    ? Math.round((1 - img.compressedSize / img.originalSize) * 100) : 0;

  let meta = `<span class="meta-original">${formatBytes(img.originalSize)}</span>`;

  if (img.compressedSize !== null) {
    meta += `<span class="meta-arrow">→</span>`;
    meta += `<span class="${saved ? 'meta-compressed' : ''}">${formatBytes(img.compressedSize)}</span>`;
    if (saved) {
      meta += `<span class="meta-badge">-${pct}%</span>`;
    } else {
      meta += `<span class="meta-badge-neutral">original mantido</span>`;
    }
  }

  if (img.status === 'waiting') {
    meta += `<span class="meta-waiting">Aguardando</span>`;
  }
  if (img.status === 'compressing') {
    meta += `<span class="meta-compressing"><span class="spin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg></span> Comprimindo...</span>`;
  }
  if (img.status === 'error') {
    meta += `<span class="meta-error" title="${img.error || 'Erro desconhecido'}">⚠ ${img.error ? img.error.slice(0,50) : 'Erro'}</span>`;
  }

  const dlBtn = img.status === 'done' && img.compressedBlob
    ? `<button class="action-btn btn-dl" data-action="download" title="Baixar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg></button>` : '';

  const retryBtn = img.status === 'error' && !isCompressing
    ? `<button class="action-btn btn-retry" data-action="retry" title="Tentar novamente"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg></button>` : '';

  const checkIcon = img.status === 'done'
    ? `<svg class="check-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>` : '';

  const removeBtn = !isCompressing
    ? `<button class="action-btn btn-remove" data-action="remove" title="Remover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg></button>` : '';

  return `
    <div class="img-thumb"><img src="${img.thumbnail}" alt="${img.file.name}" loading="lazy" decoding="async" /></div>
    <div class="img-info">
      <p class="img-name" title="${img.file.name}">${img.file.name}</p>
      <div class="img-meta">${meta}</div>
    </div>
    <div class="img-actions">
      ${dlBtn}${retryBtn}${checkIcon}${removeBtn}
    </div>
  `;
}

function bindRowEvents(row, img) {
  row.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'download' && img.compressedBlob) {
      downloadBlob(img.compressedBlob, img.file.name);
    }
    if (action === 'retry') {
      img.status = 'waiting'; img.error = null;
      img.compressedBlob = null; img.compressedSize = null;
      renderAll();
    }
    if (action === 'remove' && !isCompressing) {
      URL.revokeObjectURL(img.thumbnail);
      images = images.filter(i => i.id !== img.id);
      resultsSummary.className = 'results-summary hidden';
      renderAll();
    }
  });
}

// ── Event listeners ────────────────────────────────────────────────────────────

// File inputs
fileInput.addEventListener('change', e => {
  if (e.target.files) ingestFiles(e.target.files);
  e.target.value = '';
});
addMoreInput.addEventListener('change', e => {
  if (e.target.files) ingestFiles(e.target.files);
  e.target.value = '';
});
btnAddMore.addEventListener('click', () => { if (!isCompressing) addMoreInput.click(); });

// Drag and drop (whole document)
document.addEventListener('dragenter', e => {
  e.preventDefault(); dragCounter++;
  if (dragCounter > 0) dragOverlay.className = 'drag-overlay';
});
document.addEventListener('dragleave', e => {
  e.preventDefault(); dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; dragOverlay.className = 'drag-overlay hidden'; }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); dragCounter = 0;
  dragOverlay.className = 'drag-overlay hidden';
  if (isCompressing) return;
  if (e.dataTransfer.files.length) ingestFiles(e.dataTransfer.files);
});

// Mode buttons
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isCompressing) return;
    mode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    specificPanel.className = mode === 'specific-size' ? 'specific-panel' : 'specific-panel hidden';
  });
});

// Unit toggle
document.querySelectorAll('.unit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isCompressing) return;
    targetUnit = btn.dataset.unit;
    document.querySelectorAll('.unit-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    updateTargetDesc();
  });
});

targetSizeInput.addEventListener('input', () => {
  targetSize = targetSizeInput.value;
  updateTargetDesc();
});

function updateTargetDesc() {
  const val = parseFloat(targetSize);
  if (!isNaN(val) && val > 0) {
    targetDesc.textContent = `Cada imagem sera comprimida ate ${targetSize} ${targetUnit}`;
    targetDesc.style.color = '';
  } else {
    targetDesc.textContent = 'Informe um valor valido maior que 0';
    targetDesc.style.color = '#ef4444';
  }
}

// Action buttons
btnCompress.addEventListener('click', compressAll);
btnDownload.addEventListener('click', downloadZip);
btnClear.addEventListener('click', () => {
  if (isCompressing) return;
  images.forEach(img => URL.revokeObjectURL(img.thumbnail));
  images = [];
  resultsSummary.className = 'results-summary hidden';
  progressBar.style.width = '0%';
  renderAll();
});
btnRecompress.addEventListener('click', () => {
  if (isCompressing) return;
  images.forEach(img => {
    img.status = 'waiting';
    img.compressedBlob = null;
    img.compressedSize = null;
    img.error = null;
  });
  resultsSummary.className = 'results-summary hidden';
  progressBar.style.width = '0%';
  renderAll();
});

// Initial render
renderAll();
