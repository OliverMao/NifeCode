import "./style.css";
import { chromeIcon, iconFor, iconSvg, uiIcon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { EditorHost } from "./editor";
import { TerminalHost } from "./terminal";

interface Entry { name: string; path: string; is_dir: boolean }
interface ReadFile { content: string; mtime: number; encoding: string; huge?: boolean }

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------- 连接状态：host 为 null 表示本地 ----------
let host: string | null = null;
let port = 22;
let root: string | null = null;
const expanded = new Set<string>();

function connArg() {
  return { host, port };
}

// ---------- 上下文：本机 + 每个 SSH 连接各一份 ----------
interface Ctx {
  id: string;
  kind: "local" | "ssh";
  label: string;
  host: string | null;
  port: number;
  root: string | null;
  online?: boolean;    // 只有 SSH 用：false = 从上次会话恢复出来的、还没连
  wantRoot?: string;   // 重连后要回的目录（不是 $HOME 的时候）
}

const CTX_KEY = "contexts";
let ctxSeq = 1;
const contexts: Ctx[] = [{ id: "local:1", kind: "local", label: "本机", host: null, port: 22, root: null }];
let activeId = "local:1";

/** 本机和 SSH 标签都存；SSH 下次启动先当"未连接"，点一下再连 */
function saveCtxs() {
  const cur = curCtx();
  if (cur) cur.root = root;
  const tabs = contexts.map((c) =>
    c.kind === "local"
      ? { id: c.id, label: c.label, root: c.root }
      : { id: c.id, label: c.label, root: c.root, host: c.host, port: c.port }
  );
  localStorage.setItem(CTX_KEY, JSON.stringify({ locals: tabs, activeId }));
}

function restoreCtxs() {
  try {
    const raw = localStorage.getItem(CTX_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as {
      locals?: { id: string; label: string; root: string | null; host?: string | null; port?: number }[];
      activeId?: string;
    };
    if (!data.locals?.length) return;
    contexts.length = 0;
    for (const l of data.locals) {
      const isSsh = l.id.startsWith("ssh:");
      contexts.push({
        id: l.id,
        kind: isSsh ? "ssh" : "local",
        label: l.label,
        host: isSsh ? (l.host ?? null) : null,
        port: l.port ?? 22,
        root: l.root,
        online: isSsh ? false : undefined,
      });
    }
    activeId = contexts.some((c) => c.id === data.activeId) ? data.activeId! : contexts[0].id;
  } catch { /* 存坏了就用默认 */ }
}

function newLocalContext(): Ctx {
  ctxSeq += 1;
  const c: Ctx = { id: `local:${ctxSeq}`, kind: "local", label: `本机 ${ctxSeq}`, host: null, port: 22, root: null };
  contexts.push(c);
  return c;
}

async function pickFolder(): Promise<string | null> {
  return await invoke<string | null>("pick_folder").catch(() => null);
}

/** 从上次会话恢复出来、还没连上的 SSH 标签：这时候别去碰它，否则每 5 秒一次 ssh 握手/弹密码 */
function offlineCtx(): boolean {
  const c = curCtx();
  return c.kind === "ssh" && c.online === false;
}

function curCtx(): Ctx {
  return contexts.find((c) => c.id === activeId) ?? contexts[0];
}

function renderCtxBar() {
  const bar = $("#ctx-tabs");
  bar.innerHTML = "";
  for (const c of contexts) {
    const el = document.createElement("div");
    el.className = "ctx-tab" + (c.id === activeId ? " active" : "") + (c.online === false ? " offline" : "");
    const nm = document.createElement("span");
    nm.textContent = c.kind === "ssh" ? `SSH · ${c.label}` : c.label;
    nm.title = c.root ?? "";
    el.appendChild(nm);
    const closable = c.kind === "ssh" || contexts.length > 1;
    if (closable) {
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.title = c.kind === "ssh" ? "断开这个连接" : "关闭这个标签";
      x.onclick = (e) => { e.stopPropagation(); void closeContext(c.id); };
      el.appendChild(x);
    }
    el.onclick = () => switchContext(c.id);
    bar.appendChild(el);
  }
}

function applyActive() {
  const c = curCtx();
  host = c.host;
  port = c.port;
  root = c.root;
}

function switchContext(id: string) {
  if (id === activeId) return;
  const cur = curCtx();
  cur.root = root;
  cur.host = host;
  cur.port = port;
  if (!contexts.some((c) => c.id === id)) return;
  activeId = id;
  applyActive();
  const prof = contexts.some((c) => c.id === id && c.kind === "ssh")
    ? sshProfiles().find((p) => `ssh:${p.id}` === id)
    : undefined;
  if (prof) void invoke("ssh_set_identity", { key: prof.key ?? null }).catch(() => {});
  renderCtxBar();
  setConnLabel();
  renderSsh();
  $("#tree").innerHTML = "";
  expanded.clear();
  const c = curCtx();
  if (c.kind === "ssh" && c.online === false) {
    // 上次会话恢复出来的标签：点一下就重连，连上再回原来的目录
    $("#tree").innerHTML = `<div class="tree-tip">未连接，正在重连…</div>`;
    setMsg(`正在重连 ${c.label}…`);
    void reconnectCtx(c);
    return;
  }
  if (root) void renderTree(root, $("#tree"), 0);
  if ($("#scm").classList.contains("active")) void loadGit();
  else renderGit(null);
  setMsg(root ?? "未打开文件夹");
}

/** 恢复出来的 SSH 标签：用保存的配置重连（key 也在配置里） */
async function reconnectCtx(c: Ctx) {
  const prof = sshProfiles().find((p) => `ssh:${p.id}` === c.id);
  if (!prof) {
    $("#tree").innerHTML = `<div class="tree-tip">找不到这个连接的配置了</div>`;
    setMsg("找不到这个连接的配置");
    return;
  }
  c.wantRoot = c.root ?? undefined;
  await connectProfile(prof);
}

async function closeContext(id: string) {
  const c = contexts.find((x) => x.id === id);
  if (!c) return;
  if (c.kind === "local") {
    if (contexts.filter((x) => x.kind === "local").length <= 1 && contexts.length <= 1) return;
    contexts.splice(contexts.indexOf(c), 1);
    if (activeId === id) {
      const next = contexts.find((x) => x.kind === "local") ?? contexts[0];
      activeId = next.id;
      applyActive();
      $("#tree").innerHTML = "";
      expanded.clear();
      if (root) void renderTree(root, $("#tree"), 0);
      renderGit(null);
    }
    renderCtxBar();
    setConnLabel();
    saveCtxs();
    return;
  }
  // shortcut: 关任何一个 SSH 标签都会把所有常驻通道关掉，下次用再重开（约 3 秒）
  await invoke("ssh_close").catch(() => {});
  await invoke("fwd_stop_all").catch(() => {});
  void invoke("ssh_set_identity", { key: null }).catch(() => {});
  contexts.splice(contexts.indexOf(c), 1);
  if (activeId === id) {
    activeId = "local";
    applyActive();
    $("#tree").innerHTML = "";
    expanded.clear();
    if (root) void renderTree(root, $("#tree"), 0);
    renderGit(null);
  }
  renderCtxBar();
  setConnLabel();
  saveCtxs();
  setMsg("已断开 SSH，回到本机");
}

// ---------- 错误捕获：Agent 可以从 /state 读到最后一次错误 ----------
let lastError: string | null = null;
window.addEventListener("error", (e) => { lastError = String(e.message); });
window.addEventListener("unhandledrejection", (e) => { lastError = String(e.reason); });

// ---------- 状态栏 ----------
/** 状态栏右下角的"编码 / 换行符"，跟着当前文档走 */
function renderStatusInfo() {
  const d = editor.current();
  const enc = $<HTMLSpanElement>("#st-enc");
  const eol = $<HTMLSpanElement>("#st-eol");
  enc.textContent = d ? d.encoding.toUpperCase() : "";
  eol.textContent = d ? editor.eolOf(d.path) : "";
  enc.style.display = d ? "" : "none";
  eol.style.display = d ? "" : "none";
}

/** 换编码重新读盘（有未保存改动先问） */
async function pickEncoding() {
  const d = editor.current();
  if (!d) return;
  const r = await ask("选择编码", "换编码会按新编码重新从磁盘读一遍这个文件。", [
    { label: "UTF-8", value: "utf-8", primary: d.encoding !== "utf-8" },
    { label: "GBK", value: "gbk", primary: d.encoding === "gbk" },
    { label: "取消", value: "cancel" },
  ]);
  if (r === "cancel") return;
  if (editor.isDirty(d)) {
    const k = await ask("未保存的更改", `“${baseName(d.path)}” 有没保存的改动，重新读取会丢掉。`, [
      { label: "仍然读取", value: "ok" },
      { label: "取消", value: "no" },
    ]);
    if (k !== "ok") return;
  }
  try {
    const res = await invoke<ReadFile>("read_file", {
      host: d.host,
      port: d.port,
      path: d.path,
      encoding: r,
    });
    editor.reopen(d.path, res.content, res.mtime, res.encoding);
    editor.setEncoding(d.path, res.encoding);
    renderTabs(d.path);
    renderStatusInfo();
    setMsg(`编码：${res.encoding.toUpperCase()}`);
  } catch (e) {
    setMsg(`读不出来：${e}`);
  }
}

function setMsg(msg: string) {
  $<HTMLSpanElement>("#st-msg").textContent = msg;
}
function setConnLabel(pending?: string) {
  $<HTMLSpanElement>("#st-conn").textContent = pending ?? (host ? `SSH ${host}` : "本地");
}

// ---------- 模态框 ----------
type Btn = { label: string; value: string; primary?: boolean };
function ask(title: string, bodyHTML: string, buttons: Btn[]): Promise<string> {
  return new Promise((resolve) => {
    const m = $<HTMLDivElement>("#modal");
    m.querySelector(".title")!.textContent = title;
    const body = m.querySelector(".body") as HTMLDivElement;
    body.innerHTML = bodyHTML;
    const acts = m.querySelector(".actions") as HTMLDivElement;
    acts.innerHTML = "";
    for (const b of buttons) {
      const el = document.createElement("button");
      el.textContent = b.label;
      if (!b.primary) el.className = "secondary";
      el.onclick = () => { m.classList.add("hidden"); resolve(b.value); };
      acts.appendChild(el);
    }
    m.classList.remove("hidden");
    const first = body.querySelector("input") as HTMLInputElement | null;
    first?.focus();
  });
}
function closeModal() { $("#modal").classList.add("hidden"); }

// ---------- 未保存内容快照（崩溃/断电后还能捞回来） ----------
const DIRTY_KEY = "dirty-buffers";
/** shortcut: 只存本机文档，远端要靠连接才能恢复；单文件超过 2MB 不存，升级点：存到磁盘而不是 localStorage */
function snapshotDirty() {
  const list = editor
    .dirtyPaths()
    .map((p) => {
      const d = editor.docsFor(p)!;
      return { path: p, content: d.model.getValue().slice(0, 2_000_000), encoding: d.encoding };
    })
    .filter((it) => !editor.docsFor(it.path)?.host);
  try {
    if (list.length) localStorage.setItem(DIRTY_KEY, JSON.stringify(list));
    else localStorage.removeItem(DIRTY_KEY);
  } catch {
    /* 存不下就算了，别让快照把界面搞崩 */
  }
}

async function restoreDirty() {
  const raw = localStorage.getItem(DIRTY_KEY);
  if (!raw) return;
  localStorage.removeItem(DIRTY_KEY); // 只恢复一次
  let list: { path: string; content: string; encoding: string }[] = [];
  try {
    list = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(list) || !list.length) return;
  const r = await ask(
    "恢复未保存的更改",
    `上次退出时有 ${list.length} 个文件没保存：${list.map((x) => baseName(x.path)).join("、")}。要恢复这些改动吗？`,
    [
      { label: "恢复", value: "ok", primary: true },
      { label: "丢弃", value: "no" },
    ]
  );
  if (r !== "ok") return;
  let n = 0;
  for (const it of list) {
    const res = await invoke<ReadFile>("read_file", { host: null, port: 22, path: it.path }).catch(() => null);
    if (!res) continue;
    editor.openDirty(it.path, it.content, res.mtime, null, 22, it.encoding);
    n++;
  }
  renderTabs();
  setMsg(n ? `恢复了 ${n} 个文件` : "没有可恢复的文件");
}

// ---------- 编辑器 ----------
// ---------- 字号缩放（Ctrl+= / Ctrl+- / Ctrl+0）----------
const FONT_KEY = "font-size";
const FONT_DEFAULT = 13;
let fontSize = Number(localStorage.getItem(FONT_KEY)) || FONT_DEFAULT;

function applyFontSize(px: number) {
  fontSize = Math.max(9, Math.min(28, Math.round(px)));
  localStorage.setItem(FONT_KEY, String(fontSize));
  // 界面字号也跟着变：文件树、标签、状态栏、面板一起缩放
  document.documentElement.style.setProperty("--ui", `${fontSize}px`);
  editor.setFontSize(fontSize);
  terms.setFontSize(fontSize);
  setMsg(`字号 ${fontSize}px`);
}

function bumpFont(d: number | "reset") {
  applyFontSize(d === "reset" ? FONT_DEFAULT : fontSize + d);
}

const editor = new EditorHost(
  $("#editor"),
  (path, dirty) => markTabDirty(path, dirty),
  (line, col) => { $<HTMLSpanElement>("#st-pos").textContent = `行 ${line}，列 ${col}`; },
  () => void saveCurrent()
);

// ---------- 标签页 ----------

// ---------- 远端文件夹选择器（SSH 用）----------
async function pickRemoteFolder(start: string): Promise<string | null> {
  const m = $("#modal");
  m.querySelector(".title")!.textContent = "打开远端文件夹";
  const body = m.querySelector(".body") as HTMLDivElement;
  const acts = m.querySelector(".actions") as HTMLDivElement;
  body.style.whiteSpace = "normal";
  body.innerHTML = `
    <div class="pk-path">
      <input id="pk-input" spellcheck="false" placeholder="/home/user/project" />
    </div>
    <div id="pk-list" class="pk-list"></div>`;
  acts.innerHTML = "";
  m.classList.remove("hidden");

  const input = body.querySelector("#pk-input") as HTMLInputElement;
  const list = body.querySelector("#pk-list") as HTMLDivElement;
  let cur = start;

  const addRow = (label: string, onPick: () => void, isDir: boolean) => {
    const row = document.createElement("div");
    row.className = "pk-row";
    const ico = document.createElement("span");
    ico.className = "ico";
    if (isDir) ico.innerHTML = iconSvg(iconFor(label, true, false));
    else ico.textContent = "↰";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = label;
    row.append(ico, name);
    row.onclick = onPick;
    list.appendChild(row);
  };

  const go = async (path: string) => {
    cur = path;
    input.value = path;
    list.innerHTML = `<div class="pk-empty">读取中…</div>`;
    let entries: Entry[];
    try {
      entries = await invoke<Entry[]>("read_dir", { ...connArg(), path });
    } catch (e) {
      list.innerHTML = `<div class="pk-empty">打不开：${String(e).slice(0, 120)}</div>`;
      return;
    }
    list.innerHTML = "";
    const parent = parentDir(path);
    if (parent && parent !== path) addRow("..", () => void go(parent), false);
    const dirs = entries.filter((e) => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    if (dirs.length === 0) list.innerHTML = `<div class="pk-empty">（没有子文件夹）</div>`;
    for (const d of dirs) addRow(d.name, () => void go(d.path), true);
  };

  return new Promise<string | null>((resolve) => {
    const done = (v: string | null) => {
      m.classList.add("hidden");
      body.style.whiteSpace = "";
      m.onclick = null;
      resolve(v);
    };
    const ok = document.createElement("button");
    ok.textContent = "打开";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.className = "secondary";
    ok.onclick = () => done(cur);
    cancel.onclick = () => done(null);
    acts.append(cancel, ok);

    input.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const v = input.value.trim();
        if (v) void go(v);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        done(null);
      }
    };
    // 点遮罩关掉
    m.onclick = (ev) => { if (ev.target === m) done(null); };

    void go(start);
    input.focus();
    input.select();
  });
}

// ---------- 悬停提示：内容被截断时才显示完整路径 ----------
let tipTimer = 0;

function placeTip(text: string, ev: MouseEvent) {
  const tip = $("#tip");
  tip.textContent = text;
  tip.classList.remove("hidden");
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14;
  let y = ev.clientY + 18;
  if (x + r.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8);
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, ev.clientY - r.height - 12);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTip() {
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = 0;
  $("#tip").classList.add("hidden");
}

/** 给一个"可能被截断"的元素挂上提示；text 是要显示的完整内容 */
function bindTip(el: HTMLElement, measure: HTMLElement, text: () => string) {
  el.addEventListener("mouseenter", (ev) => {
    if (measure.scrollWidth <= measure.clientWidth + 1) return; // 没截断就不打扰
    const e2 = ev as MouseEvent;
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => placeTip(text(), e2), 350);
  });
  el.addEventListener("mouseleave", hideTip);
  el.addEventListener("mousedown", hideTip);
}

