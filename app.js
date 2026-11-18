// 待办数据沿用原有存储键，保证旧数据不丢。
const STORAGE_KEY = "study-tracker.v1";
// 灵感 memo 单独存储，关闭重开后仍保留。
const MEMO_KEY = "study-tracker.memos.v1";
// 事件记录单独存储，同样持久化。
const EVENT_KEY = "study-tracker.events.v1";
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
// 周视图 / 月视图表头用的单字星期（周一起始，故按 getDay() 查表）
const WEEK_SHORT = ["日", "一", "二", "三", "四", "五", "六"];

// 三个固定选项，自上而下：灵感、待办、事件（待办居中：向上=灵感，向下=事件，不循环）
const TYPE_DISPLAY = ["memo", "todo", "event"];
const TYPE_LABEL = { todo: "待办", event: "事件", memo: "灵感" };
const COMPOSER_PLACEHOLDER = "记录选中日期的任务、事件或想法，回车保存";

// TODO(后续): 图片/文件临时中转站、未完成任务迁移等。本次不实现。

const state = {
  mode: "day", // 日期视图："day" | "week" | "month"
  selectedDate: startOfDay(new Date()), // 当前选中日期（用于查看/新增记录）
  statsOpen: false, // 统计是否展开（独立入口，不占用日/周/月主导航）
  data: loadData(),
  memos: loadMemos(),
  events: loadEvents(),
  composerType: "todo", // 新增输入框当前选中的记录类型
  composerDraft: "", // 保留输入框草稿，避免切换视图/勾选待办时丢失
  composerOpen: false, // 新增区域是否展开（默认收起，只显示「+」）
  contextMenu: null, // 右键菜单目标 { kind, id }
  editingRecord: null, // 正在编辑的记录 { kind, id }
  editDraft: "", // 编辑中的文字
};

// 保证同一毫秒内连续新增也能得到严格递增的时间戳，从而稳定排序
let lastTimestamp = 0;
function nextTimestamp() {
  const t = Math.max(Date.now(), lastTimestamp + 1);
  lastTimestamp = t;
  return t;
}

const app = document.getElementById("app");

// 主导航：日 / 周 / 月
document.querySelectorAll("[data-mode]").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

// 统计入口（顶部右侧的次级按钮，不占日/周/月主导航）
const statsNavBtn = document.querySelector('[data-view="stats"]');
if (statsNavBtn) {
  statsNavBtn.addEventListener("click", () => {
    state.statsOpen = true;
    render();
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});

// Esc：依次收起右键菜单 / 新增栏 / 统计
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.contextMenu) {
    event.preventDefault();
    hideContextMenu();
    return;
  }
  if (state.composerOpen) {
    event.preventDefault();
    cancelComposer();
    return;
  }
  if (state.statsOpen) {
    event.preventDefault();
    state.statsOpen = false;
    render();
  }
});

// 取消新建：清空尚未保存的草稿并收起（不影响已保存的数据与保存逻辑）
function cancelComposer() {
  state.composerDraft = "";
  state.composerType = "todo";
  state.composerOpen = false;
  render();
}

// 顶栏可操作控件（日/周/月、统计、齿轮、锁定）：点击它们应正常生效，不拦截
function isTopbarControl(node) {
  return !!(node && node.closest && node.closest(".nav, .stats-btn, .topbar-actions"));
}

