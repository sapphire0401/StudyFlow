// 一键 Windows 打包脚本：npm run make:win
//
// 背景：Squirrel/rcedit 在「含中文等非 ASCII 字符的路径」下会报
// “Unable to load file”，导致 electron-forge make 失败。
// 本脚本在检测到非 ASCII 项目路径时，自动把项目镜像到一个纯 ASCII 的临时目录
// （复用已安装的 node_modules），在那里构建，再把生成的安装包复制回项目的 out/make。
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const root = process.cwd();
const buildDir = path.join(os.tmpdir(), "studyflow-build");
const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";

function hasNonAscii(s) {
  return /[^\x00-\x7F]/.test(s);
}

function runMake(dir) {
  console.log("> electron-forge make  (cwd: " + dir + ")");
  const r = spawnSync(npmCmd, ["run", "make"], { cwd: dir, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error("构建失败，退出码:", r.status);
    process.exit(r.status || 1);
  }
}

function mirror() {
  console.log("检测到非 ASCII 项目路径，镜像到 ASCII 目录构建: " + buildDir);
  if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true });
  // robocopy 增量复制；排除 out / .git。退出码 0-7 均视为成功。
  const args = [
    root,
    buildDir,
    "/E",
    "/XD",
    path.join(root, "out"),
    path.join(root, ".git"),
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP",
  ];
  const r = spawnSync("robocopy", args, { stdio: "ignore" });
  if (r.status === null || r.status >= 8) {
    console.error("robocopy 镜像失败，退出码:", r.status);
    process.exit(1);
  }
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!hasNonAscii(root)) {
    // 纯 ASCII 路径：直接原地构建
    runMake(root);
    return;
  }
  mirror();
  runMake(buildDir);

  const from = path.join(buildDir, "out", "make");
  const to = path.join(root, "out", "make");
  copyDir(from, to);
  console.log("");
  console.log("安装包已复制回项目: " + to);
}

main();
