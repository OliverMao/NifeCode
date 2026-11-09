// 用 CDP 合成中文输入法，看终端里到底往 pty 送了什么
// 用法: node scripts/ime.mjs "n nih nihao"   (每段一次 composition 更新，最后提交)
const PORT = process.env.CDP_PORT ?? 9222;
const steps = (process.argv[2] ?? "n ni nih niha nihao").split(" ");
const commit = process.argv[3] ?? "你好";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
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
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};

// 1) 装钩子：记录 pty_write / pty_resize
await ev(`(() => {
  if (window.__imeHook) return "already";
  window.__imeHook = true;
  window.__log = { writes: [], resizes: 0, comp: [] };
  const orig = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (...a) => {
    if (a[0] === "pty_write") window.__log.writes.push(a[1].data);
    else if (a[0] === "pty_resize") window.__log.resizes++;
    return orig(...a);
  };
  const ta = () => document.querySelector(".xterm-helper-textarea");
  for (const t of ["compositionstart", "compositionupdate", "compositionend"]) {
    document.addEventListener(t, (e) => window.__log.comp.push(t + ":" + e.data), true);
  }
  return "hooked";
})()`);

await ev(`document.querySelector(".xterm-helper-textarea")?.focus()`);
await new Promise((r) => setTimeout(r, 200));
await ev(`window.__log = { writes: [], resizes: 0, comp: [] }`);

// 2) 逐段输入法组合
for (const s of steps) {
  await send("Input.imeSetComposition", { text: s, selectionStart: s.length, selectionEnd: s.length });
  await new Promise((r) => setTimeout(r, 120));
}
await send("Input.insertText", { text: commit });
await new Promise((r) => setTimeout(r, 400));

const out = await ev(`JSON.stringify(window.__log)`);
console.log(out);
ws.close();
