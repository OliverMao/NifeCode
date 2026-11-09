// 生成应用图标：极简 "N + 小刀"（斜笔当刀刃，刀尖顺着斜线越出底线）
// 纯 Node、零依赖、零素材：这里画形状 -> 4x 超采样抗锯齿 -> 打包成多尺寸 ICO
// 用法: node scripts/make-icon.mjs
import { writeFileSync, mkdirSync } from "node:fs";

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // 每个像素 4x4 采样

const BG = [69, 39, 96]; // #452760 品牌紫
const FG = [240, 236, 248]; // 近白

// ---------- 形状判定（坐标 0..1） ----------
function inRoundRect(x, y, r) {
  // 满尺寸方块 + 圆角：把点夹到内缩 r 的矩形上，看距离
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return dx * dx + dy * dy <= r * r;
}

function inRect(x, y, [x0, y0, x1, y1]) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- 几何：N 的两竖 + 刀刃斜笔 ----------
const PAD = 0.2;        // 四周留白
const STEM = 0.2;       // 竖笔宽度（占 N 盒宽比例）
const TIP = 1.5;        // 刀尖长度（占竖笔宽比例）

function shapes() {
  const x0 = PAD, y0 = PAD, x1 = 1 - PAD, y1 = 1 - PAD;
  const stem = (x1 - x0) * STEM;
  const lx = x0, rx = x1 - stem;
  const rects = [
    [lx, y0, lx + stem, y1],
    [rx, y0, rx + stem, y1],
  ];
  // 斜笔：从左上竖笔的右上角 -> 右下竖笔的左下角，再顺着同一方向伸出刀尖
  const stemH = stem / 2;
  // 先占位算出方向，再回填起点：让刀背的上角刚好贴住 y0，不要冒出顶边
  let dx = rx - (lx + stem), dy = y1 - y0;
  let len = Math.hypot(dx, dy);
  const a = [lx + stem, y0 + (dx / len) * stemH];
  dx = rx - a[0];
  dy = y1 - a[1];
  len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;   // 斜线方向
  const nx = -uy, ny = ux;              // 法线
  const b = [rx, y1];
  const tip = [b[0] + ux * stem * TIP, b[1] + uy * stem * TIP];
  const poly = [
    [a[0] + nx * stemH, a[1] + ny * stemH],
    [a[0] - nx * stemH, a[1] - ny * stemH],
    tip,
  ];
  return { rects, poly };
}

// ---------- 渲染 ----------
function render(size) {
  const { rects, poly } = shapes();
  const px = Buffer.alloc(size * size * 4);
  const R = 0.22; // 圆角半径（占整块比例）
  const total = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCover = 0;
      let nCover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inRoundRect(u, v, R)) continue;
          bgCover++;
          if (rects.some((r) => inRect(u, v, r)) || inPoly(u, v, poly)) nCover++;
        }
      }
      const o = (y * size + x) * 4;
      const a = bgCover / total;
      // 圆角外面要真的透明，所以 alpha 用背景覆盖率，颜色按剩余部分混
      const c =
        bgCover > 0
          ? [0, 1, 2].map((i) => Math.round((BG[i] * (bgCover - nCover) + FG[i] * nCover) / bgCover))
          : [0, 0, 0];
      px[o] = c[2];     // ICO/DIB 是 BGRA，别写成 RGB（以前就栽在这）
      px[o + 1] = c[1];
      px[o + 2] = c[0];
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

// ---------- ICO 打包 ----------
function icoImage(size, px) {
  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0);
  bih.writeInt32LE(size, 4);
  bih.writeInt32LE(size * 2, 8); // XOR + AND 两张图
  bih.writeUInt16LE(1, 12);
  bih.writeUInt16LE(32, 14);
  bih.writeUInt32LE(px.length, 20);
  // DIB 行是自下而上
  const rows = Buffer.alloc(px.length);
  for (let y = 0; y < size; y++) {
    px.copy(rows, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4);
  }
  const andMask = Buffer.alloc((((size + 31) >> 5) * 4) * size); // 全 0：用 alpha 通道
  return Buffer.concat([bih, rows, andMask]);
}

const images = SIZES.map((s) => icoImage(s, render(s)));
const dir = Buffer.alloc(6 + 16 * SIZES.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2); // 1 = icon
dir.writeUInt16LE(SIZES.length, 4);
let offset = 6 + 16 * SIZES.length;
SIZES.forEach((s, i) => {
  const o = 6 + 16 * i;
  dir.writeUInt8(s === 256 ? 0 : s, o);
  dir.writeUInt8(s === 256 ? 0 : s, o + 1);
  dir.writeUInt8(0, o + 2);
  dir.writeUInt8(0, o + 3);
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(images[i].length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += images[i].length;
});

mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/icon.ico", Buffer.concat([dir, ...images]));
console.log(`icon.ico 已生成：${SIZES.join("/")} 共 ${SIZES.length} 档`);
