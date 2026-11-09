// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 通过 CDP 截取 WebView2 自身渲染的画面（比屏幕截图更准）
import { writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? 9222;
const out = process.argv[2] ?? "shot.png";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) {
  console.error("没有找到页面目标");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener("open", r, { once: true });
  ws.addEventListener("error", j, { once: true });
});

let nextId = 1;
function send(method, params) {
  return new Promise((resolve) => {
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
}

const r = await send("Page.captureScreenshot", { format: "png" });
if (!r.result?.data) {
  console.error("截图失败:", JSON.stringify(r));
  process.exit(1);
}
writeFileSync(out, Buffer.from(r.result.data, "base64"));
console.log(`已保存 ${out}`);
ws.close();
