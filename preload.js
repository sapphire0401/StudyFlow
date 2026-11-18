const { ipcRenderer, contextBridge, webUtils } = require("electron");

// 暴露受限的“组件内文件暂存”API 给页面（app.js）使用。
// 文件系统操作全部在主进程；这里只提供取路径与受限 IPC，不开放任意文件访问。
contextBridge.exposeInMainWorld("stageAPI", {
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === "function") {
        const p = webUtils.getPathForFile(file);
        if (p) return p;
      }
    } catch {}
    // 兜底：旧版本/特殊来源下尝试 file.path（Electron 32+ 已移除，仅作兼容）
    try {
      if (file && typeof file.path === "string" && file.path) return file.path;
    } catch {}
    return "";
  },
  add: (paths) => ipcRenderer.invoke("stage:add", paths),
  addData: (items) => ipcRenderer.invoke("stage:add-data", items),
  pasteClipboard: () => ipcRenderer.invoke("stage:paste-clipboard"),
  onPasteResult: (cb) => ipcRenderer.on("stage:paste-result", (_e, r) => cb(r)),
  list: () => ipcRenderer.invoke("stage:list"),
  open: (id) => ipcRenderer.invoke("stage:open", id),
  remove: (id) => ipcRenderer.invoke("stage:remove", id),
  dragOut: (id) => ipcRenderer.send("stage:drag-out", id),
  diag: (msg) => ipcRenderer.send("stage:diag", msg),
  clear: () => ipcRenderer.invoke("stage:clear"),
  assetUrl: (name) => "stage://asset/" + encodeURIComponent(name),
});

// 将锁定/解锁按钮和“设置”按钮注入到 index.html 的顶部控制栏（#widget-actions）同一行，
// 并负责：背景透明度滑块（仅改变 .panel 背景 alpha，文字/按钮/待办保持不透明）、
// 锁定状态与边缘拖拽缩放（transparent 窗口原生不可缩放，故用软件实现）。
// 不修改 index.html / styles.css / app.js 原文件。

const ALPHA_KEY = "studyflow.bg-alpha.v1";
const DEFAULT_TRANSPARENCY = 8; // 0 = 完全不透明，90 = 近乎透明；与样式表默认 --bg-alpha 0.92 对应
const MIN_WIDTH = 220;
const MIN_HEIGHT = 200;

const ICON_LOCKED = `
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true" focusable="false">
    <rect x="4" y="11" width="16" height="10" rx="2"></rect>
    <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
  </svg>`;
const ICON_UNLOCKED = `
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true" focusable="false">
    <rect x="4" y="11" width="16" height="10" rx="2"></rect>
    <path d="M8 11V7a4 4 0 0 1 7.5-2"></path>
  </svg>`;
const ICON_SETTINGS = `
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
       stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82-.33l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.09A1.65 1.65 0 0 0 12 18a1.65 1.65 0 0 0 1-1.51V14a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1.82.33l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1-.15V9a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51z"></path>
  </svg>`;

let locked = false;
let pendingBounds = false;
let adjustMode = false; // “自由调整大小”模式开关
let refreshResizeHandles = () => {}; // 由 setupResize 赋值：按 adjustMode/locked 启用或禁用把手
let renderAdjustSwitch = () => {}; // 由设置面板赋值：刷新开关显示

function $(sel, root = document) {
  return root.querySelector(sel);
}

// ---------- 透明度（仅改 .panel 背景 alpha，不影响文字/按钮/待办） ----------

function loadTransparency() {
  try {
    const raw = localStorage.getItem(ALPHA_KEY);
    // 未设置过（首次）才用默认值；已保存的值（含 0）原样保留，绝不重置
    if (raw === null || raw === "") return DEFAULT_TRANSPARENCY;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0 && v <= 90) return v;
  } catch {}
  return DEFAULT_TRANSPARENCY;
}
function saveTransparency(v) {
  try {
    localStorage.setItem(ALPHA_KEY, String(v));
  } catch {}
}
function applyTransparency(t) {
  // alpha = 1 - 透明度/100；下限 0.05 避免背景完全消失
  const alpha = Math.max(0.05, 1 - t / 100);
  document.documentElement.style.setProperty("--bg-alpha", String(alpha));
}

// ---------- 锁定/解锁 ----------