// 新建区域展开时：点击输入区域外部即取消新建；
// 但点击顶栏按钮要放行（正常执行），点击其他空白则吞掉点击避免误触背后按钮
document.addEventListener(
  "mousedown",
  (event) => {
    if (!state.composerOpen) return;
    const composer = document.querySelector(".composer");
    if (!composer || composer.contains(event.target)) return;
    if (isTopbarControl(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  },
  true
);
document.addEventListener(
  "click",
  (event) => {
    if (!state.composerOpen) return;
    const composer = document.querySelector(".composer");
    if (!composer || composer.contains(event.target)) return;
    if (isTopbarControl(event.target)) {
      // 放行顶栏按钮；同时收起未保存的新建（清空草稿）
      cancelComposer();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelComposer();
  },
  true
);

render();

/* ---------------- 日期工具 ---------------- */

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return startOfDay(d);
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// 选中日期所在周的周一
function mondayOf(date) {
  const d = startOfDay(date);
  const wd = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  return addDays(d, -wd);
}

function activeKey() {
  return dateKey(state.selectedDate);
}

// "YYYY-MM-DD" -> "M月D日"
function formatMD(key) {
  const parts = String(key).split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return key;
  return `${parts[1]}月${parts[2]}日`;
}

/* ---------------- 视图切换 ---------------- */

function setMode(mode) {
  state.mode = mode;
  state.statsOpen = false;
  state.composerOpen = false;
  render();
}

function go(dir) {
  const d = state.selectedDate;
  if (state.mode === "week") {
    state.selectedDate = addDays(d, 7 * dir);
  } else if (state.mode === "month") {
    state.selectedDate = startOfDay(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  } else {
    state.selectedDate = addDays(d, dir);
  }
  state.composerOpen = false;
  render();
}

function goToday() {
  state.selectedDate = startOfDay(today());
  state.composerOpen = false;
  render();
}

function selectDate(date) {
  state.selectedDate = startOfDay(date);
  state.composerOpen = false;
  render();
}

/* ---------------- 数据 ---------------- */

function loadData() {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return { days: {} };
  }
}

function normalize(raw) {
  const days = {};
  if (!raw || typeof raw !== "object" || !raw.days || typeof raw.days !== "object") {
    return { days };
  }

  for (const [key, list] of Object.entries(raw.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Array.isArray(list)) continue;
    const tasks = [];
    for (const item of list) {
      if (!item || typeof item.title !== "string") continue;
      const title = item.title.trim().slice(0, 120);
      if (!title) continue;
      const task = {
        id: typeof item.id === "string" && item.id ? item.id : uid(),
        title,
        done: Boolean(item.done),
        createdAt: typeof item.createdAt === "number" ? item.createdAt : undefined,
      };
      // 迁移来源日期（仅未完成待办迁移时写入），保留以便重启后仍能标注
      if (typeof item.migratedFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.migratedFrom)) {
        task.migratedFrom = item.migratedFrom;
      }
      tasks.push(task);
    }
    if (tasks.length) days[key] = tasks;
  }

  return { days };
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

function loadMemos() {
  return loadTextRecords(MEMO_KEY);
}

function saveMemos() {
  localStorage.setItem(MEMO_KEY, JSON.stringify(state.memos));
}

function loadEvents() {
  return loadTextRecords(EVENT_KEY);
}

function saveEvents() {
  localStorage.setItem(EVENT_KEY, JSON.stringify(state.events));
}

// 灵感与事件都是「文本记录」：{ id, text, createdAt, date? }
// date 为「记录归属的日期」（YYYY-MM-DD）；旧数据没有 date 时按 createdAt 推导（见 recordDate）。
// 这里保留已有的 date，避免保存后丢失。
function loadTextRecords(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((m) => m && typeof m.text === "string")
      .map((m) => {
        const record = {
          id: typeof m.id === "string" && m.id ? m.id : uid(),
          text: m.text.trim().slice(0, 200),
          createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
        };
        if (typeof m.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
          record.date = m.date;
        }
        return record;
      })
      .filter((m) => m.text);
  } catch {
    return [];
  }
}

// 某条事件/灵感归属的日期：优先用显式 date，否则按创建时间推导。
// 这样旧数据（无 date）不会丢，只是归档到它被创建的那一天。
function recordDate(record) {
  if (typeof record.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    return record.date;
  }
  const ts = typeof record.createdAt === "number" ? record.createdAt : Date.now();
  return dateKey(new Date(ts));
}

function uid() {
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function today() {
  return new Date();
}

function tasksOn(key) {
  return state.data.days[key] ? state.data.days[key].slice() : [];
}

function setTasks(key, tasks) {
  if (tasks.length === 0) delete state.data.days[key];
  else state.data.days[key] = tasks;
  saveData();
}

// 某天是否有任何记录（待办 / 事件 / 灵感）
function hasRecords(key) {
  if (tasksOn(key).length) return true;
  if (state.events.some((event) => recordDate(event) === key)) return true;
  if (state.memos.some((memo) => recordDate(memo) === key)) return true;
  return false;
}

function summarize(tasks) {
  const total = tasks.length;
  const done = tasks.filter((task) => task.done).length;
  const rate = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, rate };
}

function recentDays(count) {
  const days = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = dateKey(date);
    days.push({ key, date, tasks: tasksOn(key) });
  }
  return days;
}

/* ---------------- 渲染入口 ---------------- */

function render() {
  updateNav();
  app.replaceChildren(state.statsOpen ? renderStats() : renderCalendar());
}

function updateNav() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const on = !state.statsOpen && button.dataset.mode === state.mode;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  if (statsNavBtn) statsNavBtn.classList.toggle("is-active", !!state.statsOpen);
}

/* ---------------- 日历容器：日 / 周 / 月 + 选中日期记录列表 + 新增栏 ---------------- */

function renderCalendar() {
  const section = document.createElement("section");
  section.className = "today" + (state.composerOpen ? " is-composing" : "");

  section.append(buildDateNav());

  if (state.mode === "week" || state.mode === "month") {
    const cal = document.createElement("div");
    cal.className = "cal-area";
    cal.append(state.mode === "week" ? buildWeekStrip() : buildMonthGrid());
    section.append(cal);
  }

  const body = document.createElement("div");
  body.className = "records-wrap";
  body.append(buildRecordList(activeKey()));

  if (state.composerOpen) {
    section.append(body, buildComposer(activeKey()));
  } else {
    body.append(buildFab());
    section.append(body);
  }
  return section;
}

