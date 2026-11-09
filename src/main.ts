// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
import "./style.css";
import { chromeIcon, iconFor, iconSvg, uiIcon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { getCurrentWindow, LogicalPosition } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
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
  bindTermSet();
  const prof = contexts.some((c) => c.id === id && c.kind === "ssh")
    ? sshProfiles().find((p) => `ssh:${p.id}` === id)
    : undefined;
  if (prof) void invoke("ssh_set_identity", { key: prof.key ?? null }).catch(() => {});
  renderCtxBar();
  setConnLabel();
  renderSsh();
  expanded.clear();
  clearSel();
  $("#tree").innerHTML = "";
  const c = curCtx();
  if (c.kind === "ssh" && c.online === false) {
    // 上次会话恢复出来的标签：点一下就重连，连上再回原来的目录
    $("#tree").innerHTML = `<div class="tree-tip">未连接，正在重连…</div>`;
    setMsg(`正在重连 ${c.label}…`);
    void reconnectCtx(c);
    return;
  }
  if (root) void refreshTree();
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
      expanded.clear();
  clearSel();
      $("#tree").innerHTML = "";
      if (root) void refreshTree();
      renderGit(null);
    }
    renderCtxBar();
    setConnLabel();
    saveCtxs();
    dropTermSet(id);
    bindTermSet();
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
    expanded.clear();
  clearSel();
    $("#tree").innerHTML = "";
    if (root) void refreshTree();
    renderGit(null);
  }
  renderCtxBar();
  setConnLabel();
  saveCtxs();
  dropTermSet(id);
  bindTermSet();
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

// ---------- 关于 ----------
const ABOUT_LOGO = `<svg width="104" height="104" viewBox="0 0 32 32" aria-hidden="true">
  <rect x="5" y="5" width="22" height="22" fill="#452760"/>
  <rect x="11" y="10" width="4" height="12" fill="#f0ecf8"/>
</svg>`;

async function showAbout() {
  const v = await getVersion().catch(() => "");
  void ask(
    "关于",
    `<div class="about">
      <div class="logo">${ABOUT_LOGO}</div>
      <div class="name">NifeCode</div>
      <div class="ver">版本 ${v || "开发版"}</div>
      <div class="desc">轻量编辑器 · Monaco + xterm + Tauri<br/>SSH 远端开发 · 多标签工作区 · Agent Bridge</div>
      <div class="hp"></div>
      <a id="about-repo" title="点击复制仓库地址">github.com/OliverMao/NifeCode</a>
      <div class="lic">GPL-3.0 许可 · © 2026 OliverMao</div>
      <button id="about-update" class="mini">检查更新</button>
    </div>`,
    [{ label: "好", value: "ok", primary: true }]
  );
  const a = document.getElementById("about-repo");
  if (a) a.onclick = () => copyText("https://github.com/OliverMao/NifeCode");
  const u = document.getElementById("about-update") as HTMLButtonElement | null;
  if (u) {
    u.onclick = async () => {
      u.disabled = true;
      u.textContent = "检查中";
      const r = await checkUpdate(true);
      u.disabled = false;
      u.textContent = r === "none" ? "已是最新" : "检查更新";
    };
  }
}

// ---------- 更新 ----------
interface UpdateInfo {
  current: string;
  latest: string;
  size: number;
  url: string;
  notes: string;
}

/** 查更新；发现新版就在这里问用户要不要换。返回值给「关于」里的按钮用 */
async function checkUpdate(manual: boolean): Promise<"none" | "found" | "fail"> {
  if (manual) setMsg("正在检查更新…");
  let info: UpdateInfo | null = null;
  try {
    info = await invoke<UpdateInfo | null>("update_check");
  } catch (e) {
    if (manual) setMsg(`检查更新失败：${e}`);
    return "fail";
  }
  if (!info) {
    if (manual) setMsg("已是最新版本");
    return "none";
  }
  setMsg(`发现新版本 ${info.latest}`);
  const mb = (info.size / 1048576).toFixed(1);
  const yes = await ask(
    "发现新版本",
    `<div class="upd">
      <p>${info.current} → <b>${info.latest}</b>（${mb} MB）</p>
      <p class="dim">下载完会替换当前程序并自动重启，工作区标签和设置都保留。</p>
    </div>`,
    [
      { label: "稍后", value: "no" },
      { label: "下载并重启", value: "yes", primary: true },
    ]
  );
  if (yes !== "yes") return "found";
  setMsg(`正在下载 ${info.latest}…`);
  try {
    await invoke("update_install", { url: info.url, size: info.size });
  } catch (e) {
    setMsg("更新失败");
    await ask("更新失败", `<p>${String(e).replace(/</g, "&lt;")}</p><p class="dim">可以到 GitHub Releases 手动下载。</p>`, [
      { label: "好", value: "ok", primary: true },
    ]);
  }
  return "found";
}

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
  if (!settings.snapshot) return;
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
// ---------- 设置 ----------
interface Settings {
  minimap: boolean;
  wordWrap: boolean;
  eol: "lf" | "crlf";
  shell: string;
  confirmClose: boolean;
  snapshot: boolean;
}
const SET_DEFAULTS: Settings = { minimap: true, wordWrap: false, eol: "lf", shell: "", confirmClose: true, snapshot: true };

