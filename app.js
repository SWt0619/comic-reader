/*!
 * 本地漫画阅览器 —— 一个纯本地的漫画 / 图片浏览器
 * MIT License · Copyright (c) 2026 RJL0619
 * 完整许可证见同目录 LICENSE 文件。
 */
(function () {
  'use strict';

  /* ===== 常量 ===== */
  var IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
  var ZOOM_STEPS = [25, 50, 75, 100, 150, 200, 300, 400];
  var THEME_ORDER = ['white', 'yellow', 'black'];
  var THEME_LABEL = { white: '白', yellow: '黄(护眼)', black: '黑' };
  var FIT_LABEL = { width: '宽度适应', height: '高度适应', original: '原始大小', percent: '百分比缩放' };
  var RECENTS_KEY = 'comicReader:recents';
  var MAX_RECENTS = 8;
  var DB_NAME = 'comicReader';
  var DB_STORE = 'handles';

  var DEFAULT_FIT = 'height';                 // 默认显示模式：高度适应
  var FIT_FLAG_KEY = 'comicReader:fitDefault'; // 首次运行把默认改成高度适应（忽略旧存档里的显示模式）
  var MAIN_CACHE_MAX = 32;                    // 大图 objectURL 缓存条数
  var FS_HUD_HOT_H = 96;                      // 真全屏：鼠标进到「距画面底部 96px」以内才浮出提示条
  var FS_HUD_OUT_H = 24;                      // 再往外移这么多才收起（滞回，避免贴着边界抖动）

  /* ===== 状态 ===== */
  var state = {
    files: [],          // [{ file, name, path }]
    order: [],          // 显示顺序（随机模式下被打乱）
    index: 0,
    normalIndex: 0,
    randomMode: false,
    folderName: '',
    autoFlip: false,
    timer: null,
    intervalSec: 5,
    theme: 'white',
    fitMode: DEFAULT_FIT,   // width | height | original | percent
    zoomPercent: 100,
    effect: 'fade',         // fade | slide | zoom | none
    dir: 'none',            // forward | backward | none（翻页方向，供滑动特效使用）
    sortMode: 'name-asc',
    animSpeed: 400,
    trueFull: false         // 真全屏（隐藏全部界面）
  };

  /* ===== DOM 引用 ===== */
  var $ = function (sel) { return document.querySelector(sel); };
  var elEmpty = $('#emptyState');
  var elReader = $('#reader');
  var elViewer = $('#viewer');
  var elImg = $('#mainImg');
  var elPageInfo = $('#pageInfo');
  var elFolderName = $('#folderName');
  var elFileInput = $('#fileInput');
  var elAutoBtn = $('#autoBtn');
  var elInterval = $('#interval');
  var elIntervalVal = $('#intervalVal');
  var elThemeBtn = $('#themeBtn');
  var elFitSelect = $('#fitSelect');
  var elZoomBtn = $('#zoomBtn');
  var elEffectSelect = $('#effectSelect');
  var elSortSelect = $('#sortSelect');
  var elAnimSpeed = $('#animSpeed');
  var elAnimSpeedVal = $('#animSpeedVal');
  var elSidebarBtn = $('#sidebarBtn');
  var elHelpBtn = $('#helpBtn');
  var elHelpModal = $('#helpModal');
  var elHelpClose = $('#helpClose');
  var elPrevBtn = $('#prevBtn');
  var elNextBtn = $('#nextBtn');
  // 顶栏与侧栏各有一个 id="fullBtn" 的按钮（历史遗留的重复 id），全部绑上，否则侧栏那个是死按钮
  var elFullBtns = Array.prototype.slice.call(document.querySelectorAll('#fullBtn'));
  var elStatus = $('#autoStatus');
  var elContinueBar = $('#continueBar');
  var elContinueText = $('#continueText');
  var elContinueBtn = $('#continueBtn');
  var elDismissBtn = $('#dismissBtn');
  var elProgress = $('#progressBar');
  var elRandomBtn = $('#randomBtn');
  var elListBtn = $('#listBtn');
  var elThumbPanel = $('#thumbPanel');
  var elThumbGrid = $('#thumbGrid');
  var elThumbSpacer = $('#thumbSpacer');
  var elThumbCount = $('#thumbCount');
  var elThumbClose = $('#thumbClose');
  var elFsHud = $('#fsHud');
  var elFsHudState = $('#fsHudState');
  var elFsHudPage = $('#fsHudPage');
  var elFsHudHint = $('#fsHudHint');

  /* ===== 大图 objectURL 缓存（LRU）===== */
  var urlCache = new Map();
  function getUrl(entry) {
    var key = entry.path;
    if (urlCache.has(key)) {
      var u = urlCache.get(key);
      urlCache.delete(key);      // 命中即刷新为最近使用
      urlCache.set(key, u);
      return u;
    }
    if (urlCache.size >= MAIN_CACHE_MAX) {
      var oldKey = urlCache.keys().next().value;
      URL.revokeObjectURL(urlCache.get(oldKey));
      urlCache.delete(oldKey);
    }
    var url = URL.createObjectURL(entry.file);
    urlCache.set(key, url);
    return url;
  }
  function clearCache() {
    urlCache.forEach(function (url) { URL.revokeObjectURL(url); });
    urlCache.clear();
    preloadImgs.clear();
  }

  /* 预加载：真正把邻近页解码进浏览器缓存（只创建 objectURL 是不会解码的） */
  var preloadImgs = new Map();
  function preloadOne(entry) {
    var key = entry.path;
    if (preloadImgs.has(key)) return;
    var im = new Image();
    im.decoding = 'async';
    im.src = getUrl(entry);
    preloadImgs.set(key, im);
    while (preloadImgs.size > 12) {
      var k = preloadImgs.keys().next().value;
      preloadImgs.delete(k);
    }
  }

  /* ===== 文件扫描与排序 ===== */
  function filterAndSort(entries) {
    var filtered = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var dot = e.name.lastIndexOf('.');
      var ext = dot >= 0 ? e.name.slice(dot + 1).toLowerCase() : '';
      if (IMAGE_EXT.indexOf(ext) === -1) continue;
      filtered.push(e);
    }
    filtered.sort(cmpNameAsc);
    return filtered;
  }

  /* ===== 排序方式 ===== */
  var collator = null;
  try {
    if (window.Intl && Intl.Collator) {
      collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    }
  } catch (e) { collator = null; }
  function cmpText(a, b) {
    if (collator) return collator.compare(a, b);
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }
  function cmpNameAsc(x, y) {
    var c = cmpText(x.name, y.name);
    if (c !== 0) return c;
    return cmpText(x.path, y.path);
  }
  function cmpNameDesc(x, y) { return cmpNameAsc(y, x); }
  function sortFiles(entries, mode) {
    var a = entries.slice();
    var cmp;
    switch (mode) {
      case 'name-desc': cmp = cmpNameDesc; break;
      case 'time-desc': cmp = function (x, y) { return (y.file.lastModified || 0) - (x.file.lastModified || 0); }; break;
      case 'time-asc': cmp = function (x, y) { return (x.file.lastModified || 0) - (y.file.lastModified || 0); }; break;
      case 'size-desc': cmp = function (x, y) { return (y.file.size || 0) - (x.file.size || 0); }; break;
      case 'size-asc': cmp = function (x, y) { return (x.file.size || 0) - (y.file.size || 0); }; break;
      default: cmp = cmpNameAsc; // name-asc
    }
    a.sort(cmp);
    return a;
  }
  function scanFolder(fileList) {
    var entries = [];
    for (var i = 0; i < fileList.length; i++) {
      var file = fileList[i];
      var path = file.webkitRelativePath || file.name;
      entries.push({ file: file, name: file.name, path: path });
    }
    return filterAndSort(entries);
  }
  async function listImagesFromHandle(dirHandle) {
    var out = [];
    async function walk(dir, prefix) {
      for await (var entry of dir.values()) {
        var rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.kind === 'directory') {
          await walk(entry, rel);
        } else {
          var file = await entry.getFile();
          out.push({ file: file, name: entry.name, path: rel });
        }
      }
    }
    await walk(dirHandle, '');
    return filterAndSort(out);
  }

  function openFolder(fileList) {
    var entries = scanFolder(fileList);
    var folderName = entries.length ? entries[0].path.split('/')[0] : '';
    openFromEntries(entries, folderName, null);
  }

  async function importFolder() {
    if (window.showDirectoryPicker) {
      try {
        var dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        var entries = await listImagesFromHandle(dirHandle);
        openFromEntries(entries, dirHandle.name, dirHandle);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // 用户取消选择
        // 其他异常降级到传统文件选择
      }
    }
    elFileInput.click();
  }

  function openFromEntries(entries, folderName, handle) {
    if (entries.length === 0) {
      alert('所选文件夹中没有找到图片文件。');
      return;
    }
    stopAuto();
    clearCache();
    exitTrueFull();
    state.files = entries;
    state.folderName = folderName;
    state.order = makeOrder();
    state.randomMode = false;
    state.normalIndex = 0;
    state.index = 0;

    elFolderName.textContent = folderName;
    elFolderName.title = folderName;
    elReader.style.display = 'flex';
    elEmpty.style.display = 'none';
    elRandomBtn.classList.remove('active');

    var saved = loadProgress();
    if (saved) {
      applySavedSettings(saved);
      // 恢复随机模式：沿用上次的随机顺序与位置
      if (saved.randomMode && isValidOrder(saved.order, entries.length)) {
        state.randomMode = true;
        state.order = saved.order.slice();
        rebuildOrderPos();          // 恢复随机顺序后必须重建索引表，否则缩略图点击会跳错页
        state.normalIndex = saved.normalIndex || 0;
        state.index = Math.max(0, Math.min(saved.index || 0, entries.length - 1));
        elRandomBtn.classList.add('active');
      } else {
        state.normalIndex = saved.normalIndex || 0;
        state.index = 0;
      }
      var resumeAt = state.randomMode ? state.index : (state.normalIndex || 0);
      if (resumeAt > 0 && resumeAt < entries.length) {
        showContinueBar(resumeAt);
      }
    }
    resetThumbs();
    render();
    addRecent(folderName, handle);
  }

  /* ===== 显示顺序与随机 ===== */
  function makeOrder() {
    var arr = [];
    for (var i = 0; i < state.files.length; i++) arr.push(i);
    return arr;
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function isValidOrder(arr, n) {
    if (!Array.isArray(arr) || arr.length !== n) return false;
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v !== (v | 0) || v < 0 || v >= n || seen[v]) return false;
      seen[v] = true;
    }
    return true;
  }

  /* 文件下标 → 显示位置（随机模式下与下标不同），O(1) */
  var orderPos = null;
  function rebuildOrderPos() {
    orderPos = new Int32Array(state.files.length);
    for (var p = 0; p < state.order.length; p++) orderPos[state.order[p]] = p;
  }
  function posOfFile(fileIdx) {
    if (orderPos && fileIdx >= 0 && fileIdx < orderPos.length) return orderPos[fileIdx];
    return fileIdx;
  }

  /* 随机顺序：只打乱顺序，不自动开始播放（与自动翻页互相独立） */
  function enableRandom() {
    if (state.files.length === 0) return;
    state.normalIndex = state.randomMode ? state.normalIndex : state.index;
    state.randomMode = true;
    state.order = shuffle(makeOrder());
    rebuildOrderPos();
    state.index = 0;
    elRandomBtn.classList.add('active');
    render();
  }
  function disableRandom() {
    if (!state.randomMode) return;
    state.randomMode = false;
    state.order = makeOrder();
    rebuildOrderPos();
    state.index = Math.max(0, Math.min(state.normalIndex, state.files.length - 1));
    elRandomBtn.classList.remove('active');
    render();
  }
  function toggleRandom() {
    if (state.randomMode) disableRandom(); else enableRandom();
  }
  function setSort(mode) {
    if (state.files.length === 0) return;
    state.sortMode = mode;
    elSortSelect.value = mode;
    stopAuto();
    state.randomMode = false;
    elRandomBtn.classList.remove('active');
    state.files = sortFiles(state.files, mode);
    state.order = makeOrder();
    state.normalIndex = 0;
    state.index = 0;
    resetThumbs();
    render();
    saveProgress();
  }

  /* 首次运行：忽略旧存档里的显示模式，把默认改成「高度适应」 */
  var fitDefaultFresh = true;
  try {
    fitDefaultFresh = localStorage.getItem(FIT_FLAG_KEY) !== '1';
    localStorage.setItem(FIT_FLAG_KEY, '1');
  } catch (e) { fitDefaultFresh = false; }

  function applySavedSettings(saved) {
    // 兼容旧数据：day/night 迁移到 white/black
    var bg = saved.bgMode;
    if (!bg) bg = saved.theme === 'night' ? 'black' : (saved.theme === 'yellow' ? 'yellow' : 'white');
    if (THEME_ORDER.indexOf(bg) !== -1) setTheme(bg);
    if (saved.intervalSec) setIntervalSec(saved.intervalSec);
    if (saved.fitMode && !fitDefaultFresh) setFitMode(saved.fitMode);
    if (saved.zoomPercent) setZoomPercent(saved.zoomPercent);
    if (saved.effect) setEffect(saved.effect);
    if (saved.sortMode) setSort(saved.sortMode);
    if (saved.animSpeed) setAnimSpeed(saved.animSpeed);
  }

  /* ===== 渲染 ===== */
  function render() {
    if (state.files.length === 0) return;
    var entry = state.files[state.order[state.index]];
    elImg.onload = function () {
      applyFitToImg();
      playTransition();
    };
    elImg.src = getUrl(entry);
    elImg.alt = entry.name;
    elPageInfo.textContent = state.randomMode
      ? '随机 ' + (state.index + 1) + ' / ' + state.files.length
      : (state.index + 1) + ' / ' + state.files.length;
    preload();
    updateNav();
    updateProgress();
    updateActiveThumb();
    updateStatusBar();
    if (state.trueFull && elFsHud && elFsHud.classList.contains('show')) updateFsHud();
    saveProgress();
  }

  function preload() {
    for (var d = 1; d <= 3; d++) {
      if (state.index + d < state.files.length) preloadOne(state.files[state.order[state.index + d]]);
      if (state.index - d >= 0) preloadOne(state.files[state.order[state.index - d]]);
    }
  }

  /* ===== 阅读进度条 ===== */
  function updateProgress() {
    if (state.files.length === 0) return;
    elProgress.max = state.files.length - 1;
    elProgress.value = state.index;
    var pct = state.files.length > 1 ? (state.index / (state.files.length - 1)) * 100 : 0;
    elProgress.style.setProperty('--fill', pct + '%');
  }

  /* ===== 状态栏 ===== */
  function updateStatusBar() {
    if (state.files.length === 0) { elStatus.textContent = ''; return; }
    if (state.autoFlip) {
      elStatus.textContent = '自动翻页中 · 每 ' + state.intervalSec + ' 秒翻一页';
      return;
    }
    var parts = [];
    parts.push(state.randomMode ? '随机顺序' : '顺序播放');
    parts.push(FIT_LABEL[state.fitMode] || '');
    if (state.fitMode === 'percent') parts.push(state.zoomPercent + '%');
    parts.push('共 ' + state.files.length + ' 张');
    if (state.trueFull) parts.push('真全屏中 · Esc 退出');
    elStatus.textContent = parts.join(' · ');
  }

  /* ===================================================================
     图片列表（缩略图）
     - 虚拟网格：池化复用固定数量的 DOM 节点，滚动不再重建整棵子树
     - 真缩略图：createImageBitmap 按宽度缩放后画到 canvas，避免每张都解码原图
     - 缓存按「文件」记（排序/随机不影响），带 LRU 上限
     =================================================================== */
  var TH = {
    cellW: 80, cellH: 112,      // 网格单元
    thumbW: 72, thumbH: 104,    // 缩略图显示尺寸
    padX: 8, padY: 6,
    bufferRows: 1,
    dpr: 2,                     // canvas 像素密度
    workers: 4                  // 同时解码的缩略图数量
  };
  var THUMB_CACHE_MAX = 150;

  var thumbBmp = new Map();      // key -> { state:0/1/2/3, src, url, cbs }
  var thumbOrder = [];           // LRU
  var thumbPool = [];            // 复用的 DOM 节点
  var thumbLayout = { cols: 1, rows: 0, totalH: 0 };
  var thumbQueue = [];
  var thumbActive = 0;
  var thumbGen = 0;              // 换文件夹 / 排序时 +1，用来丢弃过期结果
  var thumbRaf = null;
  var thumbWanted = null;        // 最近一帧真正需要的缩略图（快速滚动时丢弃已滚过头的任务）
  var lastThumbTouch = 0;        // 用户手动滚动列表的时间，用于避免翻页时把列表抢回去

  function keyOf(entry) {
    var f = entry.file;
    return entry.path + '|' + f.size + '|' + (f.lastModified || 0);
  }

  function clearThumbBmp() {
    thumbGen++;
    thumbQueue.length = 0;
    thumbBmp.forEach(function (rec) { releaseThumb(rec); });
    thumbBmp.clear();
    thumbOrder.length = 0;
  }
  function releaseThumb(rec) {
    if (!rec) return;
    rec.cbs = [];
    if (rec.src && typeof rec.src.close === 'function') { try { rec.src.close(); } catch (e) {} }
    if (rec.url) { try { URL.revokeObjectURL(rec.url); } catch (e) {} }
    rec.src = null; rec.url = null;
  }
  function trimThumbCache() {
    while (thumbOrder.length > THUMB_CACHE_MAX) {
      var key = thumbOrder.shift();
      var rec = thumbBmp.get(key);
      if (rec && rec.state === 2) { releaseThumb(rec); thumbBmp.delete(key); }
    }
  }

  function loadThumb(entry) {
    return new Promise(function (resolve, reject) {
      function viaImg() {
        var url = URL.createObjectURL(entry.file);
        var im = new Image();
        im.decoding = 'async';
        im.onload = function () {
          if (!im.naturalWidth) { URL.revokeObjectURL(url); reject(new Error('empty image')); return; }
          resolve({ src: im, url: url });
        };
        im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image error')); };
        im.src = url;
      }
      if (window.createImageBitmap) {
        var p = null;
        try {
          p = createImageBitmap(entry.file, { resizeWidth: TH.thumbW * TH.dpr, resizeQuality: 'medium' });
        } catch (e) { p = null; }
        if (p && typeof p.then === 'function') {
          p.then(function (bmp) { resolve({ src: bmp, url: null }); }, viaImg);
          return;
        }
      }
      viaImg();
    });
  }

  function pumpThumbQueue() {
    while (thumbActive < TH.workers && thumbQueue.length) {
      var key = thumbQueue.shift();
      var rec = thumbBmp.get(key);
      if (!rec || rec.state !== 1) continue;
      // 快速滚动时把已经滚过头的任务丢掉，稍后需要时会重新入队
      if (thumbQueue.length > 40 && thumbWanted && !thumbWanted.has(key)) {
        rec.state = 0;
        continue;
      }
      (function (myKey, myRec, gen) {
        thumbActive++;
        loadThumb(myRec.entry).then(function (res) {
          thumbActive--;
          if (gen !== thumbGen) { releaseThumb({ src: res.src, url: res.url }); pumpThumbQueue(); return; }
          myRec.state = 2;
          myRec.src = res.src;
          myRec.url = res.url;
          thumbOrder.push(myKey);
          var cbs = myRec.cbs; myRec.cbs = [];
          for (var i = 0; i < cbs.length; i++) { try { cbs[i](myRec); } catch (e) {} }
          trimThumbCache();
          pumpThumbQueue();
        }, function () {
          thumbActive--;
          myRec.state = 3;
          myRec.cbs = [];
          pumpThumbQueue();
        });
      })(key, rec, thumbGen);
    }
  }

  /* 返回还在加载中的记录（用于之后撤销回调）；已就绪/已失败时直接回调并返回 null */
  function requestThumb(entry, cb) {
    var key = keyOf(entry);
    var rec = thumbBmp.get(key);
    if (rec && rec.state === 2) { cb(rec); return null; }
    if (rec && rec.state === 3) { cb(null); return null; }
    if (!rec) {
      rec = { state: 0, src: null, url: null, cbs: [], entry: entry };
      thumbBmp.set(key, rec);
    }
    rec.cbs.push(cb);
    if (rec.state === 0) { rec.state = 1; thumbQueue.push(key); pumpThumbQueue(); }
    return rec;
  }

  function paintThumb(canvas, src) {
    var ctx = canvas.getContext('2d');
    var cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    var sw = src.width || src.naturalWidth;
    var sh = src.height || src.naturalHeight;
    if (!sw || !sh) return;
    var s = Math.max(cw / sw, ch / sh);      // 等比铺满后居中裁切（等价 object-fit: cover）
    var dw = sw * s, dh = sh * s;
    try { ctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh); } catch (e) {}
  }

  function createThumbItem() {
    var item = document.createElement('div');
    item.className = 'thumb-item loading';
    var cv = document.createElement('canvas');
    cv.className = 'thumb-canvas';
    cv.width = TH.thumbW * TH.dpr;
    cv.height = TH.thumbH * TH.dpr;
    var idx = document.createElement('span');
    idx.className = 'thumb-idx';
    item.appendChild(cv);
    item.appendChild(idx);
    item._canvas = cv;
    item._idxLabel = idx;
    item._index = -1;
    item._key = '';
    item._req = null;
    item._cb = null;
    item._left = -999; item._top = -999; item._active = false;
    item.addEventListener('click', function () {
      var i = item._index;
      if (i < 0) return;
      goTo(state.randomMode ? posOfFile(i) : i);
    });
    return item;
  }

  function bindThumbItem(item, i) {
    var entry = state.files[i];
    var key = keyOf(entry);
    // 从上一个还在排队的记录里摘掉旧回调，避免回调堆积
    if (item._req && item._cb) {
      var arr = item._req.cbs;
      var ix = arr.indexOf(item._cb);
      if (ix >= 0) arr.splice(ix, 1);
    }
    item._req = null;
    item._cb = null;
    item.style.display = '';
    item._index = i;
    item._key = key;
    item.title = (i + 1) + '. ' + entry.name;
    item._idxLabel.textContent = i + 1;
    item.classList.add('loading');
    var ctx = item._canvas.getContext('2d');
    ctx.clearRect(0, 0, item._canvas.width, item._canvas.height);
    var cb = function (rec) {
      if (item._key !== key) return;                 // 已滚走，丢弃
      item._req = null;
      item._cb = null;
      if (!rec || !rec.src) { item.classList.remove('loading'); return; }
      paintThumb(item._canvas, rec.src);
      item.classList.remove('loading');
    };
    item._cb = cb;
    item._req = requestThumb(entry, cb);
  }

  function ensureThumbLayout() {
    var n = state.files.length;
    var sc = elThumbGrid;
    var avail = Math.max(0, sc.clientWidth - TH.padX * 2);
    if (avail <= 0) return false;
    var cols = Math.max(1, Math.floor(avail / TH.cellW));
    var rows = Math.ceil(n / cols) || 1;
    var totalH = rows * TH.cellH + TH.padY * 2;
    thumbLayout.cols = cols;
    thumbLayout.rows = rows;
    thumbLayout.totalH = totalH;
    if (elThumbSpacer.style.height !== totalH + 'px') elThumbSpacer.style.height = totalH + 'px';
    var visRows = Math.ceil(sc.clientHeight / TH.cellH) + 1;
    var need = Math.min(n, (visRows + TH.bufferRows) * cols);
    while (thumbPool.length < need) {
      var it = createThumbItem();
      thumbPool.push(it);
      elThumbGrid.appendChild(it);
    }
    return true;
  }

  function renderThumbWindow() {
    var n = state.files.length;
    if (!n || elThumbPanel.style.display === 'none') return;
    if (!ensureThumbLayout()) return;
    var sc = elThumbGrid;
    var cols = thumbLayout.cols;
    var st = sc.scrollTop;
    var firstRow = Math.max(0, Math.floor((st - TH.padY) / TH.cellH) - TH.bufferRows);
    var lastRow = Math.floor((st + sc.clientHeight - TH.padY) / TH.cellH) + TH.bufferRows;
    var start = firstRow * cols;
    var end = Math.min(n - 1, (lastRow + 1) * cols - 1);
    var activeFile = state.order[state.index];
    var want = new Set();
    var used = 0;
    for (var i = start; i <= end; i++) {
      var item = thumbPool[used];
      if (!item) break;
      used++;
      want.add(keyOf(state.files[i]));
      var left = TH.padX + (i % cols) * TH.cellW;
      var top = TH.padY + ((i / cols) | 0) * TH.cellH;
      if (item._left !== left) { item.style.left = left + 'px'; item._left = left; }
      if (item._top !== top) { item.style.top = top + 'px'; item._top = top; }
      if (item._index !== i) bindThumbItem(item, i);
      var isActive = (i === activeFile);
      if (item._active !== isActive) { item.classList.toggle('active', isActive); item._active = isActive; }
    }
    thumbWanted = want;
    for (var j = used; j < thumbPool.length; j++) {
      var rest = thumbPool[j];
      if (rest._index !== -1) {
        rest.style.display = 'none';
        rest._index = -1;
        rest._active = false;
        rest.classList.remove('active');
      }
    }
    pumpThumbQueue();
  }

  function scrollThumbTo(pos) {
    var sc = elThumbGrid;
    var cols = thumbLayout.cols || 1;
    var row = Math.floor(pos / cols);
    var y = TH.padY + row * TH.cellH;
    var viewTop = sc.scrollTop;
    var viewBot = viewTop + sc.clientHeight;
    var target = null;
    if (y < viewTop + 4) target = Math.max(0, y - 4);
    else if (y + TH.cellH > viewBot - 4) target = Math.max(0, y + TH.cellH + 4 - sc.clientHeight);
    if (target !== null) {
      thumbProgrammaticScroll = true;
      sc.scrollTop = target;
    }
  }
  var thumbProgrammaticScroll = false;

  function updateThumbCount() {
    if (elThumbCount) {
      elThumbCount.textContent = state.files.length
        ? '共 ' + state.files.length + ' 张 · 当前第 ' + (state.index + 1) + ' 张'
        : '图片列表';
    }
  }

  function resetThumbs() {
    clearThumbBmp();
    thumbWanted = null;
    lastThumbTouch = 0;
    thumbPool.forEach(function (it) {
      it._index = -1;
      it._key = '';
      it._active = false;
      it.style.display = 'none';
      it.classList.remove('active', 'loading');
    });
    if (elThumbGrid) elThumbGrid.scrollTop = 0;
    thumbLayout = { cols: 1, rows: 0, totalH: 0 };
  }

  function updateActiveThumb() {
    if (elThumbPanel.style.display === 'none') return;
    if (!ensureThumbLayout()) return;
    // 用户刚在手动翻列表时不抢滚动位置；自动播放 / 空闲超过 3 秒才跟随
    if (state.autoFlip || (Date.now() - lastThumbTouch > 3000)) scrollThumbTo(state.index);
    renderThumbWindow();
    updateThumbCount();
  }

  /* 合并同一帧内的多次请求：优先 rAF，rAF 被节流时用定时器兜底 */
  function scheduleThumbRender() {
    if (thumbRaf) return;
    var fired = false;
    var fire = function () {
      if (fired) return;
      fired = true;
      clearTimeout(thumbRaf.timer);
      thumbRaf = null;
      renderThumbWindow();
    };
    thumbRaf = { fire: fire, timer: setTimeout(fire, 32) };
    requestAnimationFrame(fire);
  }

  function toggleThumbPanel() {
    var show = elThumbPanel.style.display === 'none';
    elThumbPanel.style.display = show ? 'flex' : 'none';
    elListBtn.classList.toggle('active', show);
    if (show) updateActiveThumb();   // 读 clientWidth 会强制同步布局，无需等下一帧
  }

  elThumbGrid.addEventListener('scroll', function () {
    if (thumbProgrammaticScroll) thumbProgrammaticScroll = false;
    else lastThumbTouch = Date.now();
    scheduleThumbRender();
  }, { passive: true });

  if (window.ResizeObserver) {
    var thumbRO = new ResizeObserver(function () {
      if (elThumbPanel.style.display === 'none') return;
      scheduleThumbRender();
    });
    thumbRO.observe(elThumbGrid);
  } else {
    window.addEventListener('resize', function () { updateActiveThumb(); });
  }

  function toggleSidebar() {
    var collapsed = elReader.classList.toggle('sidebar-collapsed');
    elSidebarBtn.classList.toggle('active', !collapsed);
    try { localStorage.setItem('comicReader:sidebarCollapsed', collapsed ? '1' : '0'); } catch (e) {}
  }
  function toggleHelp() {
    var show = elHelpModal.style.display === 'none';
    elHelpModal.style.display = show ? 'flex' : 'none';
  }
  function closeHelp() { elHelpModal.style.display = 'none'; }

  function goTo(i, dir) {
    if (state.files.length === 0) return;
    state.index = Math.max(0, Math.min(state.files.length - 1, i));
    if (!state.randomMode) state.normalIndex = state.index;
    state.dir = dir || 'none';
    hideContinueBar();
    // 翻页（手动或自动）时把真全屏的提示条收起来：它只该在「切换播放状态 / 鼠标移到底部热区」时出现，
    // 不该一直挡着画面
    if (state.trueFull) hideFsHud();
    render();
  }
  function next() {
    if (state.index < state.files.length - 1) goTo(state.index + 1, 'forward');
  }
  function prev() {
    if (state.index > 0) goTo(state.index - 1, 'backward');
  }
  function updateNav() {
    elPrevBtn.disabled = state.index === 0;
    elNextBtn.disabled = state.index >= state.files.length - 1;
  }

  /* ===== 自动翻页（与随机互不绑定）===== */
  function startAuto() {
    if (state.files.length === 0) return;
    stopAuto();
    state.autoFlip = true;
    state.timer = setInterval(function () {
      if (state.index >= state.files.length - 1) {
        stopAuto();
        return;
      }
      goTo(state.index + 1);
    }, state.intervalSec * 1000);
    updateAutoUI();
  }
  function stopAuto() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.autoFlip = false;
    updateAutoUI();
  }
  function toggleAuto() {
    if (state.autoFlip) stopAuto(); else startAuto();
  }
  function updateAutoUI() {
    elAutoBtn.textContent = state.autoFlip ? '⏸ 暂停' : '▶ 自动翻页';
    elAutoBtn.classList.toggle('active', state.autoFlip);
    updateStatusBar();
    if (state.trueFull) updateFsHud();   // 真全屏下把播放状态写进提示层
  }

  function setIntervalSec(sec) {
    state.intervalSec = sec;
    elInterval.value = sec;
    elIntervalVal.textContent = sec + ' 秒';
    if (state.autoFlip) startAuto(); // 重启计时器使新间隔生效
    updateStatusBar();
    saveProgress();
  }

  /* ===== 主题 ===== */
  function setTheme(t) {
    state.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    elThemeBtn.textContent = '背景：' + THEME_LABEL[t];
    saveProgress();
  }
  function toggleTheme() {
    var idx = THEME_ORDER.indexOf(state.theme);
    setTheme(THEME_ORDER[(idx + 1) % THEME_ORDER.length]);
  }

  /* ===== 翻页特效 ===== */
  function setEffect(v) {
    state.effect = v;
    elEffectSelect.value = v;
    saveProgress();
  }
  function setAnimSpeed(v) {
    state.animSpeed = v;
    elAnimSpeed.value = v;
    elAnimSpeedVal.textContent = v + 'ms';
    saveProgress();
  }
  function playTransition() {
    if (!elImg.animate || !state.effect || state.effect === 'none') return;
    elImg.getAnimations().forEach(function (a) { a.cancel(); });
    var opts = { duration: state.animSpeed, easing: 'ease-out' };
    if (state.effect === 'fade') {
      elImg.animate([{ opacity: 0 }, { opacity: 1 }], opts);
    } else if (state.effect === 'slide') {
      var dx = state.dir === 'backward' ? -64 : 64;
      elImg.animate(
        [{ opacity: 0, transform: 'translateX(' + dx + 'px)' }, { opacity: 1, transform: 'translateX(0)' }],
        opts
      );
    } else if (state.effect === 'zoom') {
      elImg.animate(
        [{ opacity: 0, transform: 'scale(0.93)' }, { opacity: 1, transform: 'scale(1)' }],
        opts
      );
    }
  }

  /* ===== 缩放与适配 ===== */
  function setFitMode(mode) {
    state.fitMode = mode;
    elFitSelect.value = mode;
    applyFitToImg();
    updateStatusBar();
    saveProgress();
  }
  function setZoomPercent(p) {
    state.zoomPercent = p;
    elZoomBtn.textContent = p + '%';
    if (state.fitMode === 'percent') applyFitToImg();
    updateStatusBar();
    saveProgress();
  }
  function applyFitToImg() {
    var nw = elImg.naturalWidth;
    var mode = state.fitMode;
    elImg.classList.remove('fit-width', 'fit-height', 'fit-original', 'fit-percent');
    elImg.style.width = '';
    if (mode === 'percent' && nw) {
      elImg.classList.add('fit-percent');
      elImg.style.width = Math.round(nw * state.zoomPercent / 100) + 'px';
    } else if (mode === 'height') {
      elImg.classList.add('fit-height');
    } else if (mode === 'original') {
      elImg.classList.add('fit-original');
    } else {
      elImg.classList.add('fit-width');
    }
    updateStatusBar();
  }
  function zoom(delta) {
    if (state.fitMode !== 'percent') setFitMode('percent');
    setZoomPercent(Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], state.zoomPercent + delta)));
  }
  function cycleZoom() {
    if (state.fitMode !== 'percent') setFitMode('percent');
    var idx = ZOOM_STEPS.indexOf(state.zoomPercent);
    var nextIdx = (idx + 1) % ZOOM_STEPS.length;
    setZoomPercent(ZOOM_STEPS[nextIdx]);
  }

  /* ===== 进度记忆 ===== */
  function storageKey() { return 'comicReader:' + state.folderName; }
  var progressSaveTimer = null;
  function saveProgress() {
    if (progressSaveTimer) return;
    progressSaveTimer = setTimeout(persistProgress, 300);
  }
  function persistProgress() {
    progressSaveTimer = null;
    if (!state.folderName || state.files.length === 0) return;
    try {
      localStorage.setItem(storageKey(), JSON.stringify({
        index: state.index,
        normalIndex: state.normalIndex,
        intervalSec: state.intervalSec,
        bgMode: state.theme,
        fitMode: state.fitMode,
        zoomPercent: state.zoomPercent,
        effect: state.effect,
        sortMode: state.sortMode,
        animSpeed: state.animSpeed,
        randomMode: state.randomMode,
        order: state.order
      }));
    } catch (e) { /* 存储不可用时静默 */ }
  }
  function loadProgress() {
    if (!state.folderName) return null;
    try {
      return JSON.parse(localStorage.getItem(storageKey()));
    } catch (e) {
      return null;
    }
  }

  /* ===== 续读提示 ===== */
  function showContinueBar(savedIndex) {
    var target = Math.min(savedIndex, state.files.length - 1);
    elContinueText.textContent = '上次读到第 ' + (target + 1) + ' 页';
    elContinueBar.style.display = 'flex';
    elContinueBtn.onclick = function () { goTo(target); };
    elDismissBtn.onclick = hideContinueBar;
  }
  function hideContinueBar() {
    elContinueBar.style.display = 'none';
  }

  /* ===== 最近打开 ===== */
  function getRecents() {
    try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveRecents(list) {
    try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function addRecent(folderName, handle) {
    if (!folderName) return;
    var list = getRecents();
    var existing = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === folderName) { existing = list[i]; list.splice(i, 1); break; }
    }
    var rec = {
      name: folderName,
      time: Date.now(),
      handleId: existing && existing.handleId ? existing.handleId : null,
      index: state.index,
      total: state.files.length
    };
    if (handle && window.indexedDB) {
      rec.handleId = folderName + '_' + rec.time;
      storeHandle(rec.handleId, handle);
    }
    list.unshift(rec);
    while (list.length > MAX_RECENTS) {
      var old = list.pop();
      if (old.handleId) deleteHandle(old.handleId);
    }
    saveRecents(list);
    renderRecents();
  }
  function renderRecents() {
    var box = document.getElementById('recentBox');
    if (!box) return;
    var list = getRecents();
    if (list.length === 0) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    var ul = document.getElementById('recentList');
    ul.innerHTML = '';
    list.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'recent-item';
      var nameEl = document.createElement('span');
      nameEl.className = 'recent-name';
      nameEl.textContent = r.name;
      nameEl.title = r.name;
      var meta = document.createElement('span');
      meta.className = 'recent-meta';
      var parts = [];
      if (r.total) parts.push((r.index + 1) + '/' + r.total);
      var when = formatTime(r.time);
      if (when) parts.push(when);
      meta.textContent = parts.join(' · ');
      li.appendChild(nameEl);
      li.appendChild(meta);
      li.addEventListener('click', function () { openRecent(r); });
      ul.appendChild(li);
    });
  }
  function formatTime(t) {
    if (!t) return '';
    var d = new Date(t);
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  async function openRecent(r) {
    if (r.handleId && window.indexedDB) {
      try {
        var handle = await getHandle(r.handleId);
        if (handle) {
          var perm = await handle.requestPermission({ mode: 'read' });
          if (perm === 'granted') {
            var entries = await listImagesFromHandle(handle);
            openFromEntries(entries, r.name, handle);
            return;
          }
        }
      } catch (e) { /* 降级到重新选择 */ }
    }
    alert('无法自动重新打开该文件夹，请手动重新选择。');
    elFileInput.click();
  }

  /* ===== IndexedDB 存储目录句柄 ===== */
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        if (!e.target.result.objectStoreNames.contains(DB_STORE)) {
          e.target.result.createObjectStore(DB_STORE);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function storeHandle(id, handle) {
    idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(handle, id);
        tx.oncomplete = res;
        tx.onerror = rej;
        tx.onabort = rej;
      });
    }).catch(function () {});
  }
  function getHandle(id) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(id);
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error); };
      });
    });
  }
  function deleteHandle(id) {
    idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = res;
        tx.onerror = rej;
      });
    }).catch(function () {});
  }

  /* ===== 全屏 =====
     「真」全屏：进入浏览器全屏并隐藏全部界面（顶栏 / 进度条 / 侧栏 / 图片列表 / 状态栏），
     只留图片本身；F 或 Esc 退出。
     真全屏下没有常驻按钮，所以每次操作（动鼠标 / 点击 / 按键）会短暂浮出一个提示层，
     显示「正在自动翻页 / 已暂停、第几页」和操作提示，2.6 秒后自动淡出。 */
  var cursorIdleTimer = null;
  var hudTimer = null;
  var fsHintShown = false;
  var hudByHover = false;      // 这一次提示条是不是「鼠标悬停到底部热区」调出来的

  function updateFsHud() {
    if (!elFsHud) return;
    var playing = state.autoFlip;
    elFsHudState.textContent = playing
      ? '⏸ 自动翻页中 · 每 ' + state.intervalSec + ' 秒一页'
      : '▶ 已暂停';
    elFsHudState.classList.toggle('playing', playing);
    elFsHudPage.textContent = state.files.length
      ? (state.randomMode ? '随机 ' : '') + (state.index + 1) + ' / ' + state.files.length
      : '';
  }
  function showFsHud(fromHover) {
    if (!elFsHud || !state.trueFull) return;
    hudByHover = !!fromHover;      // 悬停调出的才受「移开即收起」约束
    updateFsHud();
    elFsHud.classList.add('show');
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(function () {
      hudTimer = null;
      if (elFsHud) elFsHud.classList.remove('show');
    }, 2600);
  }
  function hideFsHud() {
    hudByHover = false;
    if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
    if (elFsHud) elFsHud.classList.remove('show');
  }

  function enterTrueFull() {
    state.trueFull = true;
    elReader.classList.add('ui-hidden');
    closeHelp();
    if (!document.fullscreenElement && elReader.requestFullscreen) {
      var p = null;
      try { p = elReader.requestFullscreen(); } catch (e) { p = null; }
      if (p && typeof p.catch === 'function') p.catch(function () {});
    }
    updateFullUI();
    armCursorIdle();
    // 第一次进真全屏时把操作方式写清楚（之后只显示播放状态）
    if (!fsHintShown && elFsHudHint) {
      fsHintShown = true;
      elFsHudHint.textContent = '想连续自动翻页：点画面正中间，或按 P（点右侧 / 左侧翻页，Esc 退出全屏）';
    } else if (elFsHudHint) {
      elFsHudHint.textContent = '点画面中间 播放 / 暂停 · 点左右两侧翻页 · P 播放暂停 · Esc 退出全屏';
    }
    showFsHud();
  }
  function exitTrueFull() {
    state.trueFull = false;
    elReader.classList.remove('ui-hidden', 'cursor-idle');
    hideFsHud();
    if (document.fullscreenElement && document.exitFullscreen) {
      try {
        var p = document.exitFullscreen();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    }
    updateFullUI();
  }
  function toggleTrueFull() {
    if (state.trueFull) exitTrueFull(); else enterTrueFull();
  }
  function updateFullUI() {
    elFullBtns.forEach(function (b) {
      b.textContent = state.trueFull ? '⛶ 退出全屏' : '⛶ 真全屏';
      b.classList.toggle('active', state.trueFull);
    });
    updateStatusBar();
  }
  function armCursorIdle() {
    elReader.classList.remove('cursor-idle');
    if (cursorIdleTimer) clearTimeout(cursorIdleTimer);
    if (!state.trueFull) return;
    cursorIdleTimer = setTimeout(function () {
      if (state.trueFull) elReader.classList.add('cursor-idle');
    }, 2000);
  }
  document.addEventListener('fullscreenchange', function () {
    // 用户按 Esc / 浏览器退出全屏时，同步恢复界面
    if (!document.fullscreenElement && state.trueFull) {
      state.trueFull = false;
      elReader.classList.remove('ui-hidden', 'cursor-idle');
      hideFsHud();
      updateFullUI();
    }
  });
  elViewer.addEventListener('mousemove', function (e) {
    if (!state.trueFull) return;
    armCursorIdle();
    // 只有鼠标进到画面底部的小热区才浮出提示条；在画面中间随手动一下不该弹出来
    // （虚拟事件 / 拿不到坐标时一律不弹，宁可不显示也不要误弹）
    if (!e || typeof e.clientY !== 'number') return;
    var fromBottom = elViewer.getBoundingClientRect().bottom - e.clientY;
    if (fromBottom <= FS_HUD_HOT_H) {
      showFsHud(true);
    } else if (hudByHover && fromBottom > FS_HUD_HOT_H + FS_HUD_OUT_H) {
      hideFsHud();
    }
  });

  /* ===== 视图点击区：左/中/右 ===== */
  elViewer.addEventListener('click', function (e) {
    var rect = elViewer.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var ratio = x / rect.width;
    var middle = (ratio >= 0.33 && ratio <= 0.67);
    if (ratio < 0.33) {
      prev();
    } else if (ratio > 0.67) {
      next();
    } else {
      toggleAuto();
    }
    // 只有「播放 / 暂停」才弹状态提示；左右翻页交由 goTo() 把提示条收掉
    if (state.trueFull) { armCursorIdle(); if (middle) showFsHud(); }
  });

  /* 滚轮：Ctrl+滚轮 缩放，否则滚动 */
  elViewer.addEventListener('wheel', function (e) {
    if (e.ctrlKey) {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 25 : -25);
    }
  }, { passive: false });

  /* ===== 键盘快捷键 ===== */
  document.addEventListener('keydown', function (e) {
    var tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

    if (state.trueFull && e.key !== 'Escape') { armCursorIdle(); showFsHud(); }

    if (e.key === 'Escape') {
      if (elHelpModal.style.display !== 'none') { closeHelp(); return; }
      if (state.trueFull) { exitTrueFull(); return; }
      return;
    }

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        next();
        break;
      case ' ':
        e.preventDefault();
        next();
        break;
      case 'ArrowLeft':
        prev();
        break;
      case 'PageDown':
        e.preventDefault();
        next();
        break;
      case 'PageUp':
        e.preventDefault();
        prev();
        break;
      case 'Enter':
        e.preventDefault();
        toggleAuto();
        break;
      case 'p':
      case 'P':
        toggleAuto();
        break;
      case 'f':
      case 'F':
        toggleTrueFull();
        break;
      case '+':
      case '=':
        zoom(25);
        break;
      case '-':
        zoom(-25);
        break;
      case '0':
        setFitMode(DEFAULT_FIT);
        break;
      case 'w':
      case 'W':
        setFitMode('width');
        break;
      case 'h':
      case 'H':
        setFitMode('height');
        break;
      case 'o':
      case 'O':
        setFitMode('original');
        break;
      case 't':
      case 'T':
        toggleThumbPanel();
        break;
      case 'r':
      case 'R':
        toggleRandom();
        break;
      case 's':
      case 'S':
        toggleSidebar();
        break;
      case '?':
        toggleHelp();
        break;
    }
  });

  /* 点过按钮 / 下拉框之后把焦点还回去，避免方向键被控件吃掉 */
  function dropFocus(e) {
    var t = e.target;
    if (t && t.blur && (t.tagName === 'SELECT' || t.tagName === 'INPUT' || t.tagName === 'BUTTON')) {
      t.blur();
    }
  }
  document.addEventListener('change', dropFocus);
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.tagName === 'BUTTON' && t.blur) t.blur();
  });

  /* ===== 控件绑定 ===== */
  $('#openBtn').addEventListener('click', importFolder);
  $('#openBtn2').addEventListener('click', importFolder);
  elFileInput.addEventListener('change', function (e) {
    if (e.target.files && e.target.files.length) openFolder(e.target.files);
    e.target.value = ''; // 允许再次选择同一文件夹
  });

  elInterval.addEventListener('input', function (e) {
    setIntervalSec(parseInt(e.target.value, 10) || 5);
  });
  elProgress.addEventListener('input', function (e) {
    goTo(parseInt(e.target.value, 10) || 0);
  });
  elAutoBtn.addEventListener('click', toggleAuto);
  elRandomBtn.addEventListener('click', toggleRandom);
  elThemeBtn.addEventListener('click', toggleTheme);
  elFitSelect.addEventListener('change', function (e) {
    setFitMode(e.target.value);
  });
  elEffectSelect.addEventListener('change', function (e) {
    setEffect(e.target.value);
  });
  elSortSelect.addEventListener('change', function (e) {
    setSort(e.target.value);
  });
  elAnimSpeed.addEventListener('input', function (e) {
    setAnimSpeed(parseInt(e.target.value, 10) || 400);
  });
  elZoomBtn.addEventListener('click', cycleZoom);
  elListBtn.addEventListener('click', toggleThumbPanel);
  if (elThumbClose) elThumbClose.addEventListener('click', toggleThumbPanel);
  elSidebarBtn.addEventListener('click', toggleSidebar);
  elHelpBtn.addEventListener('click', toggleHelp);
  elHelpClose.addEventListener('click', toggleHelp);
  elHelpModal.addEventListener('click', function (e) {
    if (e.target === elHelpModal) closeHelp(); // 点击遮罩关闭
  });
  elFullBtns.forEach(function (b) { b.addEventListener('click', toggleTrueFull); });
  elPrevBtn.addEventListener('click', prev);
  elNextBtn.addEventListener('click', next);

  /* 关闭页面前落盘待保存的进度 */
  window.addEventListener('beforeunload', function () {
    if (progressSaveTimer) {
      clearTimeout(progressSaveTimer);
      progressSaveTimer = null;
      persistProgress();
    }
  });

  /* ===== 初始化 ===== */
  try {
    if (localStorage.getItem('comicReader:sidebarCollapsed') === '1') {
      elReader.classList.add('sidebar-collapsed');
      elSidebarBtn.classList.remove('active');
    }
  } catch (e) {}
  setTheme('white');
  setFitMode(DEFAULT_FIT);   // 默认：高度适应
  elZoomBtn.textContent = state.zoomPercent + '%';
  elEffectSelect.value = state.effect;
  elSortSelect.value = state.sortMode;
  elAnimSpeed.value = state.animSpeed;
  elAnimSpeedVal.textContent = state.animSpeed + 'ms';
  updateFullUI();
  updateThumbCount();
  renderRecents();
})();