function dateLabel() {
  const d = state.selectedDate;
  if (state.mode === "week") {
    const start = mondayOf(d);
    const end = addDays(start, 6);
    return `${start.getMonth() + 1}月${start.getDate()}日 – ${end.getMonth() + 1}月${end.getDate()}日`;
  }
  if (state.mode === "month") {
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }
  // 日视图：只显示“月日”，不显示年份和星期
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function buildDateNav() {
  const bar = document.createElement("div");
  bar.className = "date-nav";

  const prev = navArrow("‹", "上一个", () => go(-1));
  const next = navArrow("›", "下一个", () => go(1));

  const label = document.createElement("div");
  label.className = "date-label";
  label.textContent = dateLabel();

  const todayBtn = document.createElement("button");
  todayBtn.type = "button";
  todayBtn.className = "date-today";
  todayBtn.textContent = "今天";
  todayBtn.addEventListener("click", goToday);

  bar.append(prev, label, next, todayBtn);
  return bar;
}

function navArrow(text, label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "date-arrow";
  btn.textContent = text;
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", onClick);
  return btn;
}

// 周视图：周一~周日 七个可点日期格
function buildWeekStrip() {
  const start = mondayOf(state.selectedDate);
  const grid = document.createElement("div");
  grid.className = "week-grid";
  for (let i = 0; i < 7; i += 1) {
    grid.append(buildDayCell(addDays(start, i), { showWeekday: true }));
  }
  return grid;
}

// 月视图：周一起始的月历，有记录的日期显示轻量圆点
function buildMonthGrid() {
  const d = state.selectedDate;
  const year = d.getFullYear();
  const month = d.getMonth();
  const first = new Date(year, month, 1);
  const leading = (first.getDay() + 6) % 7; // 周一起始
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;

  const grid = document.createElement("div");
  grid.className = "month-grid";

  ["一", "二", "三", "四", "五", "六", "日"].forEach((t) => {
    const head = document.createElement("div");
    head.className = "month-head";
    head.textContent = t;
    grid.append(head);
  });

  const start = addDays(first, -leading);
  for (let i = 0; i < totalCells; i += 1) {
    const cellDate = addDays(start, i);
    grid.append(
      buildDayCell(cellDate, { showWeekday: false, inMonth: cellDate.getMonth() === month })
    );
  }
  return grid;
}

function buildDayCell(date, opts) {
  const key = dateKey(date);
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = "day-cell";
  cell.dataset.date = key;

  if (opts.inMonth === false) cell.classList.add("other-month");
  if (sameDay(date, state.selectedDate)) cell.classList.add("is-selected");
  if (sameDay(date, today())) cell.classList.add("is-today");
  if (hasRecords(key)) cell.classList.add("has-records");

  if (opts.showWeekday) {
    const wd = document.createElement("span");
    wd.className = "cell-wd";
    wd.textContent = WEEK_SHORT[date.getDay()];
    cell.append(wd);
  }

  const num = document.createElement("span");
  num.className = "cell-num";
  num.textContent = String(date.getDate());
  cell.append(num);

  if (hasRecords(key)) {
    const dot = document.createElement("span");
    dot.className = "cell-dot";
    cell.append(dot);
  }

  cell.setAttribute("aria-label", `${date.getMonth() + 1}月${date.getDate()}日`);
  // 点击某天：选中该日期并在下方列表查看其记录（周/月视图里也可直接点选）
  cell.addEventListener("click", () => selectDate(date));
  return cell;
}

function buildFab() {
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "fab";
  fab.textContent = "+";
  fab.setAttribute("aria-label", "新增记录");
  fab.title = "新增记录";
  fab.addEventListener("click", () => {
    state.composerOpen = true;
    render();
    const input = app.querySelector(".composer-input");
    if (input) input.focus();
  });
  return fab;
}

// 把选中日期的待办 + 事件 + 灵感按“记录时间”合并成一条连续列表
function collectRecords(key) {
  const items = [];
  const dayStart = new Date(key + "T00:00:00").getTime();

  tasksOn(key).forEach((task, index) => {
    items.push({
      kind: "todo",
      id: task.id,
      text: task.title,
      done: Boolean(task.done),
      task,
      time: typeof task.createdAt === "number" ? task.createdAt : dayStart + index,
    });
  });
  for (const event of state.events) {
    if (recordDate(event) !== key) continue;
    items.push({ kind: "event", id: event.id, text: event.text, event, time: event.createdAt });
  }
  for (const memo of state.memos) {
    if (recordDate(memo) !== key) continue;
    items.push({ kind: "memo", id: memo.id, text: memo.text, memo, time: memo.createdAt });
  }

  items.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return String(a.id) < String(b.id) ? -1 : 1;
  });
  return items;
}

function buildRecordList(key) {
  const list = document.createElement("ul");
  list.className = "record-list";

  list.addEventListener("contextmenu", (event) => {
    const row = event.target.closest(".record");
    if (!row || event.target.tagName === "INPUT") return;
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event.clientX, event.clientY, row.dataset.kind, row.dataset.id, key);
  });

  const records = collectRecords(key);
  if (records.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "这一天还没有记录，点右下角 + 添加。";
    list.append(empty);
    return list;
  }

  for (const record of records) list.append(renderRecord(key, record));
  return list;
}

function renderRecord(key, record) {
  const item = document.createElement("li");
  item.className =
    "record record-" + record.kind + (record.kind === "todo" && record.done ? " is-done" : "");
  item.dataset.kind = record.kind;
  item.dataset.id = record.id;

  const editing =
    state.editingRecord &&
    state.editingRecord.kind === record.kind &&
    state.editingRecord.id === record.id;

  // 左侧符号：待办=可点击的完成开关；事件/灵感=静态符号
  if (record.kind === "todo") {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "rec-sym rec-sym-todo" + (record.done ? " is-done" : "");
    toggle.setAttribute("aria-pressed", record.done ? "true" : "false");
    toggle.setAttribute("aria-label", record.done ? "取消完成" : "标记为完成");
    if (record.done) {
      const tick = document.createElement("span");
      tick.className = "rec-tick";
      tick.textContent = "✓";
      toggle.append(tick);
    }
    if (!editing) toggle.addEventListener("click", () => toggleTodo(key, record.task));
    item.append(toggle);
  } else {
    const sym = document.createElement("span");
    sym.className = "rec-sym rec-sym-" + record.kind;
    sym.setAttribute("aria-hidden", "true");
    item.append(sym);
  }

  // 文本：编辑态显示输入框；否则待办文字可点切换完成，事件/灵感为纯文本
  if (editing) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "record-edit";
    input.value = state.editDraft || "";
    input.maxLength = record.kind === "todo" ? 120 : 200;
    input.addEventListener("input", () => {
      state.editDraft = input.value;
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        finishEdit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        cancelEdit();
      }
    });
    input.addEventListener("blur", () => finishEdit());
    item.append(input);
    requestAnimationFrame(() => input.focus());
  } else if (record.kind === "todo") {
    const textBtn = document.createElement("button");
    textBtn.type = "button";
    textBtn.className = "record-text";
    textBtn.textContent = record.text;
    textBtn.addEventListener("click", () => toggleTodo(key, record.task));
    // 迁移来的待办：在文字下方标注原日期，方便识别来源
    if (record.task && record.task.migratedFrom) {
      const wrap = document.createElement("div");
      wrap.className = "record-text-wrap";
      wrap.append(textBtn);
      const tag = document.createElement("span");
      tag.className = "migrated-tag";
      tag.textContent = "来自 " + formatMD(record.task.migratedFrom);
      wrap.append(tag);
      item.append(wrap);
    } else {
      item.append(textBtn);
    }
  } else {
    const text = document.createElement("span");
    text.className = "record-text";
    text.textContent = record.text;
    item.append(text);
  }

  return item;
}

