// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 生成多尺寸 ICO（16/24/32/48/64/128/256）。尺寸不全的时候任务栏/资源管理器
// 会把 32×32 硬拉大，糊成一团。图形跟标题栏的 favicon 一致：
// 品牌紫圆角方底 + 中间一根白竖条，坐标取自 index.html 里 viewBox="0 0 32 32"。
// 每档用 4 倍超采样再降采样，边缘才不会有锯齿。
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // 超采样倍数
const OUT = "src-tauri/icons/icon.ico";

// #452760 / #f0ecf8，32 视野下的几何
const BG = [0x45, 0x27, 0x60];
const FG = [0xf0, 0xec, 0xf8];
const SQ = { x: 5, y: 5, w: 22, h: 22, r: 2.5 };
const BAR = { x: 11, y: 10, w: 4, h: 12 };

/** 判断 32 视野下的点是否落在圆角方形里 */
function inSquare(x, y) {
  if (x < SQ.x || y < SQ.y || x >= SQ.x + SQ.w || y >= SQ.y + SQ.h) return false;
  const dx = Math.min(x - SQ.x, SQ.x + SQ.w - x);
  const dy = Math.min(y - SQ.y, SQ.y + SQ.h - y);
  return dx > SQ.r || dy > SQ.r || (SQ.r - dx) ** 2 + (SQ.r - dy) ** 2 <= SQ.r ** 2;
}

/** 渲染一档：返回 size*size*4 的 RGBA buffer（逐像素自己平均，不依赖图形库） */
function render(size) {
  const big = size * SS;
  const acc = new Float64Array(big * big * 4);
  for (let py = 0; py < big; py++) {
    for (let px = 0; px < big; px++) {
      // 采样点落在像素中心，换算回 32 视野
      const x = ((px + 0.5) / big) * 32;
      const y = ((py + 0.5) / big) * 32;
      const o = (py * big + px) * 4;
      if (!inSquare(x, y)) continue; // 透明
      const bar = x >= BAR.x && x < BAR.x + BAR.w && y >= BAR.y && y < BAR.y + BAR.h;
      const c = bar ? FG : BG;
      acc[o] = c[0];
      acc[o + 1] = c[1];
      acc[o + 2] = c[2];
      acc[o + 3] = 255;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          const al = acc[o + 3];
          r += acc[o] * al;
          g += acc[o + 1] * al;
          b += acc[o + 2] * al;
          a += al;
        }
      }
      const o = (y * size + x) * 4;
      // 按 alpha 加权平均颜色，半透明边缘才不会发黑
      out[o] = a ? Math.round(r / a) : 0;
      out[o + 1] = a ? Math.round(g / a) : 0;
      out[o + 2] = a ? Math.round(b / a) : 0;
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 最小 PNG 编码（8bit RGBA，无隔行）——ICO 支持直接塞 PNG */
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const images = SIZES.map((s) => ({ size: s, data: png(render(s), s) }));
const head = Buffer.alloc(6);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const dir = [];
for (const { size, data } of images) {
  const e = Buffer.alloc(16);
  e[0] = size >= 256 ? 0 : size; // 256 用 0 表示
  e[1] = size >= 256 ? 0 : size;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  dir.push(e);
}

mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync(OUT, Buffer.concat([head, ...dir, ...images.map((i) => i.data)]));
console.log(`${OUT}: ${SIZES.join("/")} -- ${offset} 字节`);
