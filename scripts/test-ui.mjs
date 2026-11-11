// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// UI 冒烟测试：用 CDP 驱动真正跑起来的窗口，验证「多写了一点就容易坏」的那几条交互。
//
// 跑法（应用必须带远程调试端口启动）：
//   cd src-tauri/target/release && WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./nifecode.exe
//   node scripts/test-ui.mjs
// 覆盖：文件选择器（本机自带弹窗）、文件树自动展开、同一文件去重、图片缩放（滚轮/±/锚点/下限）、
//       删除后标签跟着关（文件 + 文件夹）、拖拽落文件。
// 会临时把工作区切到 <repo>/.probe/ws（gitignored），跑完还原；测试文件由脚本自己生成和删除。
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
const PORT = process.env.CDP_PORT ?? 9222;
const B = "http://127.0.0.1:7317";
const slashes = (p) => (p ?? "").split(String.fromCharCode(92)).join("/"); // 反斜杠换成正斜杠
const norm = (p) => slashes(p).toLowerCase(); // 比较用：本机不区分大小写
const WS_ROOT = slashes(fileURLToPath(new URL("../.probe/ws", import.meta.url)));

// 每次跑都保证测试文件在位（上一轮会把它们删掉）
fs.mkdirSync(`${WS_ROOT}/sub`, { recursive: true });
fs.writeFileSync(`${WS_ROOT}/a.txt`, "hello A\nsecond line\n");
fs.writeFileSync(`${WS_ROOT}/sub/deep.txt`, "deep file\n");
fs.writeFileSync(`${WS_ROOT}/gone.txt`, "to be deleted\n");

/** 造一张纯色 PNG（测试图预览用，不依赖外部工具） */
function ensurePng(file, w, h) {
  if (fs.existsSync(file)) return;
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = 30;
      raw[p + 1] = 30;
      raw[p + 2] = (x * 255) / w;
    }
  }
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}
ensurePng(`${WS_ROOT}/sub/big.png`, 1600, 1200);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("http"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});
let id = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
const send = (method, params = {}) =>
  new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bridgeState = async () => (await fetch(B + "/state")).json();
const bridgeOpen = (path) => fetch(B + "/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });

async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(`JS 异常: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`);
  return r.result?.result?.value;
}
async function waitFor(expr, ms = 6000, label = expr) {
  const t0 = Date.now();
  for (;;) {
    if (await ev(expr)) return true;
    if (Date.now() - t0 > ms) throw new Error(`等待超时: ${label}`);
    await sleep(120);
  }
}
let fails = 0;
function check(ok, name, extra = "") {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}
async function mouse(type, x, y, extra = {}) {
  await send("Input.dispatchMouseEvent", { type, x, y, button: "none", clickCount: 0, deltaX: 0, deltaY: 0, ...extra });
}
async function clickAt(x, y) {
  await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
  await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
}
async function ctrlKey(k) {
  const vk = k === "=" ? 187 : 189;
  const code = k === "=" ? "Equal" : "Minus";
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: 2 });
}
const rect = (sel) =>
  ev(`JSON.stringify((() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top) }; })())`).then((s) => (s ? JSON.parse(s) : null));

const startState = await (await fetch(B + "/state")).json();
await ev(`window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String((e.reason && e.reason.stack) || e.reason)))`);