function toggleTodo(key, task) {
  const next = tasksOn(key).map((entry) =>
    entry.id === task.id ? { ...entry, done: !entry.done } : entry
  );
  setTasks(key, next);
  render();
}

function removeRecord(kind, id) {
  if (state.editingRecord && state.editingRecord.kind === kind && state.editingRecord.id === id) {
    state.editingRecord = null;
    state.editDraft = "";
  }
  if (kind === "todo") {
    const key = activeKey();
    setTasks(key, tasksOn(key).filter((entry) => entry.id !== id));
  } else if (kind === "event") {
    state.events = state.events.filter((entry) => entry.id !== id);
    saveEvents();
  } else {
    state.memos = state.memos.filter((entry) => entry.id !== id);
    saveMemos();
  }
  render();
}

function recordText(kind, id) {
  if (kind === "todo") {
    const found = tasksOn(activeKey()).find((entry) => entry.id === id);
    return found ? found.title : "";
  }
  if (kind === "event") {
    const found = state.events.find((entry) => entry.id === id);
    return found ? found.text : "";
  }
  const found = state.memos.find((entry) => entry.id === id);
  return found ? found.text : "";
}

function startEdit(kind, id) {
  state.editingRecord = { kind, id };
  state.editDraft = recordText(kind, id);
  render();
}

function finishEdit() {
  if (!state.editingRecord) return;
  const { kind, id } = state.editingRecord;
  const text = (state.editDraft || "").trim();
  state.editingRecord = null;
  state.editDraft = "";
  if (text) {
    if (kind === "todo") {
      const key = activeKey();
      const tasks = tasksOn(key).map((entry) =>
        entry.id === id ? { ...entry, title: text.slice(0, 120) } : entry
      );
      setTasks(key, tasks);
    } else if (kind === "event") {
      state.events = state.events.map((entry) =>
        entry.id === id ? { ...entry, text: text.slice(0, 200) } : entry
      );
      saveEvents();
    } else {
      state.memos = state.memos.map((entry) =>
        entry.id === id ? { ...entry, text: text.slice(0, 200) } : entry
      );
      saveMemos();
    }
  }
  render();
}

function cancelEdit() {
  if (!state.editingRecord) return;
  state.editingRecord = null;
  state.editDraft = "";
  render();
}

/* ---------------- 右键菜单 ---------------- */

let contextMenuEl = null;

function ensureContextMenu() {
  if (contextMenuEl) return contextMenuEl;
  contextMenuEl = document.createElement("div");
  contextMenuEl.className = "context-menu";
  contextMenuEl.hidden = true;
  document.body.appendChild(contextMenuEl);
  document.addEventListener("mousedown", (event) => {
    if (contextMenuEl && !contextMenuEl.hidden && !contextMenuEl.contains(event.target)) {
      hideContextMenu();
    }
  });
  return contextMenuEl;
}

function showContextMenu(x, y, kind, id, sourceKey) {
  const menu = ensureContextMenu();
  menu.replaceChildren();

  const actions = [{ label: "编辑", run: () => startEdit(kind, id) }];

  // 仅“未完成的待办”可以迁移（已完成待办、事件、灵感都不提供该操作）
  let migratable = false;
  if (kind === "todo" && sourceKey) {
    const task = tasksOn(sourceKey).find((entry) => entry.id === id);
    migratable = Boolean(task && !task.done);
  }
  if (migratable) {
    actions.push({ label: "移到其他日期", run: () => openMigrateDialog(sourceKey, id) });
  }

  actions.push({ label: "删除", run: () => removeRecord(kind, id) });

  for (const { label, run } of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "context-menu-item";
    btn.textContent = label;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      hideContextMenu();
      run();
    });
    menu.append(btn);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  state.contextMenu = { kind, id };
}

function hideContextMenu() {
  state.contextMenu = null;
  if (contextMenuEl) contextMenuEl.hidden = true;
}

/* ---------------- 迁移未完成待办 ---------------- */

let migrateEl = null;

// 迁移：从原日期移除，加入目标日期；保留文字与未完成状态，并记录来源日期
function migrateTodo(sourceKey, id, targetKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetKey)) return;
  if (targetKey === sourceKey) return;
  const sourceTasks = tasksOn(sourceKey);
  const task = sourceTasks.find((entry) => entry.id === id);
  if (!task || task.done) return; // 只迁移未完成待办

  // 先从原日期移除
  setTasks(
    sourceKey,
    sourceTasks.filter((entry) => entry.id !== id)
  );

  // 再加入目标日期（新 id，保留内容与未完成状态，注明来源）
  const targetTasks = tasksOn(targetKey);
  targetTasks.push({
    id: uid(),
    title: task.title,
    done: false,
    createdAt: nextTimestamp(),
    migratedFrom: sourceKey,
  });
  setTasks(targetKey, targetTasks);

  render();
}

