const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Menu,
  Tray,
  nativeImage,
  protocol,
  clipboard,
} = require("electron");
const path = require("path");
const fs = require("fs");
const stageStore = require("./stage-store");

// 自定义 stage:// 协议：仅供暂存区窗口读取暂存目录内的缩略图/图标（限定目录，安全）
protocol.registerSchemesAsPrivileged([
  {
    scheme: "stage",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Squirrel（安装/更新/卸载事件）：安装时据此创建桌面与开始菜单快捷方式后退出。
if (require("electron-squirrel-startup")) {
  app.quit();
}

// 单实例：避免开机启动与用户手动再次打开时出现多个 StudyFlow 进程
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
});

// 固定 userData 目录：开发版与安装版始终使用 %APPDATA%\studyflow，
// 这样升级或重装后仍能找到已有的待办、设置与本地数据（应用标识稳定）。
try {
  app.setPath("userData", path.join(app.getPath("appData"), "studyflow"));
} catch (err) {
  console.error("设置 userData 目录失败:", err);
}

// 稳定的 AppUserModelID（任务栏 / 通知 / 快捷方式身份一致）
try {
  app.setAppUserModelId("com.studyflow.app");
} catch (err) {
  console.error("设置 AppUserModelID 失败:", err);
}

let win = null;
let tray = null;
let saveTimer = null;
let isQuitting = false;
let current = { bounds: null, locked: false, ratio: null, layer: "desktop", loginAtStartup: false };

const MIN_WIDTH = 220;
const MIN_HEIGHT = 200;

// 比例预设：从「当前屏幕工作区域面积」换算窗口尺寸（等比）
//   square  : 正方形，面积约 = 工作区 / 16
//   r43-16  : 4:3 矩形，面积约 = 工作区 / 16
//   r43-8   : 4:3 矩形，面积约 = 工作区 / 8
const RATIO_PRESETS = {
  square: { aspect: 1, areaDiv: 16 },
  "r43-16": { aspect: 4 / 3, areaDiv: 16 },
  "r43-8": { aspect: 4 / 3, areaDiv: 8 },
};

const stateFile = () => path.join(app.getPath("userData"), "widget-state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeState() {
  if (!win) return;
  try {
    const bounds = win.getBounds();
    current.bounds = bounds;
    fs.writeFileSync(
      stateFile(),
      JSON.stringify(
        {
          bounds,
          locked: current.locked,
          ratio: current.ratio || null,
          layer: current.layer || "desktop",
          loginAtStartup: current.loginAtStartup,
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error("保存小组件状态失败:", err);
  }
}

// 约占屏幕可用面积的 1/8，靠右下角放置
function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const target = (wa.width * wa.height) / 8;
  const aspect = 1.12; // 宽 / 高
  const height = Math.round(Math.sqrt(target / aspect));
  const width = Math.round(height * aspect);
  const margin = 20;
  return {
    x: wa.x + wa.width - width - margin,
    y: wa.y + wa.height - height - margin,
    width,
    height,
  };
}

// 若保存的位置已不在任何屏幕内（如换了显示器），回退到默认位置
function clampBounds(b) {
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const wa = d.workArea;
    return (
      b.x + b.width > wa.x &&
      b.x < wa.x + wa.width &&
      b.y + b.height > wa.y &&
      b.y < wa.y + wa.height
    );
  });
  return visible ? b : defaultBounds();
}

// 依据比例预设与工作区面积计算窗口宽高
function computeRatioSize(ratio, workArea) {
  const preset = RATIO_PRESETS[ratio];
  if (!preset) return null;
  const area = (workArea.width * workArea.height) / preset.areaDiv;
  let height = Math.round(Math.sqrt(area / preset.aspect));
  let width = Math.round(height * preset.aspect);
  width = Math.max(MIN_WIDTH, Math.min(width, workArea.width));
  height = Math.max(MIN_HEIGHT, Math.min(height, workArea.height));
  return { width, height };
}

// 把窗口保持在指定工作区域内（完整可见）
function fitInWorkArea(b, wa) {
  const width = Math.max(MIN_WIDTH, Math.min(b.width, wa.width));
  const height = Math.max(MIN_HEIGHT, Math.min(b.height, wa.height));
  const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - width));
  const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - height));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function applyLock(locked) {
  current.locked = locked;
  if (!win) return;
  win.setMovable(!locked);
  // 缩放由 preload 边缘把手驱动（锁定时把手 pointer-events 关闭、主进程也拒绝 set-bounds）；
  // 原生 resize 配 transparent 窗口在 Windows 上不可用，故始终关闭。
  win.webContents.send("widget:lock-state", locked);
}