function renderLock(l) {
  locked = l;
  if (l) adjustMode = false; // 锁定时强制退出调整模式
  const btn = $("#sf-lock");
  const body = document.body;
  body.classList.toggle("widget-locked", l);
  if (btn) {
    btn.innerHTML = l ? ICON_LOCKED : ICON_UNLOCKED;
    btn.title = l ? "解锁位置" : "锁定位置";
    btn.setAttribute("aria-label", l ? "解锁" : "锁定");
  }
  refreshResizeHandles();
  renderAdjustSwitch();
}
async function toggleLock() {
  const next = await ipcRenderer.invoke("widget:toggle-lock");
  renderLock(next);
}

// ---------- 边缘拖拽缩放（transparent 窗口原生不可缩放，故用软件实现） ----------

function setupResize() {
  const panel = document.querySelector(".panel");
  const topbar = document.querySelector(".topbar");
  if (!panel || !topbar) return;

  const topbarH = topbar.getBoundingClientRect().height || 44;

  const EDGE = 6; // 边把手厚度（贴窗口真实边缘，避免挡到内容按钮）
  const CORNER = 12; // 角把手尺寸
  const dirs = ["e", "w", "s", "n", "se", "sw", "ne", "nw"];
  const handles = {};
  for (const d of dirs) {
    const h = document.createElement("div");
    h.className = "resize-handle resize-" + d;
    handles[d] = h;
  }

  const style = document.createElement("style");
  style.textContent = `
    .resize-handle {
      position: absolute;
      z-index: 45; /* 低于设置面板(50)，高于内容 */
      -webkit-app-region: no-drag;
      pointer-events: none; /* 默认不响应；调整模式下由脚本启用 */
    }
    .resize-e { right: 0; top: 0; bottom: ${CORNER}px; width: ${EDGE}px; cursor: ew-resize; }
    .resize-w { left: 0; top: 0; bottom: ${CORNER}px; width: ${EDGE}px; cursor: ew-resize; }
    .resize-s { bottom: 0; left: ${CORNER}px; right: ${CORNER}px; height: ${EDGE}px; cursor: ns-resize; }
    .resize-n { top: 0; left: ${CORNER}px; right: ${CORNER}px; height: ${EDGE}px; cursor: ns-resize; }
    .resize-se { right: 0; bottom: 0; width: ${CORNER}px; height: ${CORNER}px; cursor: nwse-resize; }
    .resize-sw { left: 0; bottom: 0; width: ${CORNER}px; height: ${CORNER}px; cursor: nesw-resize; }
    .resize-ne { right: 0; top: 0; width: ${CORNER}px; height: ${CORNER}px; cursor: nesw-resize; }
    .resize-nw { left: 0; top: 0; width: ${CORNER}px; height: ${CORNER}px; cursor: nwse-resize; }
    .panel.resize-mode { box-shadow: inset 0 0 0 1px rgba(28, 28, 28, 0.28); }
    .widget-locked .resize-handle { pointer-events: none; }
  `;
  document.head.appendChild(style);
  panel.style.position = panel.style.position || "relative";
  for (const d of dirs) panel.appendChild(handles[d]);

  // 按“调整模式 && 未锁定”启用/禁用把手（关闭时不响应边缘拖动）
  const applyHandles = () => {
    const on = adjustMode && !locked;
    for (const d of dirs) handles[d].style.pointerEvents = on ? "auto" : "none";
    panel.classList.toggle("resize-mode", on);
  };
  refreshResizeHandles = applyHandles;
  applyHandles();

  let resizing = null;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let startPosX = 0;
  let startPosY = 0;
  let lastBox = null;
  let resizeTimer = null;

  async function begin(dir, event) {
    if (locked || !adjustMode) return; // 仅“调整模式且未锁定”时响应
    event.preventDefault();
    resizing = dir;
    const rect = panel.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    let b = null;
    try {
      b = await ipcRenderer.invoke("widget:get-bounds");
    } catch {}
    // 用窗口真实 bounds 作为起始尺寸，避免横拖/竖拖时另一维度被误改
    startW = b ? b.width : rect.width;
    startH = b ? b.height : rect.height;
    startPosX = b ? b.x : 0;
    startPosY = b ? b.y : 0;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onEnd);
  }

  function onMove(event) {
    if (!resizing) return;
    event.preventDefault();
    const dir = resizing;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    let w = startW;
    let h = startH;
    let x = startPosX;
    let y = startPosY;
    if (dir.indexOf("e") !== -1) w = Math.max(MIN_WIDTH, startW + dx);
    if (dir.indexOf("w") !== -1) {
      w = Math.max(MIN_WIDTH, startW - dx);
      x = startPosX + (startW - w); // 固定右边缘，左边缘随鼠标移动
    }
    if (dir.indexOf("s") !== -1) h = Math.max(MIN_HEIGHT, startH + dy);
    if (dir.indexOf("n") !== -1) {
      h = Math.max(MIN_HEIGHT, startH - dy);
      y = startPosY + (startH - h); // 固定下边缘
    }
    lastBox = { x, y, width: w, height: h };
    if (!resizeTimer) resizeTimer = setTimeout(flushResize, 16);
  }

  function flushResize() {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    if (!lastBox) return;
    const b = lastBox;
    lastBox = null;
    ipcRenderer.invoke("widget:set-bounds", b);
  }

  function onEnd() {
    resizing = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onEnd);
    flushResize(); // 立即应用最终尺寸（不依赖可能被节流的定时器/动画帧）
  }

  for (const d of dirs) {
    handles[d].addEventListener("mousedown", (e) => begin(d, e));
  }
}