function tomorrowKey() {
  return dateKey(addDays(startOfDay(today()), 1));
}

function openMigrateDialog(sourceKey, id) {
  closeMigrateDialog();
  const task = tasksOn(sourceKey).find((entry) => entry.id === id);
  if (!task || task.done) return;

  const tomorrow = tomorrowKey();

  const overlay = document.createElement("div");
  overlay.className = "migrate-overlay";

  const card = document.createElement("div");
  card.className = "migrate-card";

  const title = document.createElement("p");
  title.className = "migrate-title";
  title.textContent = "移到其他日期";

  const sub = document.createElement("p");
  sub.className = "migrate-sub";
  sub.textContent = task.title;

  const quick = document.createElement("button");
  quick.type = "button";
  quick.className = "migrate-quick";
  quick.textContent = `明天 · ${formatMD(tomorrow)}`;
  quick.addEventListener("click", () => {
    closeMigrateDialog();
    migrateTodo(sourceKey, id, tomorrow);
  });

  const row = document.createElement("div");
  row.className = "migrate-row";

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "migrate-date";
  dateInput.value = tomorrow;

  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "migrate-confirm";
  confirm.textContent = "确认迁移";
  confirm.addEventListener("click", () => {
    const target = dateInput.value;
    closeMigrateDialog();
    if (target) migrateTodo(sourceKey, id, target);
  });

  row.append(dateInput, confirm);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "migrate-cancel";
  cancel.textContent = "取消";
  cancel.addEventListener("click", closeMigrateDialog);

  card.append(title, sub, quick, row, cancel);
  overlay.append(card);

  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closeMigrateDialog();
  });

  document.body.append(overlay);
  migrateEl = overlay;

  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMigrateDialog();
    }
  };
  overlay._onKey = onKey;
  document.addEventListener("keydown", onKey, true);

  dateInput.focus();
}

function closeMigrateDialog() {
  if (!migrateEl) return;
  if (migrateEl._onKey) {
    document.removeEventListener("keydown", migrateEl._onKey, true);
  }
  migrateEl.remove();
  migrateEl = null;
}

/* ---------------- 新增栏：符号类型选择器 + 输入框 + 保存 ---------------- */

function buildComposer(key) {
  const form = document.createElement("form");
  form.className = "composer";
  form.autocomplete = "off";

  const wheel = document.createElement("div");
  wheel.className = "type-wheel";
  wheel.setAttribute("role", "listbox");
  wheel.setAttribute("aria-label", "记录类型（默认待办，向下滑=事件，向上滑=灵感，或点击切换）");
  wheel.tabIndex = 0;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "composer-input";
  input.maxLength = 200;
  input.autocomplete = "off";
  input.placeholder = COMPOSER_PLACEHOLDER;
  input.value = state.composerDraft || "";
  input.addEventListener("input", () => {
    state.composerDraft = input.value;
  });

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "composer-save";
  save.textContent = "保存";

  function setType(type) {
    if (type === state.composerType) return;
    state.composerType = type;
    renderWheel();
  }

  // 每次只移动一个选项，到顶/到底后不再变化（不循环）
  function step(delta) {
    const index = TYPE_DISPLAY.indexOf(state.composerType);
    const next = Math.min(TYPE_DISPLAY.length - 1, Math.max(0, index + delta));
    setType(TYPE_DISPLAY[next]);
  }

  // 三个选项位置固定（灵感 / 待办 / 事件），只移动选中高亮，不重复、不替换
  function renderWheel() {
    wheel.replaceChildren();
    for (const type of TYPE_DISPLAY) {
      const isCurrent = type === state.composerType;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "type-item" + (isCurrent ? " is-current" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", isCurrent ? "true" : "false");
      btn.setAttribute("aria-label", TYPE_LABEL[type]);
      btn.title = TYPE_LABEL[type];
      if (isCurrent) btn.setAttribute("aria-current", "true");
      const sym = document.createElement("span");
      sym.className = "wheel-sym wheel-sym-" + type;
      sym.setAttribute("aria-hidden", "true");
      btn.append(sym);
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setType(type);
      });
      wheel.append(btn);
    }
  }

  // 鼠标滚轮 / 触控板：向下→事件，向上→灵感（带节流，避免一次滑动连跳）
  let wheelCooldown = 0;
  wheel.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (Math.abs(event.deltaY) < 2) return;
      const now = Date.now();
      if (now - wheelCooldown < 240) return;
      wheelCooldown = now;
      step(event.deltaY > 0 ? 1 : -1);
    },
    { passive: false }
  );

  // 触控：手指向下滑→事件，向上滑→灵感
  let touchStartY = null;
  wheel.addEventListener(
    "touchstart",
    (event) => {
      touchStartY = event.touches[0].clientY;
    },
    { passive: true }
  );
  wheel.addEventListener(
    "touchmove",
    (event) => {
      if (touchStartY == null) return;
      const dy = event.touches[0].clientY - touchStartY;
      if (Math.abs(dy) > 22) {
        step(dy > 0 ? 1 : -1);
        touchStartY = null;
      }
    },
    { passive: true }
  );
  wheel.addEventListener("touchend", () => {
    touchStartY = null;
  });

  // 键盘：上下方向键切换
  wheel.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveRecord(key, input);
  });

  renderWheel();

  form.append(wheel, input, save);
  return form;
}

