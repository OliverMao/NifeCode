// SPDX-License-Identifier: GPL-3.0-or-later
// 用 CDP Input 域发真实鼠标/文字事件（合成 DOM 事件跟真实行为不一样）
// 用法: node scripts/mouse.mjs dblclick <x> <y> [ctrl]
//       node scripts/mouse.mjs click <x> <y> [ctrl]
//       node scripts/mouse.mjs type "echo hi"   (往当前焦点敲字符并回车)
const PORT = process.env.CDP_PORT ?? 9222;
const [kind, xs, ys] = process.argv.slice(2);
const x = Number(xs);
const y = Number(ys);
if (!kind || (kind !== "type" && (Number.isNaN(x) || Number.isNaN(y)))) {
  console.error("用法: node scripts/mouse.mjs dblclick 100 60 [ctrl]");
  process.exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("http"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});
let nextId = 1;
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) {
        ws.removeEventListener("message", onMsg);
        resolve(m);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

const modifiers = ys === "ctrl" ? 2 : 0;
const move = () => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers });
const down = (n) =>
  send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: n, modifiers });
const up = (n) =>
  send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: n, modifiers });

if (kind === "type") {
  await send("Input.insertText", { text: xs });
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  console.log(`已输入: ${xs}`);
  ws.close();
  process.exit(0);
}

await move();
// CDP 的 mouse modifiers 在 WebView2 里似乎不会同步到 ctrlKey，
// 先按一下 Control 让它变成"按住"状态
if (modifiers & 2) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
}
await down(1);
await up(1);
if (kind === "dblclick") {
  await new Promise((r) => setTimeout(r, 40));
  await down(2);
  await up(2);
}
console.log(`已发送 ${kind} @ ${x},${y}`);
if (modifiers & 2) {
  await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 0, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
}
ws.close();
