import "./style.css";
import { iconFor, iconSvg, uiIcon } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EditorHost } from "./editor";
import { TerminalHost } from "./terminal";

interface Entry { name: string; path: string; is_dir: boolean }
interface ReadFile { content: string; mtime: number }

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
}

const CTX_KEY = "contexts";
let ctxSeq = 1;
const contexts: Ctx[] = [{ id: "local:1", kind: "local", label: "本机", host: null, port: 22, root: null }];
let activeId = "local:1";

/** 只持久化本机标签（SSH 标签需要重连，不还原） */
function saveCtxs() {
  const cur = curCtx();
  if (cur && cur.kind === "local") cur.root = root;
  const locals = contexts.filter((c) => c.kind === "local").map((c) => ({ id: c.id, label: c.label, root: c.root }));
  localStorage.setItem(CTX_KEY, JSON.stringify({ locals, activeId }));
}

function restoreCtxs() {
  try {
    const raw = localStorage.getItem(CTX_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as { locals?: { id: string; label: string; root: string | null }[]; activeId?: string };
    if (!data.locals?.length) return;
    contexts.length = 0;
    for (const l of data.locals) {
      contexts.push({ id: l.id, kind: "local", label: l.label, host: null, port: 22, root: l.root });
      const n = Number(l.id.split(":")[1] ?? 1);
      if (n > ctxSeq) ctxSeq = n;
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

function curCtx(): Ctx {
  return contexts.find((c) => c.id === activeId) ?? contexts[0];
}

function renderCtxBar() {
  const bar = $("#ctx-tabs");
  bar.innerHTML = "";
  for (const c of contexts) {
    const el = document.createElement("div");
    el.className = "ctx-tab" + (c.id === activeId ? " active" : "");
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
  if (root) void renderTree(root, $("#tree"), 0);
  if ($("#scm").classList.contains("active")) void loadGit();
  else renderGit(null);
  setMsg(root ?? "未打开文件夹");
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

// ---------- 编辑器 ----------
const editor = new EditorHost(
  $("#editor"),
  (path, dirty) => markTabDirty(path, dirty),
  (line, col) => { $<HTMLSpanElement>("#st-pos").textContent = `行 ${line}，列 ${col}`; },
  () => void saveCurrent()
);

// ---------- 标签页 ----------
function baseName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function markTabDirty(path: string, dirty: boolean) {
  const el = Array.from($("#tabs").children).find((c) => (c as HTMLElement).dataset.path === path) as HTMLElement | undefined;
  el?.classList.toggle("dirty", dirty);
}

function renderTabs(activePath?: string) {
  const box = $("#tabs");
  box.innerHTML = "";
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
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "✕";
    x.onclick = async (e) => {
      e.stopPropagation();
      const d = editor.docsFor(p);
      if (d && editor.isDirty(d)) {
        const r = await ask("未保存的更改", `“${baseName(p)}” 有未保存的更改，要保存吗？`, [
          { label: "保存", value: "save", primary: true },
          { label: "不保存", value: "discard" },
          { label: "取消", value: "cancel" },
        ]);
        if (r === "cancel") return;
        if (r === "save") await savePath(p);
      }
      editor.close(p);
      renderTabs();
    };
    el.append(name, x);
    el.onclick = () => { editor.show(p); renderTabs(p); };
    box.appendChild(el);
  }
}

// ---------- 打开 / 保存 ----------
async function openFile(path: string, line?: number) {
  if (editor.has(path)) {
    editor.show(path);
    if (line) editor.revealLine(line);
    renderTabs(path);
    return;
  }
  try {
    const c = curCtx();
    const res = await invoke<ReadFile>("read_file", { host: c.host, port: c.port, path });
    editor.open(path, res.content, res.mtime, c.host, c.port);
    if (line) editor.revealLine(line);
    renderTabs(path);
    $<HTMLSpanElement>("#st-msg").textContent = path;
  } catch (e) {
    lastError = `open ${path}: ${e}`;
    setMsg(`打开失败：${e}`);
  }
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
  items.push(
    { label: "重命名", run: () => void renameEntry(e.path) },
    { label: "删除", run: () => void deleteEntry(e.path) },
    "sep",
    { label: "复制", run: () => setClip(e.path, false) },
    { label: "剪切", run: () => setClip(e.path, true) }
  );
  return items;
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
    if (!c) {
      c = { id: cid, kind: "ssh", label: p.name, host: p.target, port: p.port, root: null };
      contexts.push(c);
    } else {
      c.label = p.name;
      c.host = p.target;
      c.port = p.port;
    }
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
      c.root = home;
      applyActive();
      renderCtxBar();
      setConnLabel();
      renderSsh();
      await openRoot(home);
      setMsg(`已连接 ${p.name}（${home}）`);
    } catch (e) {
      // 连不上就把这个空标签收回，别再留个死标签
      contexts.splice(contexts.indexOf(c), 1);
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
    showMenu(ev.clientX, ev.clientY, items);
  });

  document.querySelectorAll<HTMLButtonElement>("#activity button").forEach((b) => {
    b.innerHTML = uiIcon(b.dataset.act ?? "");
  });

  restoreCtxs();
  applyActive();
  renderCtxBar();
  if (root) void renderTree(root, $("#tree"), 0);
  void loadShells();
  if (terms.count() === 0) void terms.newPage(true);

  $<HTMLButtonElement>("#btn-ssh-new").onclick = () => void editProfile();
  renderSsh();

  $<HTMLInputElement>("#search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); void runSearch(); }
  });
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
    const dir = await pickFolder();
    if (dir) {
      await openRoot(dir);
      saveCtxs();
    }
  };

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
    showMenu(ev.clientX, ev.clientY, items);
  });

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
    }
  });

  document.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || typeof t.closest !== "function" || !t.closest("#ctxmenu")) hideMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
    if (e.key === "Escape") closeModal();
  });

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
    if (document.hidden) return;
    void pollExternalChanges();
  }, host ? 10000 : 1200); // 远端一次轮询就是一次完整 ssh 往返，别太勤
  setInterval(() => { if ($("#scm").classList.contains("active")) void loadGit(); }, 4000);
  // 文件树自动刷新：只 stat 根目录 + 已展开的目录，变了才重画
  setInterval(() => {
    if (document.hidden) return;
    if (!$("#tree").classList.contains("hidden")) void pollTree();
  }, host ? 5000 : 1500);
  setInterval(() => { void pushBridgeState(); }, 2000);

  if (!root) setMsg("就绪：点击左侧 ＋ 打开文件夹，或点 🔌 连接 SSH");
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
    await invoke("write_file", { ...connArg(), path, content: newText }).catch((e) => setMsg(`写入失败：${e}`));
    await invoke<ReadFile>("read_file", { ...connArg(), path }).then((res) => {
      editor.reopen(path, res.content, res.mtime);
    }).catch(() => {});
    renderTabs(path);
    setMsg(`已应用 Agent 修改：${baseName(path)}`);
    done();
  };
  no.onclick = done;
  no.textContent = opts.apply === false ? "关闭" : "取消";
}

// ---------- 命令面板（最小版）----------
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