function saveRecord(key, input) {
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

  const createdAt = nextTimestamp();
  if (state.composerType === "todo") {
    const next = tasksOn(key);
    next.push({ id: uid(), title: text.slice(0, 120), done: false, createdAt });
    setTasks(key, next);
  } else if (state.composerType === "event") {
    // 保存到当前选中日期：显式写入 date
    state.events.push({ id: uid(), text: text.slice(0, 200), createdAt, date: key });
    saveEvents();
  } else {
    state.memos.push({ id: uid(), text: text.slice(0, 200), createdAt, date: key });
    saveMemos();
  }

  // 保存后：清空草稿、把下一条默认回到「待办」，并收起新增区域
  state.composerDraft = "";
  state.composerType = "todo";
  state.composerOpen = false;
  render();
}

/* ---------------- 统计 ---------------- */

function renderStats() {
  const view = document.createElement("section");
  view.className = "stats";
  const all = Object.values(state.data.days).flat();
  const overall = summarize(all);
  const todaySummary = summarize(tasksOn(dateKey(today())));
  const recordedDays = Object.keys(state.data.days).length;

  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = "统计";

  const grid = document.createElement("div");
  grid.className = "stat-grid";
  grid.append(
    statCard("今日完成率", `${todaySummary.rate}%`),
    statCard("累计完成", String(overall.done)),
    statCard("累计任务", String(overall.total)),
    statCard("记录天数", String(recordedDays))
  );

  const heading = document.createElement("h2");
  heading.className = "section-title";
  heading.textContent = "近 7 日";

  const history = document.createElement("div");
  for (const day of recentDays(7)) {
    const summary = summarize(day.tasks);
    const row = document.createElement("div");
    row.className = "day";

    const name = document.createElement("p");
    name.className = "day-name";
    name.textContent = `${day.date.getMonth() + 1}月${day.date.getDate()}日 ${WEEKDAYS[day.date.getDay()]}`;

    const meta = document.createElement("p");
    meta.className = "day-meta";
    meta.textContent = summary.total === 0 ? "未记录" : `${summary.done} / ${summary.total} 项已完成`;

    const rate = document.createElement("p");
    rate.className = "day-rate";
    rate.textContent = summary.total === 0 ? "—" : `${summary.rate}%`;

    row.append(name, meta, rate);
    history.append(row);
  }

  const note = document.createElement("p");
  note.className = "note";
  note.textContent = "待办、事件与灵感都保存在这台电脑本地，关闭重开后仍会保留。";

  view.append(kicker, grid, heading, history, note);
  return view;
}

function statCard(label, value) {
  const card = document.createElement("article");
  card.className = "stat";
  const name = document.createElement("p");
  name.textContent = label;
  const number = document.createElement("strong");
  number.textContent = value;
  card.append(name, number);
  return card;
}