// ---------- 空白区域软件拖动窗口（替代“仅顶部可拖”）----------
// 说明：原先仅在顶栏使用 -webkit-app-region: drag；这样只有顶栏能拖、且会吞掉鼠标事件。
// 改为整窗统一的鼠标事件拖动：在非交互控件区域按下左键即可平移窗口；锁定时不生效。
function isInteractiveTarget(target) {
  if (!target || !target.closest) return false;
  return !!target.closest(
    "button, input, textarea, select, a[href], [contenteditable='true'], [role='button'], " +
      ".record, .desk-file, .day-cell, .date-arrow, .date-today, .nav-btn, .stats-btn, .icon-btn, " +
      ".settings-popover, .settings-menu-item, .resize-handle, .fab, .composer, .topbar-actions"
  );
}

function setupWindowDrag() {
  const panel = document.querySelector(".panel");
  if (!panel) return;
  let drag = null;

  function onMove(event) {
    if (!drag) return;
    event.preventDefault();
    const x = drag.winX + (event.screenX - drag.startX);
    const y = drag.winY + (event.screenY - drag.startY);
    if (drag.raf) cancelAnimationFrame(drag.raf);
    drag.raf = requestAnimationFrame(() => {
      // 只平移：固定拖动开始时捕获的宽高，避免透明窗口反复移动导致尺寸变大
      ipcRenderer.invoke("widget:move-to", { x, y, width: drag.w, height: drag.h });
      if (drag) drag.raf = null;
    });
  }
  function onUp() {
    cleanup();
  }
  function onEsc(e) {
    if (e.key === "Escape") cleanup();
  }
  function cleanup() {
    if (drag && drag.raf) cancelAnimationFrame(drag.raf);
    drag = null;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onEsc);
  }

  panel.addEventListener("mousedown", async (event) => {
    if (event.button !== 0 || locked) return; // 锁定时不拖动
    if (isInteractiveTarget(event.target)) return; // 交互控件不拖动，正常点击/输入
    // 空白区域：开始拖动窗口
    event.preventDefault();
    let bounds = null;
    try {
      bounds = await ipcRenderer.invoke("widget:get-bounds");
    } catch {}
    if (!bounds) return;
    drag = {
      startX: event.screenX,
      startY: event.screenY,
      winX: bounds.x,
      winY: bounds.y,
      w: bounds.width,
      h: bounds.height,
      raf: null,
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onEsc);
  });
}

// ---------- 顶部控制栏：设置 + 锁定按钮 ----------