function loadSettings(): Settings {
  const b = (k: string, d: boolean) => (localStorage.getItem(k) === null ? d : localStorage.getItem(k) === "1");
  return {
    minimap: b("minimap", SET_DEFAULTS.minimap),
    wordWrap: b("editor-wrap", SET_DEFAULTS.wordWrap),
    eol: (localStorage.getItem("eol") as "lf" | "crlf") || SET_DEFAULTS.eol,
    shell: localStorage.getItem("term-shell") ?? SET_DEFAULTS.shell,
    confirmClose: b("confirm-close", SET_DEFAULTS.confirmClose),
    snapshot: b("snapshot", SET_DEFAULTS.snapshot),
  };
}
const settings = loadSettings();

function applyEditorSettings() {
  editor.setMinimap(settings.minimap);
  editor.setWordWrap(settings.wordWrap);
}

async function showSettings() {
  const shells = shellList.length ? shellList : await loadShells();
  const rows: string[] = [];
  const row = (k: string, hint: string, v: string) =>
    `<div class="set-row"><div class="k"><b>${k}</b><span>${hint}</span></div><div class="v">${v}</div></div>`;
  const sec = (t: string) => `<div class="set-sec">${t}</div>`;
  const check = (id: string, on: boolean) => `<input id="${id}" type="checkbox" ${on ? "checked" : ""} />`;

  rows.push(sec("外观"));
  rows.push(
    row(
      "字体大小",
      "同时缩放编辑器、终端与界面",
      `<input id="set-font" type="range" min="9" max="28" value="${fontSize}" /><span class="num" id="set-font-num">${fontSize}</span>`
    )
  );

  rows.push(sec("编辑器"));
  rows.push(row("代码缩略图", "显示在编辑器右侧", check("set-minimap", settings.minimap)));
  rows.push(row("自动换行", "按窗口宽度折行", check("set-wrap", settings.wordWrap)));
  rows.push(
    row(
      "换行符",
      "文件不含换行符时使用",
      `<select id="set-eol">
         <option value="lf" ${settings.eol === "lf" ? "selected" : ""}>LF</option>
         <option value="crlf" ${settings.eol === "crlf" ? "selected" : ""}>CRLF</option>
       </select>`
    )
  );

  rows.push(sec("终端"));
  rows.push(
    row(
      "默认 Shell",
      "新建终端时使用",
      `<select id="set-shell">
         <option value="">最近一次使用</option>
         ${shells.map((sh) => `<option value="${sh.id}" ${settings.shell === sh.id ? "selected" : ""}>${sh.name}</option>`).join("")}
       </select>`
    )
  );

  rows.push(sec("常规"));
  rows.push(row("关闭前确认", "有未保存的更改时询问", check("set-confirm", settings.confirmClose)));
  rows.push(row("会话恢复", "异常退出后恢复未保存内容", check("set-snapshot", settings.snapshot)));

  rows.push(sec("存储"));
  rows.push(
    row(
      "缓存",
      "仅清理可自动重建的缓存，不影响设置与登录状态",
      `<span id="set-cache-size" class="muted">读取中</span>
       <button id="set-cache-clear" class="mini">清理</button>`
    )
  );

  // ask() 一调用就把 DOM 画好了；这里先不 await，先把事件挂上再等关闭
  $("#modal").classList.add("wide");
  const closed = ask("设置", `<div class="set">${rows.join("")}</div>`, [
    { label: "关闭", value: "ok", primary: true },
  ]);

  const on = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const save = (k: string, v: string) => localStorage.setItem(k, v);

  const font = on<HTMLInputElement>("set-font");
  font?.addEventListener("input", () => {
    applyFontSize(Number(font.value));
    const n = on<HTMLSpanElement>("set-font-num");
    if (n) n.textContent = String(fontSize);
  });

  on<HTMLInputElement>("set-minimap")?.addEventListener("change", (e) => {
    settings.minimap = (e.target as HTMLInputElement).checked;
    save("minimap", settings.minimap ? "1" : "0");
    editor.setMinimap(settings.minimap);
  });
  on<HTMLInputElement>("set-wrap")?.addEventListener("change", (e) => {
    settings.wordWrap = (e.target as HTMLInputElement).checked;
    save("editor-wrap", settings.wordWrap ? "1" : "0");
    editor.setWordWrap(settings.wordWrap);
  });
  on<HTMLSelectElement>("set-eol")?.addEventListener("change", (e) => {
    settings.eol = (e.target as HTMLSelectElement).value as "lf" | "crlf";
    save("eol", settings.eol);
  });
  on<HTMLSelectElement>("set-shell")?.addEventListener("change", (e) => {
    settings.shell = (e.target as HTMLSelectElement).value;
    preferredShell = settings.shell;
    save(SHELL_KEY, settings.shell);
  });
  on<HTMLInputElement>("set-confirm")?.addEventListener("change", (e) => {
    settings.confirmClose = (e.target as HTMLInputElement).checked;
    save("confirm-close", settings.confirmClose ? "1" : "0");
  });
  on<HTMLInputElement>("set-snapshot")?.addEventListener("change", (e) => {
    settings.snapshot = (e.target as HTMLInputElement).checked;
    save("snapshot", settings.snapshot ? "1" : "0");
  });

  // 缓存：进来算一次大小，清理后重算
  const sizeEl = on<HTMLSpanElement>("set-cache-size");
  const fmt = (b: number) =>
    b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
  const refreshCache = async () => {
    const info = await invoke<{ bytes: number }>("app_cache_size").catch(() => null);
    if (sizeEl) sizeEl.textContent = info ? fmt(info.bytes) : "—";
  };
  void refreshCache();
  on<HTMLButtonElement>("set-cache-clear")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "清理中";
    try {
      const freed = await invoke<number>("app_cache_clear");
      setMsg(`已清理缓存 ${fmt(freed)}`);
      await refreshCache();
      btn.textContent = "已清理";
    } catch (err) {
      setMsg(`清理失败：${err}`);
      btn.textContent = "重试";
    }
    setTimeout(() => {
      btn.disabled = false;
      if (!btn.textContent || btn.textContent !== "清理") btn.textContent = "清理";
    }, 1200);
  });

  await closed;
  $("#modal").classList.remove("wide");
}

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
  for (const set of termSets.values()) set.host.setFontSize(fontSize);
  setMsg(`字号 ${fontSize}px`);
}