/* ---------------- 组件内文件暂存（拖到组件空白处，像桌面图标） ---------------- */
(function setupDeskStage() {
  const api = window.stageAPI;
  const panel = document.querySelector(".panel");
  if (!api || !panel) return;
  if (getComputedStyle(panel).position === "static") panel.style.position = "relative";

  let TILE_W = 58;
  let TILE_H = 66;
  let GAP = 6;
  let PAD = 4;

  const layer = document.createElement("div");
  layer.className = "desk-layer";
  panel.appendChild(layer);

  const hint = document.createElement("div");
  hint.className = "desk-drop-hint";
  hint.textContent = "松开以暂存文件";
  panel.appendChild(hint);

  // 图片大图预览（点击图片时覆盖显示，点击任意处或 Esc 关闭）
  const preview = document.createElement("div");
  preview.className = "desk-preview";
  preview.hidden = true;
  const previewImg = document.createElement("img");
  previewImg.alt = "";
  preview.appendChild(previewImg);
  panel.appendChild(preview);
  preview.addEventListener("click", () => {
    preview.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !preview.hidden) preview.hidden = true;
  });
  function showPreview(item) {
    previewImg.src = api.assetUrl(item.file);
    preview.hidden = false;
  }

  let items = [];

  function positionLayer() {
    const pr = panel.getBoundingClientRect();
    const headerEls = [
      document.querySelector(".topbar"),
      document.querySelector(".date-nav"),
      document.querySelector(".cal-area"),
    ];
    let bottom = 0;
    for (const el of headerEls) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      bottom = Math.max(bottom, Math.round(r.bottom - pr.top));
    }
    const top = (bottom || 44) + 6;
    layer.style.top = top + "px";
    layer.style.bottom = "44px"; // 预留右下角 “+”
    layer.style.right = "8px";
  }

  // 右侧网格：按宽度决定列数、按数量决定实际占用列；超出可视高度时纵向滚动。
  function computeLayout(count) {
    const pr = panel.getBoundingClientRect();
    const top = parseFloat(layer.style.top || "48") || 48;
    const bottom = 44;
    const availH = Math.max(60, pr.height - top - bottom);
    const availW = Math.max(60, pr.width - 16);
    const PAD = 4;
    const small = pr.width < 260 || pr.height < 320;
    TILE_W = small ? 44 : 54;
    TILE_H = small ? 50 : 62;
    GAP = small ? 4 : 6;
    const maxDeskW = Math.max(TILE_W, Math.floor(availW * 0.36));
    const cols = Math.max(1, Math.floor((maxDeskW + GAP) / (TILE_W + GAP)));
    const usableH = Math.max(TILE_H, availH - PAD * 2);
    const rowsPerCol = Math.max(1, Math.floor((usableH + GAP) / (TILE_H + GAP)));
    const colsUsed = count ? Math.min(cols, Math.max(1, Math.ceil(count / rowsPerCol))) : 0;
    const width = colsUsed ? colsUsed * TILE_W + (colsUsed - 1) * GAP + PAD * 2 : 0;
    return { colsUsed, width };
  }

  function thumbFor(item, box) {
    const wrap = document.createElement("span");
    wrap.className = "desk-thumb";
    if (box) {
      wrap.style.width = box + "px";
      wrap.style.height = box + "px";
    }
    if (item.isImage) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = api.assetUrl(item.thumb || item.file);
      wrap.appendChild(img);
    } else if (item.icon) {
      const img = document.createElement("img");
      img.alt = "";
      img.className = "desk-fileicon";
      img.src = api.assetUrl(item.icon);
      wrap.appendChild(img);
    } else {
      const ext = document.createElement("span");
      ext.className = "desk-ext";
      ext.textContent = (item.isDir ? "文件夹" : item.ext || "FILE").toUpperCase().slice(0, 4);
      wrap.appendChild(ext);
    }
    return wrap;
  }

  function renderDesk() {
    positionLayer();
    layer.innerHTML = "";
    if (!items.length) {
      layer.style.display = "none";
      layer.style.width = "0px";
      panel.style.setProperty("--desk-right", "0px");
      return;
    }
    layer.style.display = "";
    const { width } = computeLayout(items.length);
    const box = Math.max(20, Math.min(TILE_W - 10, TILE_H - 22));
    layer.style.width = width + "px";
    layer.style.overflowY = "auto";
    // 给待办区预留右侧留白，保证图标不遮挡文字与交互
    const gutter = Math.min(width + 12, Math.floor(panel.getBoundingClientRect().width * 0.5));
    panel.style.setProperty("--desk-right", gutter + "px");
    items.forEach((item) => {
      const tile = document.createElement("div");
      tile.className = "desk-file";
      tile.style.width = TILE_W + "px";
      tile.style.height = TILE_H + "px";
      tile.dataset.id = item.id;
      tile.draggable = true;

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "desk-open";
      openBtn.style.width = TILE_W + "px";
      openBtn.style.height = TILE_H + "px";
      openBtn.title = (item.isImage ? "查看 " : "打开 ") + item.name;
      openBtn.appendChild(thumbFor(item, box));
      const nameEl = document.createElement("span");
      nameEl.className = "desk-name";
      nameEl.style.maxWidth = TILE_W + "px";
      nameEl.textContent = item.name;
      openBtn.appendChild(nameEl);
      openBtn.addEventListener("click", () => {
        if (item.isImage) showPreview(item);
        else api.open(item.id);
      });

      // 从组件把图标拖到资源管理器，生成可正常使用的文件/文件夹（Electron 原生 startDrag）
      tile.addEventListener("dragstart", (e) => {
        e.preventDefault();
        api.dragOut(item.id);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "desk-remove";
      del.title = "移除（仅删除应用内副本）";
      del.setAttribute("aria-label", "移除 " + item.name);
      del.textContent = "×";
      del.draggable = false;
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        items = await api.remove(item.id);
        renderDesk();
      });
      del.addEventListener("dragstart", (e) => e.preventDefault());

      tile.appendChild(openBtn);
      tile.appendChild(del);
      layer.appendChild(tile);
    });
  }

  // 短暂提示（成功/失败），保存失败时必须给出清楚反馈
  const toast = document.createElement("div");
  toast.className = "desk-toast";
  panel.appendChild(toast);
  let toastTimer = null;
  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.classList.toggle("is-error", !!isError);
    toast.classList.add("is-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-show"), isError ? 4500 : 2200);
  }

  let dragDepth = 0;
  function dragHasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (Array.from(dt.types || []).indexOf("Files") !== -1) return true;
    return !!(dt.files && dt.files.length);
  }
  // 拖放诊断：同时进 DevTools 与主进程终端（脱敏，仅名称/数量/类型，不含内容与完整路径）
  function dropDebug(msg) {
    try { console.info("[stage-drop]", msg); } catch {}
    try { api.diag && api.diag(msg); } catch {}
  }
  function showHint(on) {
    panel.classList.toggle("is-file-drop", on);
  }
  function hideHint() {
    dragDepth = 0;
    showHint(false);
  }

  document.addEventListener("dragenter", (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    showHint(true);
  });
  // 始终允许放下文件：部分环境在 dragover 阶段拿不到 types，只有这里 preventDefault 才能触发 drop
  document.addEventListener("dragover", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = "copy";
    } catch {}
    if (dragHasFiles(e)) showHint(true);
  });
  document.addEventListener("dragleave", (e) => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 || e.relatedTarget === null) showHint(false);
  });
  // 统一导入：本地路径走 api.add；无路径但有字节（聊天窗口图片）走 api.addData
  async function importEntries(got, blobs, failedNames) {
    const before = new Set(items.map((it) => it.id));
    let lastItems = items;
    const allErrors = [];
    if (got.length) {
      try {
        const r = await api.add(got);
        if (r && Array.isArray(r.items)) lastItems = r.items;
        if (r && Array.isArray(r.errors)) allErrors.push(...r.errors);
      } catch (err) {
        dropDebug("api.add 失败: " + (err && (err.message || err)));
        showToast("暂存失败：" + (err && err.message ? err.message : String(err)), true);
        return;
      }
    }
    if (blobs.length) {
      try {
        const r2 = await api.addData(blobs);
        if (r2 && Array.isArray(r2.items)) lastItems = r2.items;
        if (r2 && Array.isArray(r2.errors)) allErrors.push(...r2.errors);
      } catch (err) {
        dropDebug("api.addData 失败: " + (err && (err.message || err)));
        showToast("保存图片失败：" + (err && err.message ? err.message : String(err)), true);
        return;
      }
    }
    items = lastItems;
    const added = items.filter((it) => !before.has(it.id));
    dropDebug("导入返回 items=" + items.length + " added=" + added.length + " errors=" + allErrors.length + " failed=" + failedNames.length);
    if (added.length) renderDesk();
    if (allErrors.length) {
      showToast("部分内容未暂存：" + allErrors.map((x) => x.name + "（" + x.reason + "）").join("；"), true);
    } else if (failedNames.length) {
      showToast("已暂存 " + added.length + " 个；" + failedNames.length + " 个无法读取：" + failedNames.join("、") + "（可改用粘贴图片或选择文件）", true);
    } else if (added.length) {
      showToast(added.length > 1 ? "已暂存 " + added.length + " 个" : "已暂存", false);
    } else {
      showToast("未能暂存（来源可能未提供数据，可改用粘贴图片）", true);
    }
  }

  async function readFileBytes(f) {
    const ab = await f.arrayBuffer();
    return new Uint8Array(ab);
  }

  document.addEventListener("drop", async (e) => {
    const dt = e.dataTransfer;
    // 必须先拦截默认导航（部分来源 files 为空也可能触发系统“打开”）
    e.preventDefault();
    e.stopPropagation();
    const files = dt ? Array.from(dt.files || []) : [];
    dropDebug("drop 触发 types=" + Array.from((dt && dt.types) || []).join(",") + " files=" + files.length);
    if (!files.length) {
      dropDebug("files=0，未导入");
      hideHint();
      return;
    }
    hideHint();

    const got = [];
    const blobs = [];
    const failedNames = [];
    for (const f of files) {
      let p = "";
      try {
        p = api.getPathForFile(f);
      } catch (err) {
        dropDebug("getPathForFile 失败: " + (err && (err.message || err)));
      }
      dropDebug("file=" + f.name + " type=" + (f.type || "(空)") + " size=" + f.size + " path=" + (p ? "有" : "无"));
      if (p) {
        got.push(p);
        continue;
      }
      // 无本地路径：若来源提供了字节数据（聊天窗口拖图常见），读取内容后保存
      if (f.size > 0) {
        try {
          const bytes = await readFileBytes(f);
          blobs.push({ name: f.name || "clip-" + Date.now(), type: f.type || "", data: bytes });
        } catch (err) {
          dropDebug("读取字节失败: " + (err && (err.message || err)));
          failedNames.push(f.name || "未命名");
        }
      } else {
        failedNames.push(f.name || "未命名文件");
      }
    }

    if (!got.length && !blobs.length) {
      showToast(
        "无法读取该拖入内容（既无本地路径也无数据）：" +
          (failedNames.join("、") || "未知") +
          "；可改用粘贴图片（Ctrl+V）或选择文件",
        true
      );
      return;
    }
    await importEntries(got, blobs, failedNames);
  });

  // 从系统剪贴板粘贴图片：聊天窗口复制图片 → 点击组件 → Ctrl+V
  // 通过主进程 clipboard.readImage() 读取位图，不依赖渲染层 clipboardData
  function isEditable(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }
  async function pasteFromClipboard() {
    let r;
    try {
      r = await api.pasteClipboard();
    } catch (err) {
      dropDebug("pasteClipboard 失败: " + (err && (err.message || err)));
      showToast("粘贴失败：" + (err && err.message ? err.message : String(err)), true);
      return;
    }
    if (r && r.pasted) {
      if (Array.isArray(r.items)) items = r.items;
      renderDesk();
      dropDebug("paste 成功 数量=" + (r.count || 0) + " 索引=" + items.length);
      showToast("已从剪贴板粘贴图片", false);
    } else if (r && Array.isArray(r.errors) && r.errors.length) {
      showToast("剪贴板图片保存失败：" + r.errors.map((x) => x.name + "（" + x.reason + "）").join("；"), true);
    } else {
      // 剪贴板不是图片：不报错、不覆盖内容，仅明确提示
      showToast("剪贴板中没有图片（请先在聊天窗口复制图片）", false);
    }
  }
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if ((e.key || "").toLowerCase() !== "v") return;
    const editable = isEditable(document.activeElement);
    // 输入框内 Ctrl+V 保留普通文字粘贴；Ctrl+Shift+V 强制粘贴剪贴板图片
    if (editable && !e.shiftKey) return;
    e.preventDefault();
    pasteFromClipboard();
  }, true);

  api
    .list()
    .then((list) => {
      items = Array.isArray(list) ? list : [];
      renderDesk();
    })
    .catch(() => {});

  // 托盘“粘贴剪贴板图片”等主进程发起的粘贴结果
  if (api.onPasteResult) {
    api.onPasteResult((r) => {
      if (r && Array.isArray(r.items)) items = r.items;
      renderDesk();
      if (r && r.pasted) {
        showToast("已从剪贴板粘贴图片", false);
      } else if (r && Array.isArray(r.errors) && r.errors.length) {
        showToast("剪贴板图片保存失败：" + r.errors.map((x) => x.name + "（" + x.reason + "）").join("；"), true);
      } else {
        showToast("剪贴板中没有图片（请先在聊天窗口复制图片）", false);
      }
    });
  }

  // 日历/视图重渲染后重新定位暂存区（“今天”行/日历高度变化时避免重叠）
  const appEl = document.getElementById("app");
  if (appEl && window.MutationObserver) {
    const mo = new MutationObserver(() => {
      if (items.length) renderDesk();
      else positionLayer();
    });
    mo.observe(appEl, { childList: true });
  }

  // 尺寸变化后重新校正，避免图标跑出边界
  window.addEventListener("resize", renderDesk);
})();