// 图层顺序：置顶 = 系统最高置顶级别；桌面底层 = 普通层级（沿用当前默认实现）
function applyLayer(layer) {
  current.layer = layer === "top" ? "top" : "desktop";
  if (!win) return;
  if (current.layer === "top") {
    // Windows 上任何为真值即设置 HWND_TOPMOST；'screen-saver' 是 Electron 最高命名级别
    win.setAlwaysOnTop(true, "screen-saver");
  } else {
    // 切回桌面底层：取消置顶，恢复到原来的普通层级
    win.setAlwaysOnTop(false);
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeState, 300);
}

// ---------- 开机自启动（Windows 登录项，经 app.setLoginItemSettings 实现）----------
// 开发版：process.execPath 是 electron 可执行文件，需把项目目录作为启动参数；
// 安装版：process.execPath 是本应用 StudyFlow.exe，无需额外参数。
function loginArgs() {
  return app.isPackaged ? [] : [app.getAppPath()];
}

// 读取 Windows 当前真实的登录项状态（供设置面板展示）
function getStartupEnabled() {
  try {
    const s = app.getLoginItemSettings({ path: process.execPath, args: loginArgs() });
    return !!(s && s.openAtLogin);
  } catch (err) {
    console.error("读取开机启动状态失败:", err);
    return false;
  }
}

// 应用开机启动开关，返回写入后 Windows 的真实状态
function applyStartup(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: loginArgs(),
    });
  } catch (err) {
    console.error("设置开机启动失败:", err);
  }
  const real = getStartupEnabled();
  current.loginAtStartup = real;
  writeState();
  return real;
}

// 运行时生成一个 32x32 的托盘图标（深色方块 + 三条白线，像清单），
// 避免额外引入图片文件。灰度绘制，不受 BGRA/RGBA 通道顺序影响。
function makeTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const radius = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let r = 28;
      let g = 28;
      let b = 28;
      let a = 255;

      const edgeX = Math.min(x, size - 1 - x);
      const edgeY = Math.min(y, size - 1 - y);
      if (edgeX < radius && edgeY < radius) {
        const dx = radius - edgeX;
        const dy = radius - edgeY;
        if (dx * dx + dy * dy > radius * radius) a = 0;
      }

      const onLine = x >= 8 && x <= 23 &&
        (Math.abs(y - 11) <= 1 || Math.abs(y - 16) <= 1 || Math.abs(y - 21) <= 1);
      if (onLine) {
        r = 255;
        g = 255;
        b = 255;
      }

      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// 优先使用项目里的 icon.png（你指定的图片），
// 其次回退到 tray-icon.png，最后回退到内置图标；任何情况都不会崩溃。
function trayIconImage() {
  const candidates = ["icon.png", "tray-icon.png"];
  for (const name of candidates) {
    try {
      const file = path.join(__dirname, name);
      if (fs.existsSync(file)) {
        const img = nativeImage.createFromPath(file);
        if (!img.isEmpty()) {
          console.log("托盘图标使用: " + name);
          return img;
        }
      }
    } catch (err) {
      console.error("加载托盘图标失败(" + name + "):", err);
    }
  }
  console.log("托盘图标使用: 内置图标（未找到 icon.png / tray-icon.png）");
  return makeTrayIcon();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    if (win.isMinimized()) win.restore();
    win.showInactive();
  }
}