function baseName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** 关标签（✕ 和 Ctrl+W 共用），有未保存改动会先问 */
async function closeTab(p: string) {
  const d = editor.docsFor(p);
  if (!d) return;
  if (editor.isDirty(d)) {
    const r = await ask("未保存的更改", `“${baseName(p)}” 有未保存的更改，要保存吗？`, [
      { label: "保存", value: "save", primary: true },
      { label: "不保存", value: "discard" },
      { label: "取消", value: "cancel" },
    ]);
    if (r === "cancel") return;
    if (r === "save") await savePath(p);
  }
  const wasActive = editor.current()?.path === p;
  const i = editor.paths().indexOf(p);
  editor.close(p);
  // 关的是当前标签就顺手切到邻居（VS Code 也是这样），不然编辑器会空着
  if (wasActive) {
    const left = editor.paths();
    const next = left[Math.min(i, left.length - 1)];
    if (next) editor.show(next);
  }
  renderTabs();
}

/** 一次关多个；中途有未保存的会让你选，选了取消就停下 */
async function closeMany(paths: string[]) {
  for (const p of paths) {
    if (!editor.docsFor(p)) continue;
    await closeTab(p);
    if (editor.docsFor(p)) return; // 还开着 = 用户点了取消
  }
}

/** 标签右键菜单 */
function tabMenu(p: string): MenuItem[] {
  const paths = editor.paths();
  const i = paths.indexOf(p);
  const others = paths.filter((x) => x !== p);
  const right = paths.slice(i + 1);
  const clean = paths.filter((x) => {
    const d = editor.docsFor(x);
    return d && !editor.isDirty(d);
  });
  const items: MenuItem[] = [{ label: "关闭", run: () => void closeTab(p) }];
  if (others.length) items.push({ label: "关闭其他", run: () => void closeMany(others) });
  if (right.length) items.push({ label: "关闭右侧", run: () => void closeMany(right) });
  if (clean.length) items.push({ label: "关闭已保存", run: () => void closeMany(clean) });
  if (paths.length > 1) items.push({ label: "全部关闭", run: () => void closeMany(paths) });
  items.push(
    "sep",
    { label: "复制路径", run: () => copyText(p) },
    { label: "复制相对路径", run: () => copyText(relPath(p)) }
  );
  if (!host) {
    items.push("sep", {
      label: "在资源管理器中显示",
      run: () => { void invoke("fs_reveal", { path: p }).catch((err) => setMsg(`打不开：${err}`)); },
    });
  }
  return items;
}