function bumpFont(d: number | "reset") {
  applyFontSize(d === "reset" ? FONT_DEFAULT : fontSize + d);
}

const editor = new EditorHost(
  $("#editor"),
  (path, dirty) => markTabDirty(path, dirty),
  (line, col) => {
    $<HTMLSpanElement>("#st-pos").textContent = `行 ${line}，列 ${col}`;
    (window as any).__cur = { line, column: col }; // 给 bridge 的 cursor 用
  },
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

/** 左上角主菜单（点 logo / 品牌名出来） */
function mainMenu(): MenuItem[] {
  return [
    // 终端栏收起以后入口不好找，主菜单里单列一条（文案跟着当前状态走）
    { label: $("#term-col").classList.contains("collapsed") ? "显示终端" : "隐藏终端", run: () => toggleTerm() },
    "sep",
    { label: "设置…", run: () => void showSettings() },
    { label: "关于 NifeCode", run: () => void showAbout() },
    "sep",
    { label: "退出", run: () => void getCurrentWindow().close() },
  ];
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
  // 当前标签滚动到可见范围（标签多到装不下时，Ctrl+Tab 切过去也能看见）
  const box2 = $("#tabs");
  const active2 = box2.querySelector<HTMLElement>(".tab.active");
  if (active2) {
    const left = box2.scrollLeft;
    const right = left + box2.clientWidth;
    if (active2.offsetLeft < left) box2.scrollLeft = active2.offsetLeft;
    else if (active2.offsetLeft + active2.offsetWidth > right) {
      box2.scrollLeft = active2.offsetLeft + active2.offsetWidth - box2.clientWidth;
    }
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

/** 真正写盘，失败会抛（bridge 的 /save 要知道成功与否） */
async function savePathRaw(path: string) {
  const doc = editor.docsFor(path);
  if (!doc) throw new Error("没有打开的文档");
  const mtime = await invoke<number>("write_file", {
    host: doc.host,
    port: doc.port,
    path,
    content: doc.model.getValue(),
    encoding: doc.encoding,
  });
  editor.markSaved(path, mtime);
  renderTabs(path);
  return mtime;
}

async function savePath(path: string) {
  if (!editor.docsFor(path)) return;
  try {
    await savePathRaw(path);
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

let clip: { paths: string[]; host: string | null; port: number; cut: boolean } | null = null;

// 文件树多选：点一下单选，Ctrl 点切换，Shift 点连选一段
const sel = new Set<string>();
let selAnchor = "";
let treeFocus = false; // 最后一次点击落在文件树上（决定 F2/Delete 归谁）

/** 换工作区/上下文时清掉多选（路径已经不是同一套了） */
function clearSel() {
  sel.clear();
  selAnchor = "";
}

function paintSel() {
  for (const n of document.querySelectorAll<HTMLElement>(".node")) {
    n.classList.toggle("active", sel.has(n.dataset.path!));
  }
}

/** 右键/操作要用到的那批路径：点在已选中的行上就整批算，否则只算这一行 */
function picked(path: string): string[] {
  return sel.has(path) && sel.size > 1 ? [...sel] : [path];
}

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
  $("#brand").classList.remove("open");
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

function treeMenu(e: Entry, paths: string[]): MenuItem[] {
  const dir = e.is_dir ? e.path : parentOf(e.path);
  const multi = paths.length > 1;
  const items: MenuItem[] = [
    { label: "新建文件", run: () => void newEntry(dir, false) },
    { label: "新建文件夹", run: () => void newEntry(dir, true) },
  ];
  if (clip) {
    const nm = clip.paths.length > 1 ? `${clip.paths.length} 项` : baseName(clip.paths[0]);
    items.push({ label: `粘贴「${nm}」`, run: () => void pasteInto(dir) });
  }
  items.push("sep");
  if (multi) items.push({ label: `${paths.length} 项已选择`, run: () => {} });
  else if (!e.is_dir) items.push({ label: "打开", run: () => void openFile(e.path) });
  else items.push({ label: "在此打开工作区", run: () => void openRoot(e.path) });
  items.push(
    { label: multi ? `复制 ${paths.length} 个路径` : "复制绝对路径", run: () => copyText(paths.join("\n")) },
    ...(multi ? [] : [{ label: "复制相对路径", run: () => copyText(relPath(e.path)) } as MenuItem]),
    "sep",
    { label: multi ? `复制 ${paths.length} 项` : "复制", run: () => setClip(paths, false) },
    { label: multi ? `剪切 ${paths.length} 项` : "剪切", run: () => setClip(paths, true) },
    ...(multi ? [] : [{ label: "重命名", run: () => void renameEntry(e.path) } as MenuItem]),
    { label: multi ? `删除 ${paths.length} 项` : "删除", run: () => void deleteEntry(paths) },
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

function setClip(paths: string[], cut: boolean) {
  clip = { paths, host, port, cut };
  const nm = paths.length > 1 ? `${paths.length} 项` : baseName(paths[0]);
  setMsg(`${cut ? "已剪切" : "已复制"} ${nm}`);
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

async function deleteEntry(paths: string[]) {
  const one = paths.length === 1;
  const r = await ask("删除", `确定删除${one ? `「${baseName(paths[0])}」` : `这 ${paths.length} 项`}？<br/><span style="color:#e2c08d">远程目录会递归删除，不可恢复。</span>`, [
    { label: "删除", value: "ok", primary: true },
    { label: "取消", value: "no" },
  ]);
  if (r !== "ok") return;
  let done = 0;
  for (const p of paths) {
    try {
      await invoke("fs_delete", { ...connArg(), path: p });
      sel.delete(p);
      done += 1;
    } catch (err) {
      setMsg(`删除失败：${baseName(p)} —— ${err}`);
    }
  }
  await refreshTree();
  if (done) setMsg(one ? `已删除 ${paths[0]}` : `已删除 ${done} 项`);
}

async function pasteInto(dir: string) {
  if (!clip) return;
  const cmd = clip.cut ? "fs_rename" : "fs_copy";
  const from = clip.paths;
  const host_ = clip.host;
  const port_ = clip.port;
  let done = 0;
  for (const p of from) {
    const to = joinPath(dir, baseName(p));
    if (to === p) continue; // 目标就是原位置，跳过
    try {
      await invoke(cmd, { host: host_, port: port_, from: p, to });
      done += 1;
    } catch (err) {
      setMsg(`粘贴失败：${baseName(p)} —— ${err}`);
    }
  }
  if (!done) {
    setMsg("目标就是原位置");
    return;
  }
  setMsg(`${clip.cut ? "已移动" : "已复制"} ${done} 项到 ${dir}`);
  if (clip.cut) clip = null;
  await refreshTree();
}

let treeSig = "";
let treeGen = 0;
async function refreshTree() {
  if (!root) return;
  const gen = ++treeGen;
  // 先画到离线节点上，画完再整体换掉 #tree。
  // 远端一次 read_dir 要跑一趟 ssh，删除后的刷新很容易和定时轮询撞在一起，
  // 之前是先清空再异步追加，两次刷新会各追加一遍 —— 列表就重复显示了一份。
  const box = document.createElement("div");
  await renderTree(root, box, 0, true);
  if (gen !== treeGen) return; // 期间又发起了一次刷新，这次的结果丢掉
  $("#tree").replaceChildren(...box.children);
  paintSel(); // 重建行以后把多选高亮补回来
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

    const select = (ev: MouseEvent) => {
      treeFocus = true;
      const all = [...document.querySelectorAll<HTMLElement>(".node")];
      if (ev.shiftKey && selAnchor) {
        const a = all.findIndex((r) => r.dataset.path === selAnchor);
        const b = all.indexOf(row);
        sel.clear();
        for (let i = Math.min(a, b), hi = Math.max(a, b); a >= 0 && i <= hi; i++) sel.add(all[i].dataset.path!);
      } else if (ev.ctrlKey || ev.metaKey) {
        if (sel.has(e.path)) sel.delete(e.path);
        else sel.add(e.path);
        selAnchor = e.path;
      } else {
        sel.clear();
        sel.add(e.path);
        selAnchor = e.path;
      }
      paintSel();
    };

    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!sel.has(e.path)) {
        sel.clear();
        sel.add(e.path);
        selAnchor = e.path;
        paintSel();
      }
      showMenu(ev.clientX, ev.clientY, treeMenu(e, picked(e.path)));
    };

    if (e.is_dir) {
      row.onclick = async (ev) => {
        select(ev);
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return; // 多选时不展开/打开
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
      row.onclick = (ev) => {
        select(ev);
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return; // 多选时不打开文件
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
  clearSel();
  $("#tree").innerHTML = "";
  await refreshTree();
  // 终端 cwd 跟随工作区（cwd 是回调，不用重建），首次打开顺手起一个；
  // 但终端栏是收着的就别自己弹出来（连 SSH 时也会走到这里）
  if (terms.count() === 0 && !$("#term-col").classList.contains("collapsed")) void terms.newTerminal();
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

// 终端跟着上下文走：本机 1、本机 2、每个 SSH 各有一套页和终端，切换标签就换一整套
interface TermSet { host: TerminalHost; wrap: HTMLElement }
const termSets = new Map<string, TermSet>();
let terms!: TerminalHost;

/** 当前上下文的终端组，第一次用到的时候才建 */
function termSet(): TermSet {
  const c = curCtx();
  const got = termSets.get(c.id);
  if (got) return got;
  const wrap = document.createElement("div");
  wrap.className = "term-set";
  wrap.innerHTML = `<div class="term-tabs"></div><div class="terms"></div>`;
  $("#term-host").appendChild(wrap);
  // 回调按"这套终端属于哪个上下文"取信息，切走以后也不会串到别的项目
  const self = () => contexts.find((x) => x.id === c.id) ?? c;
  const host = new TerminalHost(
    wrap.querySelector<HTMLElement>(".terms")!,
    wrap.querySelector<HTMLElement>(".term-tabs")!,
    () => self().root ?? undefined,
    () => (self().host ? { target: self().host!, port: self().port } : null),
    () => {
      const sh = shellList.find((x) => x.id === preferredShell) ?? shellList[0];
      return sh ? { id: sh.id, name: sh.name } : null;
    },
    (text) => void openLink(text),
  );
  const set = { host, wrap };
  termSets.set(c.id, set);
  return set;
}

/** 切上下文时把终端也换过去（隐藏的那几套不销毁，切回来还在） */
function bindTermSet() {
  const id = curCtx().id;
  const set = termSet();
  for (const [k, v] of termSets) v.wrap.style.display = k === id ? "" : "none";
  terms = set.host;
  // 刚显示出来时 xterm 还拿着隐藏时算出的 0 尺寸，重排一次
  requestAnimationFrame(() => { terms.relayoutAll(); terms.fitAll(); });
}

/** 关掉某个上下文：它的终端和 PTY 一起走 */
function dropTermSet(id: string) {
  const set = termSets.get(id);
  if (!set) return;
  set.host.dispose();
  set.wrap.remove();
  termSets.delete(id);
}

function showTerm(on: boolean) {
  $("#term-col").classList.toggle("collapsed", !on);
  $("#app").classList.toggle("no-term", !on);
  // 收起以后只剩状态栏这个入口能点回来，所以它得一直显示并反映当前状态
  $("#st-term").classList.toggle("off", !on);
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
    bindTermSet(); // 连上就直接用这台机器的终端，不用再手点一下标签
    renderCtxBar();
    setConnLabel("连接中…");
    renderSsh();
    $("#tree").innerHTML = "";
    expanded.clear();
    clearSel();
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
      if (!wasOffline) dropTermSet(c.id);
      bindTermSet();
      renderCtxBar();
      setConnLabel();
      renderSsh();
      if (root) void refreshTree();
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

/** 终端里 Ctrl+点击拿到的文字：URL 走系统浏览器，文件路径走编辑器 */
async function openLink(text: string) {
  if (/^https?:\/\//i.test(text)) {
    try {
      await invoke("open_url", { url: text });
    } catch (e) {
      setMsg(`打不开链接：${e}`);
    }
    return;
  }
  const tail = /:(\d+)(?::\d+)?$/.exec(text);
  const lineNo = tail ? Number(tail[1]) : undefined;
  let p = tail ? text.slice(0, text.length - tail[0].length) : text;
  const abs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("~");
  if (!abs) {
    if (!root) return;
    p = joinPath(root, p.replace(/^[.][\\/]/, "")); // 相对路径按项目根算
  }
  p = p.replace(/\\/g, "/");
  // shortcut: 远程 ~ 只认 /home/<user>，别的用户目录请用绝对路径
  if (p.startsWith("~")) p = `/home/${p.slice(1).replace(/^[\\/]/, "")}`;
  await openFile(p, lineNo);
}

// ---------- Agent Bridge ----------
async function pushBridgeState() {
  const d = editor.current();
  const sel = (window as any).__sel;
  const cur = (window as any).__cur;
  await invoke("bridge_set_state", {
    state: {
      root,
      host,
      file: d?.path ?? null,
      dirty: editor.dirtyPaths(),
      selection: sel ?? null,
      // 光标位置：人只说"这里"没选中东西时，agent 至少知道往哪一行下手
      cursor: d && cur ? { file: d.path, line: cur.line, column: cur.column } : null,
      lastError,
    },
  }).catch(() => {});
}

// ---------- 启动 ----------
async function boot() {
  setConnLabel();
  renderTabs();

  // 面板头三件事：＋ 新建终端页、˅ 在当前页新建终端（选类型）、✕ 收起；拆分在每个终端自己的头上
  $<HTMLButtonElement>("#btn-new-term").onclick = () => { showTerm(true); void terms.newPage(true); };
  // 界面小按钮统一用自绘 SVG（＋ ✕ ˅），别用字体里那些大小不一的符号
  for (const [id, name] of [
    ["#ctx-new", "plus"],
    ["#btn-open-folder", "plus"],
    ["#btn-ssh-new", "plus"],
    ["#btn-new-term", "plus"],
    ["#btn-term-type", "chevron"],
    ["#btn-close-panel", "close"],
  ]) {
    const el = $(id);
    if (el) el.innerHTML = chromeIcon(name);
  }

  $<HTMLButtonElement>("#btn-term-type").onclick = async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement;
    const r = btn.getBoundingClientRect();
    if (shellList.length === 0) await loadShells();
    const items: MenuItem[] = shellList.map((sh) => ({
      label: `${sh.id === preferredShell ? "● " : "　"}${sh.name}`,
      run: () => {
        preferredShell = sh.id;
        localStorage.setItem(SHELL_KEY, sh.id);
        showTerm(true);
        void terms.newTerminal(sh.id); // 选类型也只是在当前页新建，不另开一页
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

  // 标签栏：滚轮直接横向滚（滚轮是竖直的，浏览器不会帮你滚一个只能横滚的容器）
  $("#tabs").addEventListener(
    "wheel",
    (e) => {
      const box = $("#tabs");
      if (box.scrollWidth <= box.clientWidth) return; // 放得下就别拦
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 横向手势（触摸板）交给浏览器
      e.preventDefault();
      box.scrollLeft += e.deltaY;
    },
    { passive: false }
  );

  // 点树里的空白处 = 取消所有选择
  $("#tree").addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest(".node")) return;
    clearSel();
    paintSel();
  });

  $("#tree").addEventListener("contextmenu", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest(".node")) return; // 行上自己有菜单
    if (!root) return;
    ev.preventDefault();
    const items: MenuItem[] = [
      { label: "新建文件", run: () => void newEntry(root!, false) },
      { label: "新建文件夹", run: () => void newEntry(root!, true) },
    ];
    if (clip) {
      const nm = clip.paths.length > 1 ? `${clip.paths.length} 项` : baseName(clip.paths[0]);
      items.push({ label: `粘贴「${nm}」`, run: () => void pasteInto(root!) });
    }
    items.push("sep", { label: "复制工作区路径", run: () => void copyText(root!) });
    showMenu(ev.clientX, ev.clientY, items);
  });

  document.querySelectorAll<HTMLButtonElement>("#activity button").forEach((b) => {
    b.innerHTML = uiIcon(b.dataset.act ?? "");
  });

  restoreCtxs();
  applyActive();
  bindTermSet();
  renderCtxBar();
  if (root) void refreshTree();
  applyFontSize(fontSize);
  applyEditorSettings();
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
  $<HTMLSpanElement>("#st-term").onclick = () => toggleTerm();
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
  // 自定义标题栏的三个按钮（SVG 自绘，跟其它图标同一套笔画）
  const WIN_ICON = {
    min: '<svg viewBox="0 0 12 12"><path d="M2 6h8"/></svg>',
    max: '<svg viewBox="0 0 12 12"><rect x="2.4" y="2.4" width="7.2" height="7.2" rx="0.8"/></svg>',
    restore: '<svg viewBox="0 0 12 12"><rect x="2" y="4" width="6" height="6" rx="0.8"/><path d="M4 4V2.8h5.2V8H8"/></svg>',
    close: '<svg viewBox="0 0 12 12"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg>',
  };
  const win = getCurrentWindow();
  const btnMin = $<HTMLButtonElement>("#win-min");
  const btnMax = $<HTMLButtonElement>("#win-max");
  const btnClose = $<HTMLButtonElement>("#win-close");
  btnMin.innerHTML = WIN_ICON.min;
  btnMax.innerHTML = WIN_ICON.max;
  btnClose.innerHTML = WIN_ICON.close;
  btnMin.onclick = () => void win.minimize();
  btnMax.onclick = () => void win.toggleMaximize();
  btnClose.onclick = () => void win.close();
  // 标题栏自己管拖动和双击。不用 data-tauri-drag-region：它一按下就进系统移动循环，
  // 把第二次点击吃掉，双击最大化就永远不触发。改成移动超过 4px 才开始拖。
  const titlebar = $<HTMLDivElement>("#titlebar");
  let pend: { x: number; y: number } | null = null;
  let lastDown = 0;
  titlebar.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || t.closest("#brand") || t.closest("#winbtns")) return;
    const now = Date.now();
    if (now - lastDown < 400) {
      lastDown = 0;
      pend = null;
      void win.toggleMaximize();
      return;
    }
    lastDown = now;
    pend = { x: e.clientX, y: e.clientY };
  });
  titlebar.addEventListener("pointermove", (e) => {
    if (!pend) return;
    if (Math.abs(e.clientX - pend.x) + Math.abs(e.clientY - pend.y) < 4) return;
    lastDown = 0;
    pend = null;
    void dragWindow(e);
  });
  const endDrag = () => {
    pend = null;
  };
  // 最大化时拖动：先还原，把窗口摆到鼠标下面再接着拖（Windows / VS Code 就是这样）
  const dragWindow = async (e: PointerEvent) => {
    if (!(await win.isMaximized().catch(() => false))) {
      await win.startDragging();
      return;
    }
    const ratio = e.clientX / window.innerWidth; // 鼠标在标题栏里的横向比例
    const curX = window.screenX + e.clientX;
    const curY = window.screenY + e.clientY;
    const barY = e.clientY; // 鼠标在标题栏中的纵向偏移，还原后保持不变
    await win.unmaximize();
    const sz = await win.innerSize();
    const w = sz.width / window.devicePixelRatio;
    await win.setPosition(new LogicalPosition(Math.round(curX - ratio * w), Math.round(curY - barY)));
    await win.startDragging();
  };
  titlebar.addEventListener("pointerup", endDrag);
  titlebar.addEventListener("pointercancel", endDrag);
  // 最大化时把图标换成"还原"，并去掉圆角留白
  const syncMaxIcon = async () => {
    const maxed = await win.isMaximized().catch(() => false);
    btnMax.innerHTML = maxed ? WIN_ICON.restore : WIN_ICON.max;
    document.body.classList.toggle("maximized", maxed);
  };
  void syncMaxIcon();
  await win.onResized(() => void syncMaxIcon());

  $<HTMLButtonElement>("#brand").onclick = (ev) => {
    ev.stopPropagation();
    if (!$("#ctxmenu").classList.contains("hidden")) {
      hideMenu();
      return;
    }
    const r = $<HTMLButtonElement>("#brand").getBoundingClientRect();
    $("#brand").classList.add("open");
    showMenu(r.left, r.bottom + 2, mainMenu());
  };

  // 关窗前把没保存的改动问一遍，别直接丢
  await getCurrentWindow().onCloseRequested(async (ev) => {
    const dirty = editor.dirtyPaths();
    if (!dirty.length) return;
    if (!settings.confirmClose) {
      ev.preventDefault();
      await getCurrentWindow().destroy();
      return;
    }
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

  // 捕获阶段：Monaco / xterm 会在自己的 mousedown 里 stopPropagation，
  // 挂在冒泡阶段的话，点编辑器或终端里的东西菜单就关不掉（只能按 Esc）
  document.addEventListener(
    "mousedown",
    (e) => {
      const m = $("#ctxmenu");
      if (m.classList.contains("hidden")) return;
      const t = e.target as HTMLElement | null;
      if (!t || typeof t.closest !== "function") return hideMenu();
      if (t.closest("#brand")) return; // 品牌名自己按开关处理，见下面的 onclick
      if (!t.closest("#ctxmenu")) hideMenu();
    },
    true
  );
  // 点别的窗口/Alt+Tab 回来也别留着菜单
  window.addEventListener("blur", () => hideMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
    if (e.key === "Escape") closeModal();
  });

  // 资源管理器键盘：F2 改名、Delete 删除。
  // 点文件会打开它、焦点跑到 Monaco，所以不能看 activeElement，得看"最后一次点是哪儿"
  document.addEventListener("mousedown", (e) => {
    if (!(e.target as HTMLElement).closest("#tree")) treeFocus = false;
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== "F2" && e.key !== "Delete") return;
    if (!treeFocus || sel.size === 0) return;
    const a = document.activeElement as HTMLElement | null;
    const typing = !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
    if (e.key === "F2") {
      e.preventDefault();
      e.stopPropagation();
      if (sel.size > 1) { setMsg("重命名一次只能改一个"); return; }
      void renameEntry([...sel][0]);
    } else {
      if (typing) return; // 在编辑器/终端/输入框里按 Delete 应该删字符
      e.preventDefault();
      e.stopPropagation();
      void deleteEntry([...sel]);
    }
  });

  // 缩放放在捕获阶段：编辑器聚焦时 Monaco 会先把按键吃掉，捕获能保证我们先处理
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); e.stopPropagation(); bumpFont(1); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); e.stopPropagation(); bumpFont(-1); }
    else if (e.key === "0") { e.preventDefault(); e.stopPropagation(); bumpFont("reset"); }
  }, true);

  await listen<{ path: string; line?: number }>("bridge:open", (e) => {
    // 相对路径按工作区根算，别落到编辑器进程的 cwd 上
    const p = e.payload.path.replace(/\\/g, "/");
    const abs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
    void openFile((abs || !root ? p : joinPath(root, p)).replace(/\\/g, "/"), e.payload.line);
  });
  // 外面（agent）要保存文件：写完把结果回给 Rust，HTTP 那边才回 200/500
  await listen<{ path?: string }>("bridge:save", async (e) => {
    const want = e.payload?.path;
    const targets = want ? [want] : editor.paths().filter((p) => { const d = editor.docsFor(p); return d && editor.isDirty(d); });
    const saved: string[] = [];
    const errors: { path: string; error: string }[] = [];
    for (const p of targets) {
      if (!editor.docsFor(p)) {
        errors.push({ path: p, error: "没有打开这个文件" });
        continue;
      }
      try {
        await savePathRaw(p);
        saved.push(p);
      } catch (err) {
        errors.push({ path: p, error: String(err) });
      }
    }
    if (saved.length) setMsg(`Agent 触发的保存：${saved.length} 个文件`);
    await invoke("bridge_save_result", { res: { ok: errors.length === 0, saved, errors } }).catch(() => {});
  });
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
  // 启动几秒后静默查一次更新（默认连不上也不吵）
  setTimeout(() => void checkUpdate(false), 6000);
}

// ---------- Diff（agent 提案审阅）----------
async function openDiff(path: string, oldText: string, newText: string, opts: { title?: string; apply?: boolean } = {}) {
  const host_ = document.createElement("div");
  // 放在 #main 里（而不是 body 上按 px 偏移）：只会盖住编辑器，标签栏和终端都还看得见；
  // 拖分隔条、开/关终端列时跟着自适应，不用手动算偏移。
  host_.style.cssText =
    "position:absolute;top:35px;left:0;right:0;bottom:0;z-index:5;background:#1e1e1e;display:flex;flex-direction:column;border-top:1px solid #333;";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 10px;background:#252526;font-size:12px;";
  bar.innerHTML = `<span style="flex:1">${opts.title ?? "Agent 修改提案"}：${baseName(path)}</span>`;
  const ok = document.createElement("button");
  ok.textContent = "应用";
  ok.style.cssText = "background:#6d4a94;color:#fff;border:0;padding:5px 12px;border-radius:2px;cursor:pointer;";
  const no = document.createElement("button");
  no.textContent = "取消";
  no.style.cssText = "background:#3a3d41;color:#fff;border:0;padding:5px 12px;border-radius:2px;cursor:pointer;";
  if (opts.apply === false) ok.style.display = "none";
  bar.append(ok, no);
  const wrap = document.createElement("div");
  wrap.style.cssText = "flex:1;min-height:0;";
  host_.append(bar, wrap);
  $<HTMLDivElement>("#main").appendChild(host_);

  const { monaco } = await import("./editor");
  // 编辑器列窄的时候（终端占了右半边）左右对照会挤成一团，Monaco 会自己切成单栏内联模式
  const diff = monaco.editor.createDiffEditor(wrap, {
    theme: "vs-dark",
    automaticLayout: true,
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: true,
    renderSideBySideInlineBreakpoint: 720,
    wordWrap: "on", // 窄列里长行不折行就被切掉，看不清改了什么
  });
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
       1. 打开文件夹<br/>2. SSH 连接<br/>3. 断开 SSH<br/>4. 新建终端<br/>5. 保存当前文件<br/>6. 端口转发<br/>7. 设置<br/>8. 关于
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
    else if (v.includes("关于") || v.includes("about") || v.includes("版本")) void showAbout();
    else if (v.includes("设置") || v.includes("setting")) void showSettings();
  });
}

void boot();
