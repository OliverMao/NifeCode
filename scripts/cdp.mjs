// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 通过 CDP 在 NifeCode 的 WebView2 里执行 JS，用于调试
// 用法: node scripts/cdp.mjs "表达式"
const PORT = process.env.CDP_PORT ?? 9222;

let expr = process.argv.slice(2).join(" ");
if (expr.startsWith("@")) {
  expr = (await import("node:fs")).readFileSync(expr.slice(1), "utf8");
}
if (!expr) {
  console.error('用法: node scripts/cdp.mjs "<js 表达式>"');
  process.exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
// 只认应用页面：WebView2 有时会冒出权限提示框之类的 page 目标
// CDP_PICK=<子串> 可以点名连某个窗口（多窗口时用），比如 CDP_PICK="w=" 连拖出来的窗口
// CDP_PICK=__main__ 连主窗口（url 里没有 ?w=），其它值按子串匹配
const want = process.env.CDP_PICK ?? "";
if (want === "__main__") {
  const main = list.find((t) => t.type === "page" && t.url.startsWith("http") && !t.url.includes("?"));
  if (!main) {
    console.error("没有找到主窗口");
    process.exit(1);
  }
  globalThis.__mainPage = main;
}
const page =
  globalThis.__mainPage ??
  list.find((t) => t.type === "page" && t.url.startsWith("http") && t.url.includes(want)) ??
  list.find((t) => t.type === "page" && t.url.startsWith("http")) ??
  list.find((t) => t.type === "page");
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

const r = await send("Runtime.evaluate", {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  allowUnsafeEvalBlockedByCSP: true,
});

if (r.result?.exceptionDetails) {
  console.error("异常:", JSON.stringify(r.result.exceptionDetails, null, 2));
} else {
  console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
}
ws.close();