function markTabDirty(path: string, dirty: boolean) {
  const el = Array.from($("#tabs").children).find((c) => (c as HTMLElement).dataset.path === path) as HTMLElement | undefined;
  el?.classList.toggle("dirty", dirty);
}

function renderTabs(activePath?: string) {
  const box = $("#tabs");
  box.innerHTML = "";
  if ((activePath ?? editor.current()?.path) && document.getElementById("img-view")) closeImage();
  const cur = activePath ?? editor.current()?.path;
  for (const p of editor.paths()) {
    const el = document.createElement("div");
    el.className = "tab" + (p === cur ? " active" : "");
    el.dataset.path = p;
    const doc = editor.docsFor(p);
    if (doc && editor.isDirty(doc)) el.classList.add("dirty");
    const name = document.createElement("span");
    name.textContent = baseName(p);
    name.style.overflow = "hidden";
    name.style.textOverflow = "ellipsis";
    bindTip(el, name, () => p);
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.onclick = async (e) => {
      e.stopPropagation();
      await closeTab(p);
    };
    el.append(name, x);
    el.onclick = () => { editor.show(p); renderTabs(p); };
    el.oncontextmenu = (ev) => {
      ev.preventDefault();
      showMenu(ev.clientX, ev.clientY, tabMenu(p));
    };
    // 鼠标中键点标签 = 关闭（VS Code 的习惯）
    el.onauxclick = (ev) => {
      if (ev.button === 1) {
        ev.preventDefault();
        void closeTab(p);
      }
    };
    box.appendChild(el);
  }
  renderStatusInfo();
}

// ---------- 打开 / 保存 ----------
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];

async function openFile(path: string, line?: number) {
  if (editor.has(path)) {
    editor.show(path);
    if (line) editor.revealLine(line);
    renderTabs(path);
    return;
  }
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXT.includes(ext)) {
    await openImage(path, ext);
    return;
  }
  try {
    const c = curCtx();
    const res = await invoke<ReadFile>("read_file", { host: c.host, port: c.port, path });
    const d = editor.open(path, res.content, res.mtime, c.host, c.port, res.encoding, !!res.huge);
    if (res.huge) setMsg(`${baseName(path)} 超过 8MB，已只读打开`);
    if (line) editor.revealLine(line);
    renderTabs(path);
    if (!res.huge) $<HTMLSpanElement>("#st-msg").textContent = path;
    void d;
  } catch (e) {
    lastError = `open ${path}: ${e}`;
    setMsg(`打开失败：${e}`);
  }
}