// ---------- T1 本机文件夹选择器（应用内弹窗，不是系统对话框）----------
await ev(`document.querySelector('#btn-open-folder').click()`);
await waitFor(`!!document.querySelector('#pk-list')`, 5000, "#pk-list 出现");
const title = await ev(`document.querySelector('#modal .title').textContent`);
check(title === "打开文件夹", "T1a 本机弹的是自带选择器", `title=${title}`);
await ev(`(() => { const i = document.querySelector('#pk-input'); i.value = ${JSON.stringify(WS_ROOT)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
await waitFor(`document.querySelectorAll('#pk-list .pk-row').length >= 2`, 8000, "列出了测试目录");
const rows = await ev(`[...document.querySelectorAll('#pk-list .pk-row .name')].map(n => n.textContent)`);
check(!rows.includes("a.txt") && rows.includes("sub") && rows.includes(".."), "T1b 只列文件夹（文件不出现，有 ..）", JSON.stringify(rows));
await ev(`[...document.querySelectorAll('#modal .actions button')].find(b => b.textContent === '打开').click()`);
await waitFor(`document.querySelector('#tree .node') !== null`, 8000, "文件树出现");
let st = startState;
for (let i = 0; i < 20; i++) { st = await bridgeState(); if (norm(st.root) === norm(WS_ROOT)) break; await sleep(300); }
check(norm(st.root) === norm(WS_ROOT), "T1c 工作区切到测试目录", `root=${st.root}`);

// ---------- T2 文件页换文件 → 文件树自动展开并高亮 ----------
const deep = `${WS_ROOT}/sub/deep.txt`;
await bridgeOpen(deep);
await waitFor(`!!document.querySelector('#tree .node[data-path="${deep}"]')`, 8000, "树里展开出 deep.txt");
const cur = await ev(`document.querySelector('#tree .node.current')?.dataset.path ?? ''`);
check(cur === deep, "T2 当前文件在树里高亮（父目录自动展开）", `current=${cur}`);

// ---------- T3 同一个文件的两种写法 = 一个标签 ----------
const variants = [
  deep,
  deep.replace(/\//g, "\\\\"), // D:\a_new_project\...\deep.txt（系统/agent 常给这种）
  "d:" + deep.slice(2), // 小写盘符
  deep.replace("/sub/", "/sub/./"), // 带 .
];
for (const v of variants) {
  await bridgeOpen(v);
  await sleep(300);
}
const tabs = await ev(`[...document.querySelectorAll('#tabs .tab')].map(t => t.dataset.path)`);
check(tabs.filter((p) => p && p.toLowerCase().endsWith("deep.txt")).length === 1, "T3 同一个文件不同写法只开一个标签", JSON.stringify(tabs));

// ---------- T5 图片预览缩放 ----------
// 先把界面字号复位，T5f 才能看出「预览里的 Ctrl+- 不影响界面字号」
await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true }))`);
await sleep(150);
const img = `${WS_ROOT}/sub/big.png`;
await bridgeOpen(img);
await waitFor(`!!document.querySelector('#img-view img') && document.querySelector('#img-view .sz').textContent.includes('%')`, 8000, "图片预览就绪");
const uiFont0 = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--ui')`);
const base = await ev(`JSON.stringify((() => { const v = document.querySelector('#img-view'); const r = v.querySelector('img').getBoundingClientRect(); return { pct: v.querySelector('.sz').textContent, w: Math.round(r.width), left: r.left, top: r.top }; })())`).then(JSON.parse);
const mx = Math.round(base.left + (base.w * 2) / 3);
const my = Math.round(base.top + 50);
const uBefore = await ev(`((() => { const r = document.querySelector('#img-view img').getBoundingClientRect(); return (${mx} - r.left) / r.width; })())`);
for (let i = 0; i < 3; i++) await mouse("mouseWheel", mx, my, { deltaY: -120, modifiers: 2 });
await sleep(250);
const zoomed = await ev(`JSON.stringify((() => { const v = document.querySelector('#img-view'); const r = v.querySelector('img').getBoundingClientRect(); return { pct: v.querySelector('.sz').textContent, w: Math.round(r.width), u: (${mx} - r.left) / r.width }; })())`).then(JSON.parse);
check(zoomed.w > base.w, "T5a Ctrl+滚轮放大生效", `${base.w}px → ${zoomed.w}px (${zoomed.pct})`);
check(Math.abs(zoomed.u - uBefore) < 0.03, "T5b 鼠标下那一点基本不动（锚点）", `u ${uBefore.toFixed(3)} → ${zoomed.u.toFixed(3)}`);

// Ctrl+= 放大
const w1 = zoomed.w;
await ctrlKey("=");
await sleep(200);
const w2 = await ev(`Math.round(document.querySelector('#img-view img').getBoundingClientRect().width)`);
check(w2 > w1, "T5c Ctrl+= 放大生效", `${w1}px → ${w2}px`);

// Ctrl+- 缩小，并且锚在图像中心、不连累界面字号
const c0 = await ev(`JSON.stringify((() => { const r = document.querySelector('#img-view img').getBoundingClientRect(); return { w: Math.round(r.width), cx: Math.round(r.left + r.width / 2) }; })())`).then(JSON.parse);
await ctrlKey("-");
await sleep(200);
const c1 = await ev(`JSON.stringify((() => { const r = document.querySelector('#img-view img').getBoundingClientRect(); return { w: Math.round(r.width), cx: Math.round(r.left + r.width / 2) }; })())`).then(JSON.parse);
check(c1.w < c0.w, "T5d Ctrl+- 缩小生效", `${c0.w}px → ${c1.w}px`);
check(Math.abs(c1.cx - c0.cx) <= 2, "T5e Ctrl+- 锚在图像中心", `cx ${c0.cx} → ${c1.cx}`);
const uiFont1 = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--ui')`);
check(uiFont0 === uiFont1, "T5f 预览里按 Ctrl+- 不再连带缩小整个界面", `${uiFont0} → ${uiFont1}`);

// 缩放下限 = 铺满
for (let i = 0; i < 12; i++) await ctrlKey("-");
await sleep(250);
const floor = await ev(`JSON.stringify((() => { const v = document.querySelector('#img-view'); const r = v.querySelector('img').getBoundingClientRect(); return { w: Math.round(r.width), bd: v.querySelector('.bd').clientWidth, pct: v.querySelector('.sz').textContent }; })())`).then(JSON.parse);
check(floor.w <= floor.bd && Math.abs(floor.w - base.w) <= 2, "T5g 缩放下限 = 刚好铺满", `${floor.w}px / 区域 ${floor.bd}px (${floor.pct})`);
await ev(`document.querySelector('#img-view .x').click()`);
check(!(await ev(`!!document.querySelector('#img-view')`)), "T5h 关掉预览");

