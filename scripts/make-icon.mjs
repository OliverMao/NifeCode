// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 生成一个 32x32 的 ICO，省掉找图标素材
// 图形：一块纯色方底 + 中间一根白竖条。底色是品牌紫 #452760
import { writeFileSync, mkdirSync } from "node:fs";

const W = 32, H = 32;
// 品牌紫 #452760，但 ICO/DIB 是 BGRA 顺序 —— 这里已经按 B,G,R 排好
const BG = [96, 39, 69];
const px = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const inSquare = x >= 5 && x < 27 && y >= 5 && y < 27;
    const inBar = x >= 11 && x < 15 && y >= 10 && y < 22;
    px[o] = inBar ? 255 : inSquare ? BG[0] : 0;
    px[o + 1] = inBar ? 255 : inSquare ? BG[1] : 0;
    px[o + 2] = inBar ? 255 : inSquare ? BG[2] : 0;
    px[o + 3] = inSquare ? 255 : 0;
  }
}

const bih = Buffer.alloc(40);
bih.writeUInt32LE(40, 0);
bih.writeInt32LE(W, 4);
bih.writeInt32LE(H * 2, 8);
bih.writeUInt16LE(1, 12);
bih.writeUInt16LE(32, 14);
bih.writeUInt32LE(px.length, 20);

const andMask = Buffer.alloc((((W + 31) >> 5) * 4) * H);
const image = Buffer.concat([bih, px, andMask]);

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry.writeUInt8(W, 0);
entry.writeUInt8(H, 1);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(image.length, 8);
entry.writeUInt32LE(22, 12);

mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/icon.ico", Buffer.concat([dir, entry, image]));
console.log("icon.ico 已生成（32x32，紫底 + 白竖条）");