/** 图片预览：不改编辑器标签，盖一层浮层（带尺寸和关闭） */
async function openImage(path: string, ext: string) {
  setMsg(`正在载入图片 ${baseName(path)}…`);
  try {
    const c = curCtx();
    const b64 = await invoke<string>("read_binary", { host: c.host, port: c.port, path });
    const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
    closeImage();
    const box = document.createElement("div");
    box.id = "img-view";
    box.innerHTML = `<div class="hd"><span class="nm"></span><span class="spacer"></span><span class="sz"></span><span class="x" title="关闭">✕</span></div><div class="bd"><img alt="" /></div>`;
    box.querySelector(".nm")!.textContent = path;
    const img = box.querySelector("img") as HTMLImageElement;
    img.src = `data:${mime};base64,${b64}`;
    img.onload = () => { box.querySelector(".sz")!.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${Math.round((b64.length * 3) / 4 / 1024)} KB`; };
    (box.querySelector(".x") as HTMLElement).onclick = closeImage;
    $("#editor").parentElement!.appendChild(box);
    setMsg(path);
  } catch (e) {
    setMsg(`图片打不开：${e}`);
  }
}

function closeImage() {
  document.getElementById("img-view")?.remove();
}

async function savePath(path: string) {
  const doc = editor.docsFor(path);
  if (!doc) return;
  try {
    const mtime = await invoke<number>("write_file", {
      host: doc.host,
      port: doc.port,
      path,
      content: doc.model.getValue(),
      encoding: doc.encoding,
    });
    editor.markSaved(path, mtime);
    renderTabs(path);
    setMsg(`已保存 ${baseName(path)}`);
  } catch (e) {
    setMsg(`保存失败：${e}`);
  }
}

async function saveCurrent() {
  const d = editor.current();
  if (!d) return;
  await savePath(d.path);
  renderTabs(d.path);
}

// ---------- 文件树 ----------
function paintIcon(el: HTMLElement, name: string, isDir: boolean, path: string) {
  el.innerHTML = iconSvg(iconFor(name, isDir, expanded.has(path)));
}


// ---------- 资源管理器：右键菜单 + 自动刷新 ----------
type MenuItem = { label: string; run: () => void } | "sep";

let clip: { path: string; host: string | null; port: number; cut: boolean } | null = null;

function showMenu(x: number, y: number, items: MenuItem[]) {
  const m = $("#ctxmenu");
  m.innerHTML = "";
  for (const it of items) {
    if (it === "sep") {
      const d = document.createElement("div");
      d.className = "sep";
      m.appendChild(d);
      continue;
    }
    const el = document.createElement("div");
    el.className = "mi";
    el.textContent = it.label;
    el.onmousedown = (ev) => { ev.preventDefault(); ev.stopPropagation(); hideMenu(); it.run(); };
    m.appendChild(el);
  }
  m.classList.remove("hidden");
  m.style.left = "0px";
  m.style.top = "0px";
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
}

function hideMenu() {
  $("#ctxmenu").classList.add("hidden");
}

function parentOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return path;
  return path.slice(0, i);
}

/** 上一级目录：/home → /，D:/a → D:/，到顶返回 null */
function parentDir(path: string): string | null {
  const clean = path.replace(/[\/]+$/, "");
  const i = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (i < 0) return null;
  if (i === 0) return "/";
  if (i === 2 && /^[A-Za-z]:$/.test(clean.slice(0, 2))) return `${clean.slice(0, 2)}/`;
  const up = clean.slice(0, i);
  return up === clean ? null : up;
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\/]+$/, "")}/${name}`;
}

async function askText(title: string, label: string, value = ""): Promise<string | null> {
  const r = await ask(title, `<label>${label}</label><input id="mt-name" value="${value.replace(/"/g, "&quot;")}" />`, [
    { label: "确定", value: "ok", primary: true },
    { label: "取消", value: "no" },
  ]);
  if (r !== "ok") return null;
  const v = ($<HTMLInputElement>("#mt-name")).value.trim();
  return v || null;
}

function treeMenu(e: Entry): MenuItem[] {
  const dir = e.is_dir ? e.path : parentOf(e.path);
  const items: MenuItem[] = [
    { label: "新建文件", run: () => void newEntry(dir, false) },
    { label: "新建文件夹", run: () => void newEntry(dir, true) },
  ];
  if (clip) items.push({ label: `粘贴「${baseName(clip.path)}」`, run: () => void pasteInto(dir) });
  items.push("sep");
  if (!e.is_dir) items.push({ label: "打开", run: () => void openFile(e.path) });
  else items.push({ label: "在此打开工作区", run: () => void openRoot(e.path) });
  items.push(
    { label: "复制绝对路径", run: () => copyText(e.path) },
    { label: "复制相对路径", run: () => copyText(relPath(e.path)) },
    "sep",
    { label: "复制", run: () => setClip(e.path, false) },
    { label: "剪切", run: () => setClip(e.path, true) },
    { label: "重命名", run: () => void renameEntry(e.path) },
    { label: "删除", run: () => void deleteEntry(e.path) },
    "sep",
    { label: "在终端中打开", run: () => { showTerm(true); void terms.newTerminal(undefined, dir); } }
  );
  // 浏览器/资源管理器定位只有本机有
  if (!host) {
    items.push({ label: "在资源管理器中显示", run: () => { void invoke("fs_reveal", { path: e.path }).catch((err) => setMsg(`打不开：${err}`)); } });
  }
  return items;
}

/** 复制纯文本到系统剪贴板。走 Tauri 的插件：navigator.clipboard 会弹权限框，execCommand 在 WebView2 里被禁 */
async function copyText(text: string) {
  try {
    await writeText(text);
    setMsg(`已复制：${text}`);
  } catch (e) {
    setMsg(`复制失败：${e}`);
  }
}

/** 相对工作区根目录的路径 */
function relPath(p: string): string {
  if (!root) return p;
  const norm = (s: string) => s.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  const r = norm(root);
  const q = norm(p);
  if (q === r) return ".";
  return q.startsWith(`${r}/`) ? q.slice(r.length + 1) : q;
}

function setClip(path: string, cut: boolean) {
  clip = { path, host, port, cut };
  setMsg(`${cut ? "已剪切" : "已复制"} ${baseName(path)}`);
}

async function newEntry(dir: string, isDir: boolean) {
  const name = await askText(isDir ? "新建文件夹" : "新建文件", "名称", isDir ? "新建文件夹" : "untitled.txt");
  if (!name) return;
  const path = joinPath(dir, name);
  try {
    await invoke("fs_new", { ...connArg(), path, dir: isDir });
    if (isDir) expanded.add(dir);
    await refreshTree();
    setMsg(`已创建 ${path}`);
    if (!isDir) void openFile(path);
  } catch (err) {
    setMsg(`新建失败：${err}`);
  }
}

async function renameEntry(path: string) {
  const name = await askText("重命名", "新名称", baseName(path));
  if (!name || name === baseName(path)) return;
  try {
    await invoke("fs_rename", { ...connArg(), from: path, to: joinPath(parentOf(path), name) });
    await refreshTree();
    setMsg(`已重命名 ${baseName(path)} → ${name}`);
  } catch (err) {
    setMsg(`重命名失败：${err}`);
  }
}

async function deleteEntry(path: string) {
  const r = await ask("删除", `确定删除「${baseName(path)}」？<br/><span style="color:#e2c08d">远程目录会递归删除，不可恢复。</span>`, [
    { label: "删除", value: "ok", primary: true },
    { label: "取消", value: "no" },
  ]);
  if (r !== "ok") return;
  try {
    await invoke("fs_delete", { ...connArg(), path });
    await refreshTree();
    setMsg(`已删除 ${path}`);
  } catch (err) {
    setMsg(`删除失败：${err}`);
  }
}

async function pasteInto(dir: string) {
  if (!clip) return;
  const to = joinPath(dir, baseName(clip.path));
  if (to === clip.path) {
    setMsg("目标就是原位置");
    return;
  }
  try {
    const cmd = clip.cut ? "fs_rename" : "fs_copy";
    const args = clip.cut
      ? { host: clip.host, port: clip.port, from: clip.path, to }
      : { host: clip.host, port: clip.port, from: clip.path, to };
    await invoke(cmd, args);
    setMsg(`${clip.cut ? "已移动" : "已复制"}到 ${to}`);
    if (clip.cut) clip = null;
    await refreshTree();
  } catch (err) {
    setMsg(`粘贴失败：${err}`);
  }
}

let treeSig = "";
async function refreshTree() {
  if (!root) return;
  const active = document.querySelector<HTMLElement>(".node.active")?.dataset.path;
  $("#tree").innerHTML = "";
  await renderTree(root, $("#tree"), 0, true);
  if (active) document.querySelector<HTMLElement>(`.node[data-path="${CSS.escape(active)}"]`)?.classList.add("active");
  treeSig = "";
  fileCache = null;
}

/** 只 stat 一次，变了就重画：本地 1.5s / 远端 5s 一次 */
async function pollTree(reset = false) {
  if (!root) return;
  if (reset) treeSig = "";
  const dirs = [root, ...expanded].slice(0, 40);
  let mtimes: number[];
  try {
    mtimes = await invoke<number[]>("stat_files", { ...connArg(), paths: dirs });
  } catch {
    return;
  }
  const sig = mtimes.join(",");
  if (!treeSig) {
    treeSig = sig;
    return;
  }
  if (sig !== treeSig) await refreshTree();
}

async function renderTree(dir: string, container: HTMLElement, depth: number, silent = false) {
  let entries: Entry[];
  try {
    entries = await invoke<Entry[]>("read_dir", { ...connArg(), path: dir });
  } catch (e) {
    if (!silent) setMsg(`读取目录失败：${e}`);
    return;
  }
  const wrap = document.createElement("div");
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "node";
    row.dataset.path = e.path;
    row.style.paddingLeft = `${8 + depth * 12}px`;
    const ico = document.createElement("span");
    ico.className = "ico";
    paintIcon(ico, e.name, e.is_dir, e.path);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = e.name;
    row.append(ico, name);
    wrap.appendChild(row);

    bindTip(row, name, () => e.path);

    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!e.is_dir) {
        document.querySelectorAll(".node.active").forEach((n) => n.classList.remove("active"));
        row.classList.add("active");
      }
      showMenu(ev.clientX, ev.clientY, treeMenu(e));
    };

    if (e.is_dir) {
      row.onclick = async () => {
        if (expanded.has(e.path)) {
          expanded.delete(e.path);
          row.nextElementSibling?.remove();
          paintIcon(ico, e.name, true, e.path);
        } else {
          expanded.add(e.path);
          paintIcon(ico, e.name, true, e.path);
          const sub = document.createElement("div");
          row.after(sub);
          await renderTree(e.path, sub, depth + 1);
        }
        void pollTree(true);
      };
      // 刷新后恢复展开状态
      if (expanded.has(e.path)) {
        const sub = document.createElement("div");
        row.after(sub);
        await renderTree(e.path, sub, depth + 1, true);
      }
    } else {
      row.onclick = () => {
        document.querySelectorAll(".node.active").forEach((n) => n.classList.remove("active"));
        row.classList.add("active");
        void openFile(e.path);
      };
    }
  }
  container.appendChild(wrap);
}

async function openRoot(path: string) {
  root = path;
  const c = curCtx();
  c.root = path;
  if (c.kind === "local" && baseName(path)) {
    c.label = baseName(path);
    renderCtxBar();
  }
  saveCtxs();
  expanded.clear();
  $("#tree").innerHTML = "";
  await renderTree(path, $("#tree"), 0);
  // 终端 cwd 跟随工作区（cwd 是回调，不用重建），首次打开顺手起一个
  if (terms.count() === 0) {
    showTerm(true);
    void terms.newTerminal();
  }
  setMsg(path);
  void loadGit();
}

// ---------- 终端 ----------
// ---------- 终端类型（PowerShell / cmd / WSL / Git Bash）----------
interface ShellInfo { id: string; name: string; exe: string; args: string[] }
const SHELL_KEY = "term-shell";
let preferredShell = localStorage.getItem(SHELL_KEY) ?? "";
let shellList: ShellInfo[] = [];

async function loadShells() {
  shellList = await invoke<ShellInfo[]>("shells").catch(() => []);
  return shellList;
}

function currentShellName(): string {
  const s = shellList.find((x) => x.id === preferredShell) ?? shellList[0];
  return s?.name ?? "终端";
}

const terms = new TerminalHost(
  $("#terms"),
  $("#term-tabs"),
  () => root ?? undefined,
  () => (host ? { target: host, port } : null),
  () => {
    const s = shellList.find((x) => x.id === preferredShell) ?? shellList[0];
    return s ? { id: s.id, name: s.name } : null;
  }
);

function showTerm(on: boolean) {
  $("#term-col").classList.toggle("collapsed", !on);
  $("#app").classList.toggle("no-term", !on);
  if (on) requestAnimationFrame(() => terms.fitAll());
}

function toggleTerm() {
  showTerm($("#term-col").classList.contains("collapsed"));
}

// ---------- SSH ----------
interface SshProfile {
  id: string;
  name: string;
  target: string;
  port: number;
  key?: string;
  pw?: boolean; // 密码存在 Windows 凭据管理器里，这里只记一个标记
}

function sshProfiles(): SshProfile[] {
  try { return JSON.parse(localStorage.getItem("ssh-profiles") ?? "[]"); } catch { return []; }
}

function saveProfiles(list: SshProfile[]) {
  localStorage.setItem("ssh-profiles", JSON.stringify(list));
}