// ---------- T4 删除 → 中间标签跟着关掉 ----------
// T4a 键盘 Delete 删文件
const gone = `${WS_ROOT}/gone.txt`;
await bridgeOpen(gone);
await waitFor(`[...document.querySelectorAll('#tabs .tab')].some(t => (t.dataset.path ?? '').endsWith('gone.txt'))`, 6000, "gone.txt 已打开");
await sleep(1600); // 等树轮询把新文件刷出来
await waitFor(`!!document.querySelector('#tree .node[data-path="${gone}"]')`, 8000, "树里有 gone.txt");
const row = await rect(`#tree .node[data-path="${gone}"]`);
await clickAt(row.x, row.y); // 真鼠标点：选中 + treeFocus
await waitFor(`document.querySelector('#tree .node.active[data-path="${gone}"]') !== null`, 3000, "树里选中 gone.txt");
// 注：键盘 Delete 在这里被拦住了 —— 点文件行会把焦点送到 Monaco 的 textarea，
// 被「在输入框里按 Delete 是删字符」的守卫筛掉（见报告里的发现 1）。所以这里走右键菜单。
await ev(`(() => { const r = document.querySelector('#tree .node[data-path="${gone}"]'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(b.left + 40), clientY: Math.round(b.top + 8) })); })()`);
await waitFor(`!!document.querySelector('#ctxmenu:not(.hidden)')`, 4000, "右键菜单");
await ev(`[...document.querySelectorAll('#ctxmenu .mi')].find(m => m.textContent === '删除').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
await waitFor(`document.querySelector('#modal .title').textContent === '删除' && !document.querySelector('#modal').classList.contains('hidden')`, 6000, "删除确认框（右键菜单）");
await ev(`[...document.querySelectorAll('#modal .actions button')].find(b => b.textContent === '删除').click()`);
await sleep(900);
const stillOpen = await ev(`[...document.querySelectorAll('#tabs .tab')].some(t => (t.dataset.path ?? '').endsWith('gone.txt'))`);
check(!stillOpen, "T4a 删除后标签自动关闭");
check(await ev(`document.querySelector('#tree .node[data-path="${gone}"]') === null`), "T4b 树里也没了");
check(!fs.existsSync(gone), "T4c 文件真的删掉了");

// T4d 右键菜单删文件夹：里面的文件标签也得一起关（deep.txt 目前开着）
const subDir = `${WS_ROOT}/sub`;
await waitFor(`[...document.querySelectorAll('#tabs .tab')].some(t => (t.dataset.path ?? '').endsWith('deep.txt'))`, 4000, "deep.txt 开着");
await ev(`(() => { const r = document.querySelector('#tree .node[data-path="${subDir}"]'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(b.left + 40), clientY: Math.round(b.top + 8) })); })()`);
await waitFor(`!!document.querySelector('#ctxmenu:not(.hidden)')`, 4000, "右键菜单");
await ev(`[...document.querySelectorAll('#ctxmenu .mi')].find(m => m.textContent === '删除').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
await waitFor(`document.querySelector('#modal .title').textContent === '删除' && !document.querySelector('#modal').classList.contains('hidden')`, 6000, "删除确认框（右键菜单）");
await ev(`[...document.querySelectorAll('#modal .actions button')].find(b => b.textContent === '删除').click()`);
await sleep(1200);
check(!(await ev(`[...document.querySelectorAll('#tabs .tab')].some(t => (t.dataset.path ?? '').endsWith('deep.txt'))`)), "T4d 删文件夹后里面的文件标签也关了");
check(!fs.existsSync(subDir), "T4e 文件夹真的删掉了");

// ---------- T6 拖拽落文件（模拟 Rust 侧发出的 drop 事件）----------
const dragPath = `${WS_ROOT}/a.txt`.replace(/\//g, "\\\\"); // 系统给的是反斜杠
const emitted = await ev(`(async () => {
  try {
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'tauri://drag-drop', payload: { type: 'drop', paths: [${JSON.stringify(dragPath)}], position: { x: 400, y: 300 } } });
    return 'ok';
  } catch (e) { return 'err: ' + String(e).slice(0, 200); }
})()`);
check(emitted === "ok", "T6a 能模拟 OS 的 drag-drop 事件", emitted);
await sleep(1000);
const dropped = await ev(`[...document.querySelectorAll('#tabs .tab')].some(t => (t.dataset.path ?? '').replace(/\\\\/g, '/').toLowerCase().endsWith('a.txt'))`);
check(!!dropped, "T6b 拖进来的文件开成标签（反斜杠路径也行）");

// ---------- 收尾 ----------
const last = await bridgeState();
check((last.lastError ?? null) === (startState.lastError ?? null), "本次没有新的前端异常", String(last.lastError));
check(last.dirty.length === 0, "测试过程没有留下未保存改动", JSON.stringify(last.dirty));

await fetch(B + "/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: startState.root }) });
await sleep(2500);
console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
ws.close();
process.exit(fails ? 1 : 0);
