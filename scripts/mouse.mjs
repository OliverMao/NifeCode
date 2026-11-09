// SPDX-License-Identifier: GPL-3.0-or-later
// 用 CDP Input 域发真实鼠标事件（合成 DOM 事件跟真鼠标行为不一样）
// 用法: node scripts/mouse.mjs dblclick <x> <y>   |   node scripts/mouse.mjs click <x> <y>
const PORT = process.env.CDP_PORT ?? 9222;
const [kind, xs, ys] = process.argv.slice(2);
const x = Number(xs);
const y = Number(ys);
if (!kind || Number.isNaN(x) || Number.isNaN(y)) {
  console.error("用法: node scripts/mouse.mjs dblclick 100 60");
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

const move = () => send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
const down = (n) =>
  send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: n });
const up = (n) =>
  send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: n });

await move();
await down(1);
await up(1);
if (kind === "dblclick") {
  await new Promise((r) => setTimeout(r, 40));
  await down(2);
  await up(2);
}
console.log(`已发送 ${kind} @ ${x},${y}`);
ws.close();