function renderSsh() {
  const list = $("#ssh-list");
  list.innerHTML = "";
  const profiles = sshProfiles();
  if (profiles.length === 0) {
    list.innerHTML = `<div class="sr-count">还没有保存的连接，点右上角 ＋ 新建</div>`;
    return;
  }
  for (const p of profiles) {
    const row = document.createElement("div");
    row.className = "ssh-row" + (host === p.target && port === p.port ? " active" : "");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = p.name;
    const tg = document.createElement("span");
    tg.className = "tg";
    tg.textContent = `${p.pw ? "🔑 " : ""}${p.target}:${p.port}`;
    tg.title = tg.textContent;
    const ops = document.createElement("span");
    ops.className = "ops";
    const edit = document.createElement("span");
    edit.textContent = "✎";
    edit.title = "编辑";
    edit.onclick = (e) => { e.stopPropagation(); void editProfile(p); };
    const del = document.createElement("span");
    del.textContent = "✕";
    del.title = "删除";
    del.onclick = async (e) => {
      e.stopPropagation();
      const r = await ask("删除连接", `确定删除“${p.name}”？`, [
        { label: "删除", value: "yes", primary: true },
        { label: "取消", value: "no" },
      ]);
      if (r === "yes") {
        await invoke("ssh_forget_password", { target: p.target, port: p.port }).catch(() => {});
        saveProfiles(sshProfiles().filter((x) => x.id !== p.id));
        renderSsh();
      }
    };
    ops.append(edit, del);
    row.append(nm, tg, ops);
    row.onclick = () => void connectProfile(p);
    list.appendChild(row);
  }
}

async function editProfile(existing?: SshProfile) {
  const r = await ask(
    existing ? "编辑连接" : "新建连接",
    `<label>名称</label><input id="pf-name" value="${(existing?.name ?? "").replace(/"/g, "&quot;")}" placeholder="GPU 服务器" />
     <label>主机（user@host 或 ~/.ssh/config 里的别名）</label><input id="pf-target" value="${(existing?.target ?? "").replace(/"/g, "&quot;")}" placeholder="root@10.0.0.5" />
     <label>端口</label><input id="pf-port" value="${existing?.port ?? 22}" />
     <label>私钥路径（可选，留空则用 ~/.ssh/config 或 ssh-agent）</label><input id="pf-key" value="${(existing?.key ?? "").replace(/"/g, "&quot;")}" placeholder="C:/Users/me/.ssh/id_gpu" />
     <label>密码（${existing?.pw ? "已保存，留空则保持不变" : "可选，存进 Windows 凭据管理器"}）</label><input id="pf-pass" type="password" value="" placeholder="••••••" />
     <div style="margin-top:10px;font-size:12px;color:#8c8c8c">
       密码存在 Windows 凭据管理器（DPAPI 保护，只有你这个 Windows 用户能解），不会写进 localStorage。
       有密码时 ssh 会通过自带的 askpass 助手自动填，文件读写/终端/端口转发都生效。
     </div>`,
    [{ label: existing ? "保存" : "保存并连接", value: "ok", primary: true }, { label: "取消", value: "cancel" }]
  );
  if (r !== "ok") return;
  const name = $<HTMLInputElement>("#modal #pf-name").value.trim();
  const target = $<HTMLInputElement>("#modal #pf-target").value.trim();
  const portNum = parseInt($<HTMLInputElement>("#modal #pf-port").value || "22", 10);
  const key = $<HTMLInputElement>("#modal #pf-key").value.trim();
  const pass = $<HTMLInputElement>("#modal #pf-pass").value;
  if (!name || !target) { setMsg("名称和主机都要填"); return; }
  const finalPort = portNum || 22;
  let hasPw = existing?.pw ?? false;
  if (pass) {
    try {
      await invoke("ssh_save_password", { target, port: finalPort, password: pass });
      hasPw = true;
    } catch (e) {
      await ask("保存密码失败", String(e), [{ label: "好", value: "ok", primary: true }]);
      return;
    }
  }
  const profile: SshProfile = {
    id: existing?.id ?? `p${Date.now()}`,
    name,
    target,
    port: finalPort,
    key: key || undefined,
    pw: hasPw,
  };
  const list = sshProfiles();
  const i = list.findIndex((x) => x.id === profile.id);
  if (i >= 0) list[i] = profile; else list.push(profile);
  saveProfiles(list);
  renderSsh();
  await connectProfile(profile);
}

let connecting = false;

async function connectProfile(p: SshProfile) {
  if (connecting) return; // 连按两下不会连两次
  connecting = true;
  try {
    // 先把标签插进去（"连接中…"），别让用户点完看不到任何反应
    const prev = curCtx();
    prev.root = root;
    prev.host = host;
    prev.port = port;

    const cid = `ssh:${p.id}`;
    let c = contexts.find((x) => x.id === cid);
    const wasOffline = c?.online === false; // 从上次会话恢复的标签：连不上要留着
    if (!c) {
      c = { id: cid, kind: "ssh", label: p.name, host: p.target, port: p.port, root: null };
      contexts.push(c);
    } else {
      c.label = p.name;
      c.host = p.target;
      c.port = p.port;
    }
    if (!c.wantRoot && c.root && c.root !== c.wantRoot) c.wantRoot = c.root;
    activeId = cid;
    applyActive();
    renderCtxBar();
    setConnLabel("连接中…");
    renderSsh();
    $("#tree").innerHTML = "";
    expanded.clear();

    setMsg(`正在连接 ${p.name}（${p.target}）…`);
    try {
      await invoke("ssh_set_identity", { key: p.key ?? null });
      // 前端兜个底：即使后端出意外，20 秒后也不再等
      const home = await Promise.race([
        invoke<string>("ssh_home", { target: p.target, port: p.port }),
        new Promise<string>((_, rej) => setTimeout(() => rej("连接超时（20 秒）"), 20000)),
      ]);
      c.online = true;
      c.root = c.wantRoot || home;
      c.wantRoot = undefined;
      applyActive();
      renderCtxBar();
      setConnLabel();
      renderSsh();
      await openRoot(c.root!);
      setMsg(`已连接 ${p.name}（${c.root}）`);
    } catch (e) {
      // 连不上就把这个空标签收回，别再留个死标签（上次会话恢复出来的除外，用户下次还能再点）
      if (wasOffline) c.online = false;
      else contexts.splice(contexts.indexOf(c), 1);
      activeId = prev.id;
      applyActive();
      renderCtxBar();
      setConnLabel();
      renderSsh();
      if (root) void renderTree(root, $("#tree"), 0);
      void invoke("ssh_set_identity", { key: null }).catch(() => {});
      setMsg(`连接 ${p.name} 失败`);
      await ask("连接失败", `${p.target}:${p.port}

${String(e)}`, [{ label: "好", value: "ok", primary: true }]);
    }
  } finally {
    connecting = false;
  }
}

function disconnect() {
  const c = curCtx();
  if (c.kind === "ssh") {
    void closeContext(c.id);
    return;
  }
  for (const x of [...contexts]) if (x.kind === "ssh") void closeContext(x.id);
}

// ---------- 源代码管理（git） ----------
interface GitFile { path: string; status: string }
interface GitInfo { repo: boolean; branch: string; files: GitFile[] }

function absJoin(rootDir: string, rel: string) {
  return `${rootDir.replace(/[\/]+$/, "")}/${rel.replace(/^[\/]+/, "")}`;
}

let lastGitJson = "";

function renderGit(info: GitInfo | null) {
  const json = JSON.stringify(info);
  if (json === lastGitJson) return; // 数据没变就别重建列表（4s 轮询会打断点击）
  lastGitJson = json;
  const branch = $<HTMLSpanElement>("#scm-branch");
  const list = $("#scm-list");
  list.innerHTML = "";
  if (!info) { branch.textContent = "—"; return; }
  if (!info.repo) { branch.textContent = "不是 git 仓库"; return; }
  branch.textContent = `⎇ ${info.branch || "(空仓库)"} · ${info.files.length} 个变更`;
  for (const f of info.files) {
    const row = document.createElement("div");
    row.className = "scm-row";
    const st = document.createElement("span");
    const code = f.status === "??" ? "U" : f.status[0];
    st.className = `st ${code}`;
    st.textContent = f.status === "??" ? "U" : f.status[0];
    st.title = f.status;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.path;
    name.title = f.path;
    const diffBtn = document.createElement("span");
    diffBtn.className = "diff";
    diffBtn.textContent = "⇄";
    diffBtn.title = "和 HEAD 对比";
    diffBtn.onclick = (e) => { e.stopPropagation(); void openGitDiff(f.path); };
    row.append(st, name, diffBtn);
    row.onclick = () => void openFile(absJoin(root!, f.path));
    list.appendChild(row);
  }
}

async function loadGit() {
  if (!root) { renderGit(null); return; }
  const label = $<HTMLSpanElement>("#scm-branch");
  if (label.textContent === "—") label.textContent = "读取中…";
  try {
    const info = await invoke<GitInfo>("git_info", { ...connArg(), cwd: root });
    renderGit(info);
  } catch (e) {
    $<HTMLSpanElement>("#scm-branch").textContent = `git 出错：${e}`;
  }
}

