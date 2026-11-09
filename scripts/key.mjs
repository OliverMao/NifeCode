// 通过 CDP Input 域发真实键盘事件（合成 DOM 事件进不了 xterm / Monaco）
// 用法: node scripts/key.mjs "Ctrl+Tab" | "Ctrl+w" | "Ctrl+1" | "Ctrl+Shift+C"
const PORT = process.env.CDP_PORT ?? 9222;
const spec = process.argv.slice(2).join(" ").trim();
if (!spec) { console.error("用法: node scripts/key.mjs Ctrl+Tab"); process.exit(1); }
const parts = spec.split("+");
const k = parts.pop();
const mods = new Set(parts.map((p) => p.toLowerCase()));
const modifiers = (mods.has("alt") ? 1 : 0) | (mods.has("ctrl") ? 2 : 0) | (mods.has("meta") ? 4 : 0) | (mods.has("shift") ? 8 : 0);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && t.url.startsWith("http"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
let nextId = 1;
const send = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener("message", onMsg); resolve(m); } };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id, method, params }));
});
const keyName = k.length === 1 ? k : k;
const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : ({ Tab: 9, Enter: 13, Escape: 27, Backspace: 8, Delete: 46 }[k] ?? 0);
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
console.log("已发送:", spec);
ws.close();