function setupTray() {
  if (tray) return;
  tray = new Tray(trayIconImage());
  tray.setToolTip("学习记录");

  const pasteFromTray = async () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    const result = await doPasteClipboard();
    if (win && !win.isDestroyed()) win.webContents.send("stage:paste-result", result);
  };
  const menu = Menu.buildFromTemplate([
    { label: "显示/隐藏组件", click: toggleWindow },
    { label: "粘贴剪贴板图片", click: pasteFromTray },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  // 左键点击托盘图标也可切换显示/隐藏
  tray.on("click", toggleWindow);
}

function createWindow() {
  const saved = readState();
  let startBounds =
    saved && saved.bounds ? clampBounds(saved.bounds) : defaultBounds();
  const savedRatio =
    saved && saved.ratio && RATIO_PRESETS[saved.ratio] ? saved.ratio : null;
  const savedLayer = saved && saved.layer === "top" ? "top" : "desktop";
  // 若有保存的比例，按比例重算尺寸（保留上次位置，必要时夹回屏幕内）
  if (savedRatio) {
    const disp = screen.getDisplayMatching(startBounds);
    const size = computeRatioSize(savedRatio, disp.workArea);
    if (size) {
      startBounds = fitInWorkArea(
        { x: startBounds.x, y: startBounds.y, width: size.width, height: size.height },
        disp.workArea
      );
    }
  }
  current = {
    bounds: startBounds,
    locked: saved ? !!saved.locked : false,
    ratio: savedRatio,
    layer: savedLayer,
    loginAtStartup: saved ? !!saved.loginAtStartup : false,
  };

  win = new BrowserWindow({
    ...startBounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: !current.locked,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: current.layer === "top",
    title: "学习记录",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));

  // 启动时按保存的图层顺序校正置顶级别（置顶用最高级别，桌面底层为普通层级）
  applyLayer(current.layer);

  win.once("ready-to-show", () => {
    win.showInactive(); // 显示但不抢焦点
    win.webContents.send("widget:lock-state", current.locked);
  });

  // 防止把文件拖到页面时触发页面跳转（拖放由渲染层在组件内处理）
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  win.on("moved", scheduleSave);
  win.on("resized", scheduleSave);
  win.on("move", scheduleSave);

  // 关闭窗口 = 隐藏到托盘；只有托盘“退出”才真正结束程序
  win.on("close", (event) => {
    if (isQuitting) {
      writeState();
      return;
    }
    event.preventDefault();
    writeState();
    win.hide();
  });
}

ipcMain.handle("widget:get-lock", () => current.locked);

// 软件缩放：由 preload 的边缘拖拽处理计算新宽高/位置；锁定时拒绝。
// 调整宽高会清除已选比例（转为自定义尺寸），持久化由 'resized' 事件统一保存。
ipcMain.handle("widget:set-bounds", (_event, size) => {
  if (!win || !size) return false;
  if (current.locked) return false;
  try {
    current.ratio = null;
    const width = Math.max(MIN_WIDTH, Math.round(size.width));
    const height = Math.max(MIN_HEIGHT, Math.round(size.height));
    const box = { width, height };
    if (typeof size.x === "number") box.x = Math.round(size.x);
    if (typeof size.y === "number") box.y = Math.round(size.y);
    win.setBounds(box);
    scheduleSave();
    return true;
  } catch (err) {
    console.error("调整组件大小失败:", err);
    return false;
  }
});

ipcMain.handle("widget:get-ratio", () => current.ratio);

// 按比例调整组件大小：基于窗口当前所在屏幕的工作区域，保持完整可见并持久化
ipcMain.handle("widget:set-ratio", (_event, ratio) => {
  if (!win || !RATIO_PRESETS[ratio]) return false;
  try {
    const disp = screen.getDisplayMatching(win.getBounds());
    const size = computeRatioSize(ratio, disp.workArea);
    if (!size) return false;
    const cur = win.getBounds();
    const next = fitInWorkArea(
      { x: cur.x, y: cur.y, width: size.width, height: size.height },
      disp.workArea
    );
    win.setBounds(next);
    current.ratio = ratio;
    writeState();
    return true;
  } catch (err) {
    console.error("设置比例失败:", err);
    return false;
  }
});

ipcMain.handle("widget:get-layer", () => current.layer || "desktop");

// 修改图层顺序：桌面底层 <-> 置顶（立即生效并持久化）
ipcMain.handle("widget:set-layer", (_event, layer) => {
  if (!win) return false;
  try {
    applyLayer(layer);
    writeState();
    return current.layer;
  } catch (err) {
    console.error("切换图层顺序失败:", err);
    return false;
  }
});

ipcMain.handle("widget:toggle-lock", () => {
  applyLock(!current.locked);
  writeState();
  return current.locked;
});

// 开机启动（渲染层只通过这些受限 IPC，不直接调用原生 API）
ipcMain.handle("login:get", () => getStartupEnabled());
ipcMain.handle("login:set", (_event, enabled) => applyStartup(!!enabled));

// 软件拖动：获取窗口当前 bounds（含宽高，供拖动时固定尺寸使用）
ipcMain.handle("widget:get-bounds", () => {
  if (!win) return null;
  return win.getBounds();
});
// 移动窗口（只改位置，不改大小）。注意：透明无边框窗口反复调用 win.setPosition
// 会累计放大尺寸（Electron/Windows 特性），因此这里用 setBounds 并显式固定宽高
// （传入拖动开始时捕获的原始大小），保证拖动只平移窗口、尺寸不变。
ipcMain.handle("widget:move-to", (_event, box) => {
  if (!win || !box || current.locked) return false;
  try {
    win.setBounds({
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    });
    return true;
  } catch (err) {
    console.error("移动窗口失败:", err);
    return false;
  }
});

// ---------- 暂存区 IPC（渲染层仅能通过这些受限接口操作暂存目录） ----------
ipcMain.handle("stage:list", () => stageStore.list());
ipcMain.handle("stage:add", async (_event, paths) => {
  if (!Array.isArray(paths)) {
    console.error("[stage:add] 收到非数组参数:", typeof paths);
    return { items: stageStore.list(), errors: [] };
  }
  const list = paths.filter((p) => typeof p === "string");
  console.log("[stage:add] 收到 " + list.length + " 个路径:", list);
  try {
    const result = await stageStore.addFiles(list);
    console.log(
      "[stage:add] 完成 items=" +
        (result.items || []).length +
        " errors=" +
        JSON.stringify(result.errors || [])
    );
    return result;
  } catch (err) {
    // 不让异常冒泡到渲染层触发 dev 的 blocking 错误浮层；记录完整堆栈
    console.error("[stage:add] 未捕获异常:", err && (err.stack || err));
    return {
      items: stageStore.list(),
      errors: [{ name: "拖入项", reason: "内部错误(" + ((err && err.code) || "ERR") + ")" }],
    };
  }
});

// 无本地路径、但有可读字节的拖入内容（如从聊天窗口拖出的图片）
ipcMain.handle("stage:add-data", async (_event, payloads) => {
  if (!Array.isArray(payloads)) {
    console.error("[stage:add-data] 收到非数组参数");
    return { items: stageStore.list(), errors: [] };
  }
  console.log(
    "[stage:add-data] 收到 " +
      payloads.length +
      " 个数据项: " +
      payloads.map((p) => (p && p.name ? p.name : "?") + "(" + (p && p.data ? (p.data.byteLength || p.data.length) : 0) + "B)").join(", ")
  );
  try {
    const result = await stageStore.addBuffers(payloads);
    console.log(
      "[stage:add-data] 完成 items=" +
        (result.items || []).length +
        " errors=" +
        JSON.stringify(result.errors || [])
    );
    return result;
  } catch (err) {
    console.error("[stage:add-data] 未捕获异常:", err && (err.stack || err));
    return {
      items: stageStore.list(),
      errors: [{ name: "拖入数据", reason: "内部错误(" + ((err && err.code) || "ERR") + ")" }],
    };
  }
});
ipcMain.handle("stage:open", (_event, id) => stageStore.open(id));
ipcMain.handle("stage:drag-info", (_event, id) => stageStore.dragInfo(id));
ipcMain.handle("stage:remove", (_event, id) => stageStore.remove(id));
ipcMain.handle("stage:clear", () => stageStore.clear());

// 渲染层拖放诊断转发到终端（开发排查用；不含文件内容）
ipcMain.on("stage:diag", (_event, msg) => {
  console.log("[stage-render]", typeof msg === "string" ? msg : JSON.stringify(msg));
});

// 从组件把暂存图标拖出到资源管理器：用 Electron 原生 startDrag 生成可用的文件/文件夹
ipcMain.on("stage:drag-out", (event, id) => {
  const info = stageStore.dragInfo(id);
  if (!info) return;
  let icon = null;
  try {
    if (info.iconPath) icon = nativeImage.createFromPath(info.iconPath);
  } catch {}
  if (!icon || icon.isEmpty()) {
    try {
      icon = nativeImage.createFromPath(path.join(__dirname, "tray-icon.png"));
    } catch {}
  }
  const dragObject = { file: info.path, files: [info.path] };
  if (icon && !icon.isEmpty()) dragObject.icon = icon;
  try {
    event.sender.startDrag(dragObject);
  } catch (err) {
    console.error("拖出暂存内容失败:", err);
  }
});

// 剪贴板图片粘贴：读系统剪贴板位图（不依赖渲染层 clipboardData），非图片时明确返回未粘贴
async function doPasteClipboard() {
  try {
    const img = clipboard.readImage();
    const empty = !img || img.isEmpty();
    const size = empty ? { width: 0, height: 0 } : img.getSize();
    console.log("[stage:paste] 剪贴板图片 isEmpty=" + empty + " size=" + size.width + "x" + size.height);
    if (empty) {
      return { pasted: false, count: 0, items: stageStore.list(), errors: [], reason: "empty" };
    }
    const buf = img.toPNG();
    const name = "clipboard-" + Date.now() + ".png";
    const result = await stageStore.addBuffers([{ name, type: "image/png", data: buf }]);
    const errors = result.errors || [];
    console.log("[stage:paste] 保存完成 items=" + (result.items || []).length + " errors=" + JSON.stringify(errors));
    return {
      pasted: errors.length === 0,
      count: errors.length === 0 ? 1 : 0,
      items: result.items || stageStore.list(),
      errors,
      reason: errors.length ? "save-failed" : "ok",
    };
  } catch (err) {
    console.error("[stage:paste] 异常:", err && (err.stack || err));
    return { pasted: false, count: 0, items: stageStore.list(), errors: [], reason: "error" };
  }
}

ipcMain.handle("stage:paste-clipboard", () => doPasteClipboard());

// 点击组件时聚焦窗口，保证 Ctrl+V 能被渲染层收到
ipcMain.on("widget:focus", () => {
  if (win && !win.isDestroyed()) {
    try {
      win.focus();
    } catch {}
  }
});

app.whenReady().then(() => {
  if (!singleInstanceLock) return;

  protocol.handle("stage", (request) => {
    try {
      const url = new URL(request.url);
      const name = decodeURIComponent((url.pathname || "").replace(/^\/+/, ""));
      const p = stageStore.safePath(name);
      if (!p || !fs.existsSync(p)) {
        return new Response("Not found", { status: 404 });
      }
      const data = fs.readFileSync(p);
      return new Response(data, {
        headers: { "content-type": stageStore.mimeFor(name) },
      });
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });
  Menu.setApplicationMenu(null);
  createWindow();
  setupTray();

  // 若上次开启了开机启动，每次启动都重新写入一次登录项，使注册表路径指向
  // 当前可执行文件（安装包升级后版本目录会变化，避免旧路径失效）
  const savedForStart = readState();
  if (savedForStart && savedForStart.loginAtStartup) applyStartup(true);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