async function openGitDiff(rel: string) {
  if (!root) return;
  const abs = absJoin(root, rel);
  const oldText = await invoke<string>("git_head_file", { ...connArg(), cwd: root, path: rel }).catch(() => "");
  const newText = await invoke<ReadFile>("read_file", { ...connArg(), path: abs })
    .then((r) => r.content)
    .catch(() => "");
  await openDiff(abs, oldText, newText, { title: "Git HEAD 对比", apply: false });
}

async function doCommit() {
  if (!root) return;
  const box = $<HTMLTextAreaElement>("#scm-msg");
  const message = box.value.trim();
  if (!message) { setMsg("提交信息不能为空"); return; }
  try {
    const hash = await invoke<string>("git_commit", { ...connArg(), cwd: root, message });
    box.value = "";
    setMsg(`已提交 ${hash}`);
    await loadGit();
  } catch (e) {
    setMsg(`提交失败：${e}`);
  }
}

// ---------- 全项目搜索 ----------
interface SearchHit { path: string; line: number; text: string }

async function runSearch() {
  const q = $<HTMLInputElement>("#search-input").value.trim();
  const list = $("#search-list");
  if (!root || !q) { list.innerHTML = ""; return; }
  list.innerHTML = `<div class="sr-count">搜索中…</div>`;
  try {
    const hits = await invoke<SearchHit[]>("search", { ...connArg(), cwd: root, query: q, max: 200 });
    list.innerHTML = "";
    if (hits.length === 0) {
      list.innerHTML = `<div class="sr-count">没有匹配</div>`;
      return;
    }
    const count = document.createElement("div");
    count.className = "sr-count";
    count.textContent = `${hits.length} 处匹配`;
    list.appendChild(count);
    for (const h of hits) {
      const row = document.createElement("div");
      row.className = "sr-row";
      row.title = `${h.path}:${h.line}`;
      const file = document.createElement("span");
      file.className = "sr-file";
      const rel = h.path
        .replace(/\\/g, "/")
        .replace(root.replace(/\\/g, "/").replace(/\/+$/, "") + "/", "");
      file.textContent = `${rel}:${h.line}`;
      const text = document.createElement("span");
      text.className = "sr-text";
      text.textContent = h.text;
      row.append(file, text);
      row.onclick = () => void openFile(h.path, h.line);
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = "";
    setMsg(`搜索失败：${e}`);
  }
}

/** 全项目替换：直接改磁盘，改完把改过的文件里已打开且不脏的重新读一遍 */
async function runReplace() {
  const q = $<HTMLInputElement>("#search-input").value.trim();
  const to = $<HTMLInputElement>("#replace-input").value;
  if (!root || !q) { setMsg("先在上面填要搜的内容"); return; }
  const r = await ask("全部替换", `把当前工作区里所有 “${q}” 换成 “${to}”，直接写磁盘，不可撤销。`, [
    { label: "替换", value: "ok", primary: true },
    { label: "取消", value: "no" },
  ]);
  if (r !== "ok") return;
  setMsg("替换中…");
  try {
    const changed = await invoke<string[]>("replace_all", { ...connArg(), cwd: root, query: q, replacement: to, max: 200 });
    for (const rel of changed) {
      const abs = absJoin(root, rel);
      const d = editor.docsFor(abs);
      if (d && !editor.isDirty(d)) {
        const res = await invoke<ReadFile>("read_file", { host: d.host, port: d.port, path: abs }).catch(() => null);
        if (res) editor.reopen(abs, res.content, res.mtime, res.encoding);
      }
    }
    fileCache = null;
    setMsg(changed.length ? `替换了 ${changed.length} 个文件` : "没有文件被改");
    await runSearch();
    renderTabs();
  } catch (e) {
    setMsg(`替换失败：${e}`);
  }
}

// ---------- 端口转发（GPU 服务器上开 Jupyter/TensorBoard 用） ----------
interface Forward { id: number; local: number; remote: string; target: string }

async function renderForwards() {
  const fwds = await invoke<Forward[]>("fwd_list").catch(() => [] as Forward[]);
  const el = $<HTMLSpanElement>("#st-fwd");
  el.textContent = fwds.length ? `转发 ${fwds.map((f) => f.local).join(",")}` : "";
  el.title = fwds.map((f) => `127.0.0.1:${f.local} → ${f.target} 的 ${f.remote}`).join(" | ") || "点击停止全部端口转发";
}

async function addForward() {
  if (!host) {
    await ask("还没连 SSH", "先点 🔌 连上 GPU 服务器，再建端口转发。", [{ label: "好", value: "ok", primary: true }]);
    return;
  }
  const r = await ask(
    "端口转发",
    `<label>本地端口</label><input id="fwd-local" value="8888" />
     <label>远端主机</label><input id="fwd-rhost" value="127.0.0.1" />
     <label>远端端口</label><input id="fwd-rport" value="8888" />
     <div style="margin-top:10px;font-size:12px;color:#8c8c8c">
       启动后用浏览器打开 http://127.0.0.1:本地端口 即可访问 ${host} 上的服务。
     </div>`,
    [{ label: "启动", value: "ok", primary: true }, { label: "取消", value: "cancel" }]
  );
  if (r !== "ok") return;
  const local = parseInt($<HTMLInputElement>("#modal #fwd-local").value || "0", 10);
  const rhost = $<HTMLInputElement>("#modal #fwd-rhost").value.trim();
  const rport = parseInt($<HTMLInputElement>("#modal #fwd-rport").value || "0", 10);
  if (!local || !rport) { setMsg("端口填错了"); return; }
  try {
    const f = await invoke<Forward>("fwd_start", { target: host, port, local, rhost, rport });
    await renderForwards();
    setMsg(`端口转发已启动：http://127.0.0.1:${f.local} → ${f.target}:${f.remote}`);
  } catch (e) {
    await ask("端口转发失败", String(e), [{ label: "好", value: "ok", primary: true }]);
  }
}

// ---------- 外部改动检测 ----------
const prompted = new Set<string>();
async function pollExternalChanges() {
  const paths = editor.paths();
  if (paths.length === 0) return;
  // 按"来自哪台机器"分组，每组一次 stat_files
  const groups = new Map<string, { host: string | null; port: number; paths: string[] }>();
  for (const p of paths) {
    const doc = editor.docsFor(p);
    if (!doc) continue;
    const k = `${doc.host ?? ""}|${doc.port}`;
    if (!groups.has(k)) groups.set(k, { host: doc.host, port: doc.port, paths: [] });
    groups.get(k)!.paths.push(p);
  }
  for (const g of groups.values()) {
    let mtimes: number[];
    try {
      mtimes = await invoke<number[]>("stat_files", { host: g.host, port: g.port, paths: g.paths });
    } catch {
      continue;
    }
    for (let i = 0; i < g.paths.length; i++) {
      const path = g.paths[i];
      const mtime = mtimes[i] ?? 0;
      const known = editor.mtimeOf(path);
      if (known === undefined || mtime <= known) continue;
      const doc = editor.docsFor(path);
      if (!doc) continue;
      if (!editor.isDirty(doc)) {
        try {
          const res = await invoke<ReadFile>("read_file", { host: g.host, port: g.port, path });
          editor.reopen(path, res.content, res.mtime);
          markTabDirty(path, false);
          setMsg(`外部修改已重载：${baseName(path)}`);
        } catch { /* 文件可能被删除 */ }
      } else if (!prompted.has(path)) {
        prompted.add(path);
        const r = await ask("文件已被外部修改", `“${baseName(path)}” 在磁盘上变了，但你也有未保存的更改。`, [
          { label: "用磁盘版本", value: "reload", primary: true },
          { label: "保留我的", value: "keep" },
        ]);
        if (r === "reload") {
          const res = await invoke<ReadFile>("read_file", { host: g.host, port: g.port, path });
          editor.reopen(path, res.content, res.mtime);
          markTabDirty(path, false);
        } else {
          editor.markSaved(path, -1);
          markTabDirty(path, false);
        }
      }
    }
  }
}

// ---------- Agent Bridge ----------
async function pushBridgeState() {
  const d = editor.current();
  const sel = (window as any).__sel;
  await invoke("bridge_set_state", {
    state: {
      root,
      host,
      file: d?.path ?? null,
      dirty: editor.dirtyPaths(),
      selection: sel ?? null,
      lastError,
    },
  }).catch(() => {});
}

// ---------- 启动 ----------
async function boot() {
  setConnLabel();
  renderTabs();

  $<HTMLButtonElement>("#btn-new-term").onclick = () => { showTerm(true); void terms.newTerminal(); };
  // 界面小按钮统一用自绘 SVG（＋ ✕ ˅），别用字体里那些大小不一的符号
  for (const [id, name] of [
    ["#ctx-new", "plus"],
    ["#btn-open-folder", "plus"],
    ["#btn-ssh-new", "plus"],
    ["#btn-shell", "chevron"],
    ["#btn-new-term", "plus"],
    ["#btn-close-panel", "close"],
  ]) {
    const el = $(id);
    if (el) el.innerHTML = chromeIcon(name);
  }

  $<HTMLButtonElement>("#btn-shell").onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const r = btn.getBoundingClientRect();
    if (shellList.length === 0) await loadShells();
    const items: MenuItem[] = shellList.map((sh) => ({
      label: `${sh.id === preferredShell ? "● " : "　"}${sh.name}`,
      run: () => {
        preferredShell = sh.id;
        localStorage.setItem(SHELL_KEY, sh.id);
        showTerm(true);
        void terms.newTerminal(sh.id);
        setMsg(`新终端：${sh.name}`);
      },
    }));
    if (items.length === 0) items.push({ label: "没检测到可用终端", run: () => {} });
    showMenu(r.left, r.bottom + 4, items);
  };
  $<HTMLButtonElement>("#btn-close-panel").onclick = () => showTerm(false);

  // 拖动调整三栏宽度（资源管理器 / 编辑器 / 终端），宽度记到 localStorage
  const dragWidth = (
    el: HTMLElement,
    cssVar: string,
    storeKey: string,
    calc: (clientX: number) => number,
  ) => {
    el.addEventListener("mousedown", (down) => {
      down.preventDefault();
      document.body.style.cursor = "col-resize";
      const move = (e: MouseEvent) =>
        document.documentElement.style.setProperty(cssVar, `${calc(e.clientX)}px`);
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
        const v = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
        localStorage.setItem(storeKey, String(parseFloat(v)));
        terms.fitAll();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  };

  const savedSide = parseFloat(localStorage.getItem("side-w") ?? "");
  if (savedSide) {
    document.documentElement.style.setProperty("--side-w", `${Math.min(savedSide, window.innerWidth - 800)}px`);
  }
  const savedTerm = parseFloat(localStorage.getItem("term-w") ?? "");
  if (savedTerm) {
    // 至少给编辑器留 300px：48(活动栏) + 150(侧栏下限) + 300
    document.documentElement.style.setProperty("--term-w", `${Math.min(savedTerm, window.innerWidth - 498)}px`);
  }
  dragWidth($("#side-splitter"), "--side-w", "side-w", (x) => Math.max(150, Math.min(700, x - 48)));
  dragWidth($("#term-splitter"), "--term-w", "term-w", (x) =>
    Math.max(240, Math.min(window.innerWidth - 420, window.innerWidth - x))
  );

  $<HTMLButtonElement>("#ctx-new").onclick = async () => {
    saveCtxs();
    const prev = activeId;
    const c = newLocalContext();
    activeId = c.id;
    applyActive();
    renderCtxBar();
    const dir = await pickFolder();
    if (!dir) {
      // 取消了就别留空标签
      contexts.splice(contexts.indexOf(c), 1);
      activeId = prev;
      applyActive();
      renderCtxBar();
      return;
    }
    c.root = dir;
    c.label = baseName(dir) || c.label;
    await openRoot(dir);
    saveCtxs();
    setMsg(`已打开 ${dir}`);
  };
  $("#tree").addEventListener("scroll", hideTip, true);

  $("#tree").addEventListener("contextmenu", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest(".node")) return; // 行上自己有菜单
    if (!root) return;
    ev.preventDefault();
    const items: MenuItem[] = [
      { label: "新建文件", run: () => void newEntry(root!, false) },
      { label: "新建文件夹", run: () => void newEntry(root!, true) },
    ];
    if (clip) items.push({ label: `粘贴「${baseName(clip.path)}」`, run: () => void pasteInto(root!) });
    items.push("sep", { label: "复制工作区路径", run: () => void copyText(root!) });
    showMenu(ev.clientX, ev.clientY, items);
  });

  document.querySelectorAll<HTMLButtonElement>("#activity button").forEach((b) => {
    b.innerHTML = uiIcon(b.dataset.act ?? "");
  });

  restoreCtxs();
  applyActive();
  renderCtxBar();
  if (root) void renderTree(root, $("#tree"), 0);
  applyFontSize(fontSize);
  void loadShells();
  if (terms.count() === 0) void terms.newPage(true);

  $<HTMLButtonElement>("#btn-ssh-new").onclick = () => void editProfile();
  renderSsh();

  $<HTMLInputElement>("#search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void runSearch(); }
  });
  $<HTMLInputElement>("#replace-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void runReplace(); }
  });
  $<HTMLButtonElement>("#replace-all").onclick = () => void runReplace();
  $<HTMLSpanElement>("#st-fwd").onclick = async () => {
    const fwds = await invoke<Forward[]>("fwd_list").catch(() => []);
    if (!fwds.length) return;
    const r = await ask("端口转发", `当前 ${fwds.length} 条转发：
${fwds.map((f) => `127.0.0.1:${f.local} → ${f.remote}`).join(" | ")}`, [
      { label: "全部停止", value: "stop", primary: true },
      { label: "取消", value: "cancel" },
    ]);
    if (r === "stop") { await invoke("fwd_stop_all").catch(() => {}); await renderForwards(); setMsg("已停止全部端口转发"); }
  };

  $<HTMLButtonElement>("#scm-refresh").onclick = () => void loadGit();
  $<HTMLButtonElement>("#scm-do").onclick = () => void doCommit();
  $<HTMLTextAreaElement>("#scm-msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void doCommit(); }
  });

  $<HTMLButtonElement>("#btn-open-folder").onclick = async () => {
    if (host) {
      // SSH：弹一个远端目录浏览器，选完直接切工作区
      const dir = await pickRemoteFolder(root ?? "/");
      if (dir) {
        await openRoot(dir);
        setMsg(`工作区：${dir}`);
      }
      return;
    }
    const dir = await pickFolder();
    if (dir) {
      await openRoot(dir);
      saveCtxs();
    }
  };

  document.querySelectorAll<HTMLButtonElement>("#activity button").forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.act;
      document.querySelectorAll("#activity button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("#sidebar").classList.remove("collapsed");
      const titles: Record<string, string> = { explorer: "资源管理器", search: "搜索", scm: "源代码管理", ssh: "SSH 连接" };
      $("#tree").classList.toggle("hidden", act !== "explorer");
      $("#search-panel").classList.toggle("active", act === "search");
      $("#scm").classList.toggle("active", act === "scm");
      $("#ssh-panel").classList.toggle("active", act === "ssh");
      if (act === "ssh") renderSsh();
      $<HTMLSpanElement>("#sidebar-title").textContent = titles[act ?? "explorer"] ?? "资源管理器";
      if (act === "scm") void loadGit();
      if (act === "search") $<HTMLInputElement>("#search-input").focus();
    };
  });

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "`") { e.preventDefault(); toggleTerm(); }
    if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p")) {
      e.preventDefault();
      void showCommandPalette();
      return;
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      void quickOpen();
      return;
    }
    // 标签：Ctrl+W 关、Ctrl+Tab / Ctrl+Shift+Tab 切换、Ctrl+1~9 跳
    if (e.ctrlKey && !e.shiftKey && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      const cur = editor.current();
      if (cur) void closeTab(cur.path);
      return;
    }
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      const paths = editor.paths();
      const i = paths.indexOf(editor.current()?.path ?? "");
      if (paths.length > 1) {
        const next = (i + (e.shiftKey ? paths.length - 1 : 1)) % paths.length;
        editor.show(paths[next]);
        renderTabs(paths[next]);
      }
      return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      const p = editor.paths()[Number(e.key) - 1];
      if (p) {
        e.preventDefault();
        editor.show(p);
        renderTabs(p);
      }
      return;
    }
    // 焦点不在编辑器里时 Monaco 收不到 Ctrl+S，这里补一下（在编辑器里就让它自己存，别存两次）
    if (e.ctrlKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
      const t = e.target as HTMLElement | null;
      if (t && typeof t.closest === "function" && t.closest("#editor")) return;
      e.preventDefault();
      void saveCurrent();
    }
  });

  $<HTMLSpanElement>("#st-enc").onclick = () => void pickEncoding();

  // 关窗前把没保存的改动问一遍，别直接丢
  await getCurrentWindow().onCloseRequested(async (ev) => {
    const dirty = editor.dirtyPaths();
    if (!dirty.length) return;
    ev.preventDefault();
    const names = dirty.map(baseName).join("、");
    const r = await ask("未保存的更改", `这些文件还没保存：${names}`, [
      { label: "全部保存并关闭", value: "save", primary: true },
      { label: "不保存", value: "discard" },
      { label: "取消", value: "cancel" },
    ]);
    if (r === "cancel") return;
    if (r === "save") {
      for (const p of dirty) await savePath(p);
      if (editor.dirtyPaths().length) { setMsg("还有文件没存成功，先不关"); return; }
    }
    await getCurrentWindow().destroy();
  });

  document.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || typeof t.closest !== "function" || !t.closest("#ctxmenu")) hideMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
    if (e.key === "Escape") closeModal();
  });

  // 缩放放在捕获阶段：编辑器聚焦时 Monaco 会先把按键吃掉，捕获能保证我们先处理
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); e.stopPropagation(); bumpFont(1); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); e.stopPropagation(); bumpFont(-1); }
    else if (e.key === "0") { e.preventDefault(); e.stopPropagation(); bumpFont("reset"); }
  }, true);

  await listen<{ path: string; line?: number }>("bridge:open", (e) => { void openFile(e.payload.path, e.payload.line); });
  await listen<{ path: string }>("bridge:workspace", (e) => { host = null; setConnLabel(); void openRoot(e.payload.path); });
  await listen<{ path: string; oldContent?: string; newContent: string }>("bridge:diff", async (e) => {
    setMsg(`Agent 提案：${baseName(e.payload.path)}`);
    const cur = editor.docsFor(e.payload.path);
    let old = e.payload.oldContent ?? (cur ? cur.model.getValue() : "");
    if (!e.payload.oldContent && !cur) {
      // 文件没打开时，用磁盘上的当前内容作为对照
      old = await invoke<ReadFile>("read_file", { ...connArg(), path: e.payload.path })
        .then((r) => r.content)
        .catch(() => "");
    }
    await openDiff(e.payload.path, old, e.payload.newContent);
  });

  // 远端链路贵：降频；窗口不可见时也别查
  setInterval(() => {
    if (document.hidden || offlineCtx()) return;
    void pollExternalChanges();
  }, host ? 10000 : 1200); // 远端一次轮询就是一次完整 ssh 往返，别太勤
  setInterval(() => {
    if (offlineCtx()) return;
    if ($("#scm").classList.contains("active")) void loadGit();
  }, 4000);
  // 文件树自动刷新：只 stat 根目录 + 已展开的目录，变了才重画
  setInterval(() => {
    if (document.hidden || offlineCtx()) return;
    if (!$("#tree").classList.contains("hidden")) void pollTree();
  }, host ? 5000 : 1500);
  setInterval(() => { void pushBridgeState(); }, 2000);
  setInterval(snapshotDirty, 3000);

  if (!root) setMsg("就绪：点击左侧 ＋ 打开文件夹，或点 🔌 连接 SSH");
  void restoreDirty();
}

