// 暂存区（文件中转站）的本地存储与文件操作。
// 全部在主进程执行，渲染层只能通过受限 IPC 调用，不直接接触文件系统。
const path = require("path");
const fs = require("fs");
// Electron 主进程的 fs 被 asar 补丁过：会把 *.asar 当成目录（readdir 返回归档内部条目），
// 导致递归复制时把 .asar 文件当目录、mkdir 报 ENOTDIR。复制/删除一律用未打补丁的 original-fs。
let rawFs = fs;
try {
  rawFs = require("original-fs");
} catch {}
const { app, nativeImage, shell } = require("electron");

// 常见图片扩展名（可显示缩略图）；其余按“文件类型图标 + 文件名”显示。
const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".svg", ".avif", ".tif", ".tiff",
]);

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".ico": "image/x-icon", ".svg": "image/svg+xml", ".avif": "image/avif",
  ".tif": "image/tiff", ".tiff": "image/tiff", ".pdf": "application/pdf",
};

function dir() {
  // 与小组件数据同一 userData（%APPDATA%\studyflow），升级/重启都保留。
  return path.join(app.getPath("userData"), "staging");
}
function indexFile() {
  return path.join(dir(), "index.json");
}

function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true });
}

function readIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), "utf8"));
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(items) {
  ensureDir();
  try {
    fs.writeFileSync(indexFile(), JSON.stringify(items, null, 2));
  } catch (err) {
    console.error("写入暂存索引失败:", err);
  }
}

function copyDirectoryTree(src, dest, skipped) {
  try {
    rawFs.mkdirSync(dest, { recursive: true });
  } catch (e) {
    throw new Error(
      "创建目标目录失败 dest=" + dest + " src=" + src + " code=" + (e.code || "") + " :: " + (e.message || e)
    );
  }
  for (const entry of rawFs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    let actual;
    try {
      actual = rawFs.lstatSync(from);
    } catch (err) {
      throw new Error(`读取目录项失败: ${from}; ${err.stack || err}`);
    }
    if (actual.isSymbolicLink() || entry.isSymbolicLink()) {
      skipped.push(from);
      console.warn("跳过文件夹中的符号链接/junction:", from);
      continue;
    }
    if (actual.isDirectory()) {
      copyDirectoryTree(from, to, skipped);
    } else if (actual.isFile()) {
      rawFs.copyFileSync(from, to);
    } else {
      skipped.push(from);
      console.warn("跳过不支持的目录项:", from);
    }
  }
}

// 只允许访问暂存目录内的文件，阻止路径穿越
function safePath(name) {
  if (typeof name !== "string" || !name) return null;
  const base = path.resolve(dir());
  const p = path.resolve(base, name);
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}