function setupWidgetChrome() {
  const actions = document.getElementById("widget-actions");
  if (!actions || document.getElementById("sf-lock")) return;

  let refreshStartup = null;

  const settings = document.createElement("button");
  settings.type = "button";
  settings.id = "sf-settings";
  settings.className = "icon-btn";
  settings.setAttribute("aria-label", "设置");
  settings.title = "设置";
  settings.innerHTML = ICON_SETTINGS;

  const lock = document.createElement("button");
  lock.type = "button";
  lock.id = "sf-lock";
  lock.className = "icon-btn";
  lock.setAttribute("aria-label", "锁定");
  lock.title = "锁定位置";
  lock.innerHTML = ICON_UNLOCKED;

  // 透明度：保留功能与已保存的设置（按保存值应用；调节入口本期暂不开放）
  applyTransparency(loadTransparency());

  const popover = document.createElement("div");
  popover.className = "settings-popover";
  popover.hidden = true;
  popover.innerHTML = `
    <p class="settings-title">设置</p>
    <div class="settings-menu">
      <button type="button" class="settings-menu-item" data-item="alpha" aria-expanded="false">
        <span>调整透明度</span>
        <span class="settings-right"><span class="settings-alpha-val"></span><span class="settings-caret">▸</span></span>
      </button>
      <div class="settings-sub settings-sub-alpha" hidden>
        <input type="range" id="sf-alpha" min="0" max="90" step="1">
      </div>
      <button type="button" class="settings-menu-item" data-item="ratio" aria-expanded="false">
        <span>更改比例</span><span class="settings-caret">▸</span>
      </button>
      <div class="settings-sub settings-sub-ratio" hidden>
        <button type="button" class="ratio-option" data-ratio="square">正方形</button>
        <button type="button" class="ratio-option" data-ratio="r43-16">4:3 · 约 1/16 屏</button>
        <button type="button" class="ratio-option" data-ratio="r43-8">4:3 · 约 1/8 屏</button>
        <button type="button" class="settings-menu-item settings-toggle settings-sub-toggle" data-item="adjust" aria-pressed="false">
          <span>自由调整大小</span>
          <span class="settings-right"><span class="switch" aria-hidden="true"><span class="switch-knob"></span></span></span>
        </button>
      </div>
      <button type="button" class="settings-menu-item" data-item="layer" aria-expanded="false">
        <span>修改图层顺序</span><span class="settings-caret">▸</span>
      </button>
      <div class="settings-sub settings-sub-layer" hidden>
        <button type="button" class="ratio-option" data-layer="desktop">桌面底层</button>
        <button type="button" class="ratio-option" data-layer="top">置顶</button>
      </div>
      <button type="button" class="settings-menu-item settings-toggle" data-item="startup" aria-pressed="false">
        <span>开机启动</span>
        <span class="settings-right"><span class="switch" aria-hidden="true"><span class="switch-knob"></span></span></span>
      </button>
    </div>
  `;
  document.body.appendChild(popover);

  // 三个可展开项：调整透明度 / 更改比例 / 修改图层顺序（互斥展开）
  const panes = [
    { toggle: popover.querySelector('[data-item="alpha"]'), sub: popover.querySelector(".settings-sub-alpha") },
    { toggle: popover.querySelector('[data-item="ratio"]'), sub: popover.querySelector(".settings-sub-ratio") },
    { toggle: popover.querySelector('[data-item="layer"]'), sub: popover.querySelector(".settings-sub-layer") },
  ].filter((p) => p.toggle && p.sub);

  function setOpen(toggle, subEl, open) {
    subEl.hidden = !open;
    toggle.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  }
  for (const pane of panes) {
    pane.toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const shouldOpen = pane.sub.hidden; // 当前收起则展开
      for (const p of panes) {
        setOpen(p.toggle, p.sub, p.toggle === pane.toggle ? shouldOpen : false);
      }
    });
  }

  // 透明度滑块：只改 .panel 背景 alpha，立即生效并持久化（沿用原保存键）
  const alphaInput = popover.querySelector("#sf-alpha");
  const alphaVal = popover.querySelector(".settings-alpha-val");
  function renderAlpha(v) {
    alphaInput.value = String(v);
    if (alphaVal) alphaVal.textContent = v + "%";
  }
  renderAlpha(loadTransparency());
  alphaInput.addEventListener("input", () => {
    const t = +alphaInput.value;
    if (alphaVal) alphaVal.textContent = t + "%";
    applyTransparency(t);
    saveTransparency(t);
  });

  // 比例选项（仅限比例子项内的按钮，避免与图层选项混淆）
  const ratioButtons = Array.from(popover.querySelectorAll(".settings-sub-ratio .ratio-option"));
  function markRatio(active) {
    ratioButtons.forEach((b) =>
      b.classList.toggle("is-active", b.dataset.ratio === active)
    );
  }
  ratioButtons.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.ratio;
      const ok = await ipcRenderer.invoke("widget:set-ratio", id);
      if (ok) {
        markRatio(id);
        // 选固定比例即退出自由调整模式
        adjustMode = false;
        refreshResizeHandles();
        renderAdjustSwitch();
      }
    });
  });
  // 页面加载时标记当前比例
  ipcRenderer.invoke("widget:get-ratio").then((r) => {
    if (r) markRatio(r);
  });

  // 图层顺序选项：桌面底层 / 置顶
  const layerButtons = Array.from(
    popover.querySelectorAll(".settings-sub-layer .ratio-option")
  );
  function markLayer(active) {
    layerButtons.forEach((b) =>
      b.classList.toggle("is-active", b.dataset.layer === active)
    );
  }
  layerButtons.forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.layer;
      const applied = await ipcRenderer.invoke("widget:set-layer", id);
      if (applied) markLayer(applied);
    });
  });
  ipcRenderer.invoke("widget:get-layer").then((l) => {
    if (l) markLayer(l);
  });

  // 开机启动：只读/写 Windows 登录项，渲染层不直接调用原生 API
  (function setupStartupToggle() {
    const btn = popover.querySelector('[data-item="startup"]');
    if (!btn) return;
    function render(on) {
      btn.classList.toggle("is-on", !!on);
      btn.setAttribute("aria-pressed", String(!!on));
    }
    refreshStartup = () => ipcRenderer.invoke("login:get").then(render).catch(() => {});
    // 初始用 OS 真实状态展示（异步）
    refreshStartup();
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = !btn.classList.contains("is-on");
      try {
        const applied = await ipcRenderer.invoke("login:set", next);
        render(applied);
      } catch {
        ipcRenderer.invoke("login:get").then(render).catch(() => {});
      }
    });
  })();

  // 自由调整大小：开关进入/退出“调整模式”，四边四角把手仅在开启且未锁定时响应
  (function setupAdjustToggle() {
    const btn = popover.querySelector('[data-item="adjust"]');
    if (!btn) return;
    renderAdjustSwitch = () => {
      const usable = !locked;
      const on = adjustMode && usable;
      btn.classList.toggle("is-on", on);
      btn.classList.toggle("is-disabled", !usable);
      btn.setAttribute("aria-pressed", String(on));
      btn.setAttribute("aria-disabled", String(!usable));
      btn.style.opacity = usable ? "" : "0.45";
    };
    renderAdjustSwitch();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (locked) return; // 锁定状态下不可进入
      adjustMode = !adjustMode;
      if (adjustMode) markRatio(null); // 进入自由调整时清除固定比例高亮
      refreshResizeHandles();
      renderAdjustSwitch();
    });
  })();

  function toggleSettings() {
    popover.hidden = !popover.hidden;
    // 重新打开设置面板时，始终用 Windows 真实状态刷新开关
    if (!popover.hidden && refreshStartup) refreshStartup();
  }

  settings.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSettings();
  });
  lock.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleLock();
  });

  actions.append(settings, lock);

  // 点击菜单/子菜单外部关闭菜单，并吞掉这次点击，避免误触背后的按钮或操作；
  // 但顶栏控件（日/周/月、统计、齿轮、锁定）需放行，正常执行其操作
  function isTopbarControl(node) {
    return !!(node && node.closest && node.closest(".nav, .stats-btn, .topbar-actions"));
  }
  document.addEventListener(
    "mousedown",
    (e) => {
      if (popover.hidden) return;
      if (popover.contains(e.target) || settings.contains(e.target)) return;
      if (isTopbarControl(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
  document.addEventListener(
    "click",
    (e) => {
      if (popover.hidden) return;
      if (popover.contains(e.target) || settings.contains(e.target)) return;
      if (isTopbarControl(e.target)) {
        // 顶栏按钮：关闭菜单，但不吞事件，让其正常执行
        popover.hidden = true;
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      popover.hidden = true;
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") popover.hidden = true;
  });

  setupResize();
  setupWindowDrag();

  // 点击组件时让窗口获得键盘焦点：拖动空白区的 mousedown 会 preventDefault，
  // 若不显式聚焦，窗口拿不到焦点，Ctrl+V 就收不到。这里在主进程侧聚焦窗口。
  window.addEventListener(
    "mousedown",
    () => {
      try {
        ipcRenderer.send("widget:focus");
      } catch {}
    },
    true
  );

  ipcRenderer.on("widget:lock-state", (_event, l) => renderLock(l));
  ipcRenderer.invoke("widget:get-lock").then((l) => renderLock(l));
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", setupWidgetChrome);
} else {
  setupWidgetChrome();
}