// ---------- Diff（agent 提案审阅）----------
async function openDiff(path: string, oldText: string, newText: string, opts: { title?: string; apply?: boolean } = {}) {
  const host_ = document.createElement("div");
  host_.style.cssText = "position:fixed;inset:48px 0 22px 48px;z-index:50;background:#1e1e1e;display:flex;flex-direction:column;border-left:1px solid #333;";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 10px;background:#252526;font-size:12px;";
  bar.innerHTML = `<span style="flex:1">${opts.title ?? "Agent 修改提案"}：${baseName(path)}</span>`;
  const ok = document.createElement("button");
  ok.textContent = "应用";
  ok.style.cssText = "background:#0e639c;color:#fff;border:0;padding:5px 12px;border-radius:2px;cursor:pointer;";
  const no = document.createElement("button");
  no.textContent = "取消";
  no.style.cssText = "background:#3a3d41;color:#fff;border:0;padding:5px 12px;border-radius:2px;cursor:pointer;";
  if (opts.apply === false) ok.style.display = "none";
  bar.append(ok, no);
  const wrap = document.createElement("div");
  wrap.style.cssText = "flex:1;min-height:0;";
  host_.append(bar, wrap);
  document.body.appendChild(host_);

  const { monaco } = await import("./editor");
  const diff = monaco.editor.createDiffEditor(wrap, { theme: "vs-dark", automaticLayout: true, renderSideBySide: true });
  const m1 = monaco.editor.createModel(oldText, undefined, monaco.Uri.parse(`inmemory://original/${path}`));
  const m2 = monaco.editor.createModel(newText, undefined, monaco.Uri.parse(`inmemory://proposed/${path}`));
  diff.setModel({ original: m1, modified: m2 });

  const done = () => { diff.dispose(); m1.dispose(); m2.dispose(); host_.remove(); };
  ok.onclick = async () => {
    // 按已打开文档的编码写回；文件本身没打开就按 UTF-8（Agent 给的也是 UTF-8 文本）
    const enc = editor.docsFor(path)?.encoding ?? "utf-8";
    await invoke("write_file", { ...connArg(), path, content: newText, encoding: enc }).catch((e) => setMsg(`写入失败：${e}`));
    await invoke<ReadFile>("read_file", { ...connArg(), path }).then((res) => {
      editor.reopen(path, res.content, res.mtime, res.encoding);
    }).catch(() => {});
    renderTabs(path);
    setMsg(`已应用 Agent 修改：${baseName(path)}`);
    done();
  };
  no.onclick = done;
  no.textContent = opts.apply === false ? "关闭" : "取消";
}

