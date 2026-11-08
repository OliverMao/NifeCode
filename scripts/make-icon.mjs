// 生成一个 32x32 的 ICO，省掉找图标素材
import { writeFileSync, mkdirSync } from "node:fs";

const W = 32, H = 32;
const px = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const inSquare = x >= 5 && x < 27 && y >= 5 && y < 27;
    const inChevron = x >= 11 && x < 15 && y >= 10 && y < 22;
    px[o] = inChevron ? 255 : inSquare ? 60 : 0;
    px[o + 1] = inChevron ? 255 : inSquare ? 122 : 0;
    px[o + 2] = inChevron ? 255 : inSquare ? 204 : 0;
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
console.log("icon.ico 已生成");
