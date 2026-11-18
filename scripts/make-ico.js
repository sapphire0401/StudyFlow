// 由 tray-icon.png 生成多尺寸 Windows 图标 icon.ico（真正包含多帧的 ICO，不是改后缀）
// 用法：node scripts/make-ico.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIcoMod = require("png-to-ico");
const pngToIco = pngToIcoMod.default || pngToIcoMod;

const root = path.join(__dirname, "..");
const src = path.join(root, "tray-icon.png");
const out = path.join(root, "icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(src)) throw new Error("找不到源图: " + src);

  const buffers = [];
  for (const size of SIZES) {
    const buf = await sharp(src)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    buffers.push(buf);
  }

  const ico = await pngToIco(buffers);
  fs.writeFileSync(out, ico);

  // 校验 ICO 头：6 字节 ICONDIR 后是 image count（LE uint16）
  const count = ico.readUInt16LE(4);
  console.log(`生成 ${out}  (${ico.length} 字节, 内含 ${count} 个尺寸: ${SIZES.join(", ")})`);
}

main().catch((err) => {
  console.error("生成 ICO 失败:", err);
  process.exit(1);
});