function mimeFor(name) {
  const ext = path.extname(String(name)).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

function deleteFiles(item) {
  for (const f of [item.file, item.thumb, item.icon]) {
    if (!f) continue;
    const p = safePath(f);
    if (!p) continue;
    try {
      const s = rawFs.statSync(p);
      if (s.isDirectory()) rawFs.rmSync(p, { recursive: true, force: true });
      else rawFs.unlinkSync(p);
    } catch {}
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 拖入的文件：复制到应用自有的暂存目录（原文件原地保留）
async function addFiles(srcPaths) {
  ensureDir();
  const items = readIndex();
  const errors = [];
  const list = Array.isArray(srcPaths) ? srcPaths : [];
  for (const src of list) {
    const displayName =
      typeof src === "string" && src ? path.basename(src) : String(src);
    try {
      if (typeof src !== "string" || !src) {
        errors.push({ name: displayName, reason: "路径无效" });
        continue;
      }
      let st;
      try {
        st = rawFs.statSync(src);
      } catch (e) {
        errors.push({ name: displayName, reason: "文件不存在或无法访问(" + (e.code || "ERR") + ")" });
        continue;
      }
      try {
        rawFs.accessSync(src, fs.constants.R_OK);
      } catch {
        errors.push({ name: displayName, reason: "文件或文件夹不可读(权限不足)" });
        continue;
      }

      console.log("暂存收到源:", src, st.isDirectory() ? "(目录)" : "(文件)");

      // 文件夹：逐项递归复制到暂存目录（目录用 mkdir、文件用 copyFileSync；
      // 跳过符号链接/junction，避免 node_modules 之类文件夹复制时报 ENOTDIR/EPERM）
      if (st.isDirectory()) {
        const id = uid();
        const stored = id; // 无扩展名
        const dest = path.join(dir(), stored);
        console.log("暂存文件夹源:", src, "-> 目标:", dest);
        const skipped = [];
        try {
          copyDirectoryTree(src, dest, skipped);
        } catch (e) {
          console.error(
            "复制文件夹失败 src=" + src + " dest=" + dest + " code=" + (e.code || "") + "\n" + (e.stack || e)
          );
          try { rawFs.rmSync(dest, { recursive: true, force: true }); } catch {}
          errors.push({ name: displayName, reason: "复制文件夹失败(" + (e.code || "ERR") + ")" });
          continue;
        }
        let icon = null;
        try {
          const ic = await app.getFileIcon(dest, { size: "large" });
          if (ic && !ic.isEmpty()) {
            const iconName = id + ".icon.png";
            fs.writeFileSync(path.join(dir(), iconName), ic.toPNG());
            icon = iconName;
          }
        } catch {}
        items.push({
          id,
          name: displayName,
          ext: "",
          size: 0,
          isImage: false,
          isDir: true,
          file: stored,
          addedAt: Date.now(),
          ...(icon ? { icon } : {}),
        });
        continue;
      }

      if (!st.isFile()) {
        errors.push({ name: displayName, reason: "不是有效的文件或文件夹" });
        continue;
      }

      const ext = path.extname(src).toLowerCase();
      const id = uid();
      const stored = id + ext;
      const dest = path.join(dir(), stored);
      try {
        rawFs.copyFileSync(src, dest);
      } catch (e) {
        console.error(
          "复制文件失败 src=" + src + " dest=" + dest + " code=" + (e.code || "") + "\n" + (e.stack || e)
        );
        try { rawFs.rmSync(dest, { force: true }); } catch {}
        errors.push({ name: displayName, reason: "复制失败(" + (e.code || "ERR") + ")" });
        continue;
      }

      // 图片判定：扩展名 ∪ 实际解码结果（不只依赖单一扩展名，兼容 .jpg/.jpeg 等）
      let decoded = null;
      try {
        decoded = nativeImage.createFromPath(dest);
      } catch {}
      const decodedOk = !!decoded && !decoded.isEmpty() && decoded.getSize().width > 0;
      const isImage = IMAGE_EXT.has(ext) || decodedOk;

      const item = {
        id,
        name: displayName,
        ext: ext.replace(".", ""),
        size: st.size,
        isImage,
        file: stored,
        addedAt: Date.now(),
      };

      if (isImage) {
        if (decodedOk) {
          try {
            const thumbName = id + ".thumb.png";
            const resized = decoded.resize({ width: 256 });
            fs.writeFileSync(path.join(dir(), thumbName), resized.toPNG());
            item.thumb = thumbName;
          } catch {}
        }
        // 无法解码（如 svg/avif 等）则不生成缩略图，界面直接用原文件显示
      } else {
        try {
          const icon = await app.getFileIcon(dest, { size: "large" });
          if (icon && !icon.isEmpty()) {
            const iconName = id + ".icon.png";
            fs.writeFileSync(path.join(dir(), iconName), icon.toPNG());
            item.icon = iconName;
          }
        } catch {}
      }

      items.push(item);
    } catch (err) {
      console.error("暂存文件失败:", src, err);
      errors.push({ name: displayName, reason: err && err.message ? err.message : String(err) });
    }
  }
  writeIndex(items);
  return { items, errors };
}

// 拖入的内容没有本地路径、但提供了可读字节时（如从聊天窗口拖出的图片）：
// 直接把字节写入暂存目录；图片生成缩略图，其它类型取系统图标。
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

async function addBuffers(payloads) {
  ensureDir();
  const items = readIndex();
  const errors = [];
  const list = Array.isArray(payloads) ? payloads : [];
  for (const it of list) {
    const displayName = it && it.name ? String(it.name) : "image";
    try {
      let buf;
      try {
        buf = it && it.data != null ? toBuffer(it.data) : null;
      } catch (e) {
        errors.push({ name: displayName, reason: "数据无法读取(" + (e.code || "ERR") + ")" });
        continue;
      }
      if (!buf || !buf.length) {
        errors.push({ name: displayName, reason: "没有可读取的数据" });
        continue;
      }
      const mime = (it && it.type) || "";
      let ext = path.extname(displayName).toLowerCase();
      if (!ext) {
        if (mime.indexOf("png") !== -1) ext = ".png";
        else if (mime.indexOf("jpeg") !== -1 || mime.indexOf("jpg") !== -1) ext = ".jpg";
        else if (mime.indexOf("gif") !== -1) ext = ".gif";
        else if (mime.indexOf("webp") !== -1) ext = ".webp";
        else ext = ".bin";
      }
      const id = uid();
      const stored = id + ext;
      const dest = path.join(dir(), stored);
      try {
        rawFs.writeFileSync(dest, buf);
      } catch (e) {
        errors.push({ name: displayName, reason: "保存失败(" + (e.code || "ERR") + ")" });
        continue;
      }
      let decoded = null;
      try {
        decoded = nativeImage.createFromBuffer(buf);
      } catch {}
      const decodedOk = !!decoded && !decoded.isEmpty() && decoded.getSize().width > 0;
      const isImage = mime.indexOf("image/") === 0 || IMAGE_EXT.has(ext) || decodedOk;
      const item = {
        id,
        name: displayName,
        ext: ext.replace(".", ""),
        size: buf.length,
        isImage,
        file: stored,
        addedAt: Date.now(),
      };
      if (isImage) {
        if (decodedOk) {
          try {
            const thumbName = id + ".thumb.png";
            const resized = decoded.resize({ width: 256 });
            rawFs.writeFileSync(path.join(dir(), thumbName), resized.toPNG());
            item.thumb = thumbName;
          } catch {}
        }
      } else {
        try {
          const icon = await app.getFileIcon(dest, { size: "large" });
          if (icon && !icon.isEmpty()) {
            const iconName = id + ".icon.png";
            rawFs.writeFileSync(path.join(dir(), iconName), icon.toPNG());
            item.icon = iconName;
          }
        } catch {}
      }
      console.log("保存拖入数据 name=" + displayName + " type=" + (mime || "(空)") + " size=" + buf.length + " isImage=" + isImage);
      items.push(item);
    } catch (err) {
      console.error("保存拖入数据失败:", displayName, err && (err.stack || err));
      errors.push({ name: displayName, reason: err && err.message ? err.message : String(err) });
    }
  }
  writeIndex(items);
  return { items, errors };
}

function list() {
  return readIndex();
}

function open(id) {
  const item = readIndex().find((x) => x.id === id);
  if (!item) return false;
  const p = safePath(item.file);
  if (!p || !fs.existsSync(p)) return false;
  shell.openPath(p).catch((err) => console.error("打开暂存文件失败:", err));
  return true;
}

function remove(id) {
  const items = readIndex();
  const item = items.find((x) => x.id === id);
  if (!item) return items;
  deleteFiles(item);
  const next = items.filter((x) => x.id !== id);
  writeIndex(next);
  return next;
}

function clear() {
  const items = readIndex();
  for (const it of items) deleteFiles(it);
  writeIndex([]);
  return [];
}

// 供“拖出到资源管理器”使用：返回暂存副本的绝对路径与可选图标文件
function dragInfo(id) {
  const item = readIndex().find((x) => x.id === id);
  if (!item) return null;
  const p = safePath(item.file);
  if (!p || !fs.existsSync(p)) return null;
  let iconPath = null;
  for (const f of [item.thumb, item.icon]) {
    if (!f) continue;
    const q = safePath(f);
    if (q && fs.existsSync(q)) { iconPath = q; break; }
  }
  return { path: p, iconPath, isDir: !!item.isDir };
}

module.exports = { addFiles, addBuffers, list, open, remove, clear, dir, safePath, mimeFor, dragInfo };