// ---------- 命令面板（最小版）----------
// ---------- Ctrl+P 快速打开 ----------
let fileCache: { key: string; list: string[] } | null = null;

async function listFiles(): Promise<string[]> {
  const c = curCtx();
  const key = `${c.host ?? ""}|${c.root}`;
  if (fileCache?.key === key) return fileCache.list;
  const list = await invoke<string[]>("list_files", { host: c.host, port: c.port, root: c.root, max: 20000 });
  fileCache = { key, list };
  return list;
}

/** 子序列模糊匹配：先比文件名，再比整条路径 */
function fuzzyScore(path: string, q: string): number {
  const base = baseName(path).toLowerCase();
  const p = path.toLowerCase();
  if (!q) return 1;
  const i = base.indexOf(q);
  if (i === 0) return 100;
  if (i > 0) return 60;
  if (p.includes(q)) return 30;
  let k = 0;
  for (const ch of p) if (ch === q[k]) k++;
  return k === q.length ? 10 : 0;
}

async function quickOpen() {
  if (!root) { setMsg("先打开一个文件夹"); return; }
  setMsg("正在收集文件…");
  let all: string[];
  try {
    all = await listFiles();
  } catch (e) {
    setMsg(`列不出文件：${e}`);
    return;
  }
  const m = $("#modal");
  m.querySelector(".title")!.textContent = `快速打开（${all.length} 个文件）`;
  const body = m.querySelector(".body") as HTMLDivElement;
  body.innerHTML = `<div class="pk-path"><input id="qo-input" spellcheck="false" placeholder="输入文件名或路径片段…" /></div><div id="qo-list" class="pk-list"></div>`;
  (m.querySelector(".actions") as HTMLDivElement).innerHTML = "";
  m.classList.remove("hidden");
  const input = $<HTMLInputElement>("#qo-input");
  const box = $<HTMLDivElement>("#qo-list");
  input.focus();
  let rows: string[] = [];
  let sel = 0;

  const paint = () => {
    box.innerHTML = "";
    if (!rows.length) {
      box.innerHTML = `<div class="pk-empty">没匹配到</div>`;
      return;
    }
    rows.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "pk-row" + (i === sel ? " sel" : "");
      row.innerHTML = `<span class="ico">${iconSvg(iconFor(baseName(p), false, false))}</span><span class="name"></span>`;
      row.querySelector(".name")!.textContent = p;
      row.onmousedown = (ev) => { ev.preventDefault(); sel = i; void pick(); };
      box.appendChild(row);
    });
    (box.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  };
  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    rows = all
      .map((p) => [p, fuzzyScore(p, q)] as [string, number])
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
      .slice(0, 200)
      .map(([p]) => p);
    sel = 0;
    paint();
  };
  const pick = async () => {
    const p = rows[sel];
    closeModal();
    if (!p) return;
    await openFile(joinPath(root!, p));
  };
  input.oninput = refresh;
  input.onkeydown = (e) => {
    if (e.key === "Escape") { closeModal(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void pick();
    }
  };
  refresh();
}

async function showCommandPalette() {
  const r = await ask(
    "命令面板",
    `<input id="pal-input" placeholder="输入命令…" />
     <div id="pal-list" style="margin-top:8px;font-size:12px;color:#9d9d9d;line-height:1.8">
       1. 打开文件夹<br/>2. SSH 连接<br/>3. 断开 SSH<br/>4. 新建终端<br/>5. 保存当前文件<br/>6. 端口转发
     </div>`,
    [{ label: "取消", value: "cancel" }]
  );
  void r;
  const input = $("#modal #pal-input") as HTMLInputElement | null;
  input?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = input.value.trim().toLowerCase();
    closeModal();
    if (v.includes("ssh") && v.includes("断")) disconnect();
    else if (v.includes("ssh")) document.querySelector<HTMLButtonElement>('#activity button[data-act="ssh"]')?.click();
    else if (v.includes("文件夹") || v.includes("folder")) $("#btn-open-folder").click();
    else if (v.includes("终端") || v.includes("term")) { showTerm(true); void terms.newTerminal(); }
    else if (v.includes("保存") || v.includes("save")) void saveCurrent();
    else if (v.includes("转发") || v.includes("forward")) void addForward();
  });
}

void boot();
