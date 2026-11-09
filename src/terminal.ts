// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
import { chromeIcon, iconSvg, iconFor } from "./icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { listen } from "@tauri-apps/api/event";

interface PtyData { id: number; data: string } // base64

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Pane {
  id: number;
  no: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  headEl: HTMLElement;
  tag: string;
  splitter?: HTMLElement; // 这个终端上方的横向分隔条
  pageId: number;
  shell: string | null; // 这个终端用的 shell id（拆分时照抄它）
  cols: number;   // 上一次下发给 PTY 的尺寸，用来去重
  rows: number;
  rt?: number;    // resize 去抖定时器
  ratio?: number; // 占本页可用高度的比例（拖动分隔条时写，窗口缩放后按它还原）
}

/** 一页 = 一组互相独立的终端；页之间切换，页内可以堆叠多个 */
interface Page {
  id: number;
  no: number;
  el: HTMLElement;   // .term-page
  tab: HTMLElement;  // 页标签
  panes: Pane[];
  name?: string; // 双击页签改的自定义名字；没设过就用里面的终端类型
}

export class TerminalHost {
  private pages: Page[] = [];
  private activePage = -1;
  private started = false;
  private seqPage = 0;
  private empty: HTMLElement;
  private fontPx = 13; // 新开的终端也要用当前字号
  private renaming = false; // 正在改页签名字：这时候别把焦点抢回终端

  constructor(
    private body: HTMLElement,   // .terms
    private tabs: HTMLElement,   // .term-tabs（页标签栏）
    private cwd: () => string | undefined,
    private ssh: () => { target: string; port: number } | null = () => null,
    private shell: () => { id: string; name: string } | null = () => null,
  ) {
    this.empty = document.createElement("div");
    this.empty.className = "term-empty";
    this.empty.textContent = "这个标签还没有终端，点右上角 ＋ 新建";
    this.body.appendChild(this.empty);
  }

  async init() {
    if (this.started) return;
    this.started = true;
    await listen<PtyData>("pty:data", (e) => {
      const p = this.findPane(e.payload.id);
      if (p) p.term.write(b64ToBytes(e.payload.data));
    });
    let t = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => {
        this.relayoutAll();
        this.fitAll();
      }, 120);
    });
  }

  private findPane(id: number) {
    for (const page of this.pages) {
      const p = page.panes.find((x) => x.id === id);
      if (p) return p;
    }
    return undefined;
  }

  private pageById(id: number) {
    return this.pages.find((p) => p.id === id);
  }

  /** 新建一页；withTerminal=true 时顺带开一个终端（可指定 shell） */
  newPage(withTerminal = true, shellId?: string): Page {
    const no = ++this.seqPage;
    const el = document.createElement("div");
    el.className = "term-page";

    const tab = document.createElement("div");
    tab.className = "ttab";
    tab.innerHTML = `<span class="tno"></span><span class="x">${chromeIcon("close")}</span>`;
    this.tabs.appendChild(tab);
    this.body.appendChild(el);

    const page: Page = { id: no, no, el, tab, panes: [] };
    this.pages.push(page);

    tab.onclick = () => this.activatePage(page.id);
    tab.ondblclick = (e) => {
      e.stopPropagation();
      this.renamePage(page);
    };
    tab.querySelector(".x")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closePage(page.id);
    });

    this.tidyTabs();
    this.empty.style.display = "none";
    this.activatePage(page.id);
    if (withTerminal) void this.newTerminal(shellId);
    return page;
  }

  private tidyTabs() {
    const single = this.pages.length <= 1;
    for (const p of this.pages) {
      const x = p.tab.querySelector<HTMLElement>(".x");
      if (x) x.style.display = single ? "none" : "";
    }
  }

  activatePage(id: number) {
    const idx = this.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.activePage = idx;
    this.pages.forEach((p, i) => {
      const on = i === idx;
      p.el.classList.toggle("active", on);
      p.tab.classList.toggle("active", on);
    });
    const last = this.pages[idx].panes[this.pages[idx].panes.length - 1];
    if (last) this.focus(last.id);
    else requestAnimationFrame(() => this.fitAll());
  }

  closePage(id: number) {
    const idx = this.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const page = this.pages[idx];
    for (const p of [...page.panes]) this.killPane(p);
    page.el.remove();
    page.tab.remove();
    this.pages.splice(idx, 1);
    if (this.pages.length === 0) {
      this.activePage = -1;
      this.seqPage = 0; // 全关了就从"页 1"重新编号
      this.newPage(true); // 不留空面板
      return;
    }
    this.tidyTabs();
    for (const p of this.pages) this.namePage(p); // 前面的页关掉后，后面的 (2) 要变回不带序号
    this.activatePage(this.pages[Math.min(idx, this.pages.length - 1)].id);
  }

  /** 问一下这个 shell id 的显示名（主进程那边有检测结果） */
  private async shellNameOf(id: string | null): Promise<string | null> {
    if (!id) return this.shell()?.name ?? "本地";
    const list = await invoke<{ id: string; name: string }[]>("shells").catch(() => []);
    return list.find((x) => x.id === id)?.name ?? id;
  }

  /** 在当前页新建一个终端（堆叠在下方）；shellId 不传就用当前偏好，cwd 不传就用工作区根 */
  async newTerminal(shellId?: string, cwd?: string) {
    await this.init();
    let page = this.pages[this.activePage];
    if (!page) page = this.newPage(false);

    const no = page.panes.length + 1;
    const el = document.createElement("div");
    el.className = "term-pane";
    const head = document.createElement("div");
    head.className = "pane-head";
    const wantShell = shellId ?? this.shell()?.id ?? null;
    // 标签写这次真正用的那个 shell，不是当前偏好
    const shellName = (await this.shellNameOf(wantShell)) ?? "本地";
    const tag = this.ssh() ? `SSH ${this.ssh()!.target}` : shellName;
    head.innerHTML = `<span>终端 ${no} · ${tag}</span><span class="spacer"></span>`;
    const split = document.createElement("span");
    split.className = "split";
    split.title = "拆分：在当前页再开一个，类型照抄这个终端";
    split.innerHTML = chromeIcon("split");
    const close = document.createElement("span");
    close.className = "x";
    close.innerHTML = chromeIcon("close");
    head.append(split, close);
    const termBody = document.createElement("div");
    termBody.className = "term-body";
    el.append(head, termBody);

    // 新开终端时本页恢复等分（不然旧终端会一直占满、新终端被挤成 1px）
    if (page.panes.length > 0) for (const p of page.panes) p.el.style.flex = "";
    page.el.appendChild(el);

    const term = new Terminal({
      fontSize: this.fontPx,
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei Mono", monospace',
      cursorBlink: true,
      theme: { background: "#1e1e1e", foreground: "#cccccc", cursor: "#cccccc" },
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    term.open(termBody);
    this.bindClipboard(term, termBody);
    this.bindFind(term, search, el, termBody);

    // 连着 SSH 时新终端直接 ssh 过去（这样密码认证也能用）
    const remote = this.ssh();
    const id = await invoke<number>("pty_open", {
      cwd: remote ? null : (cwd ?? this.cwd() ?? null),
      cols: term.cols || 80,
      rows: term.rows || 24,
      ssh: remote ? { target: remote.target, port: remote.port, cwd: cwd ?? this.cwd() ?? null } : null,
      shell: remote ? null : wantShell,
    });

    const pane: Pane = { id, no, term, fit, el, headEl: head, tag, pageId: page.id, shell: wantShell, cols: 0, rows: 0 };
    page.panes.push(pane);

    head.onclick = () => this.focus(id);
    // 终端自己那条标题就在页签下面，很多人会双击它 —— 一样当成改这一页的名字
    head.ondblclick = (ev) => {
      ev.stopPropagation();
      this.renamePage(page);
    };
    split.onclick = (ev) => {
      ev.stopPropagation();
      this.focus(id);
      void this.newTerminal(wantShell ?? undefined); // 照抄这个终端的类型
    };
    close.onclick = (ev) => {
      ev.stopPropagation();
      this.closePane(id);
    };

    term.onData((d) => { void invoke("pty_write", { id, data: d }); });
    term.onResize(() => this.syncSize(pane));

    this.refresh(page);
    this.focus(id);
    return id;
  }

  /** 复制/粘贴：xterm 自己不管剪贴板，Ctrl+C 默认只会发 ^C */
  private bindClipboard(term: Terminal, host: HTMLElement) {
    // 返回 true 表示"这次按键已经被复制吃掉了"，别再当成 ^C 发给终端
    const copy = () => {
      const sel = term.getSelection();
      if (sel) void writeText(sel).catch((e) => console.warn("复制失败", e));
      return !!sel;
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      const k = e.key.toLowerCase();
      if (k === "c" && e.shiftKey) { copy(); return false; }   // Ctrl+Shift+C：强制复制
      if (k === "c" && !e.shiftKey) return !copy();             // 有选中就复制，没选中照旧发 ^C
      if (k === "v" && e.shiftKey) {                            // Ctrl+Shift+V：显式粘贴
        void readText().then((t) => t && term.paste(t)).catch(() => {});
        return false;
      }
      if (k === "f" && !e.shiftKey) {                            // Ctrl+F：终端里查找
        host.dispatchEvent(new CustomEvent("nife:find", { bubbles: true }));
        return false;
      }
      return true;
    });
    host.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (term.hasSelection()) copy();
      else void readText().then((t) => t && term.paste(t)).catch(() => {});
    });
  }

  /** 终端内查找（Ctrl+F）。找不到就当作什么都没发生，不弹任何东西 */
  private bindFind(term: Terminal, search: SearchAddon, paneEl: HTMLElement, termBody: HTMLElement) {
    const box = document.createElement("div");
    box.className = "term-find hidden";
    box.innerHTML = `<input spellcheck="false" placeholder="在终端中查找" />
      <button class="prev" title="上一个（Shift+Enter）">↑</button>
      <button class="next" title="下一个（Enter）">↓</button>
      <button class="close" title="关闭（Esc）">✕</button>`;
    paneEl.appendChild(box);
    const input = box.querySelector("input") as HTMLInputElement;
    const opts: ISearchOptions = {
      decorations: {
        matchBackground: "#3a2450",
        matchOverviewRuler: "#3a2450",
        activeMatchBackground: "#8b5fbf",
        activeMatchColorOverviewRuler: "#8b5fbf",
      },
    };
    const run = (back: boolean) => {
      const q = input.value;
      if (!q) return;
      if (back) search.findPrevious(q, opts);
      else search.findNext(q, opts);
    };
    const open = () => {
      box.classList.remove("hidden");
      const sel = term.getSelection();
      if (sel && !sel.includes("\n")) input.value = sel;
      input.focus();
      input.select();
    };
    const close = () => {
      box.classList.add("hidden");
      search.clearDecorations();
      term.focus();
    };
    (box.querySelector(".next") as HTMLElement).onclick = () => run(false);
    (box.querySelector(".prev") as HTMLElement).onclick = () => run(true);
    (box.querySelector(".close") as HTMLElement).onclick = close;
    input.oninput = () => run(false);
    input.onkeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter") { e.preventDefault(); run(e.shiftKey); }
    };
    paneEl.addEventListener("nife:find", open);
  }

  focus(id?: number) {
    const all = this.pages.flatMap((p) => p.panes);
    const p = id === undefined ? all[all.length - 1] : this.findPane(id);
    if (!p) return;
    const page = this.pageById(p.pageId);
    if (page && page.id !== this.pages[this.activePage]?.id) this.activatePage(page.id);
    for (const x of all) x.el.classList.toggle("active", x.id === p.id);
    requestAnimationFrame(() => {
      // 单击页签会走到这里；如果这一下其实是双击改名，焦点不能被终端抢走，
      // 否则输入框刚出来就失焦、立刻关掉，看着就像"双击没反应"
      if (this.renaming) return;
      this.fitPane(p);
      p.term.focus();
    });
  }

  closePane(id: number) {
    const p = this.findPane(id);
    if (!p) return;
    const page = this.pageById(p.pageId);
    if (!page) return;
    this.killPane(p);
    page.panes = page.panes.filter((x) => x.id !== id);
    this.refresh(page);
    if (page.panes.length === 0) {
      // 页里最后一个终端关掉，就把这页也关了
      this.closePage(page.id);
      return;
    }
    this.focus(page.panes[page.panes.length - 1].id);
  }

  /** 标签文字 = 里头的终端名，重名按顺序加序号（PowerShell、PowerShell (2)），跟 VS Code 一致 */
  private namePage(page: Page) {
    const name = (p?: Pane) => p?.tag ?? "终端";
    const base = name(page.panes[0]);
    let dup = 0;
    for (const p of this.pages) {
      if (p === page) break;
      if (name(p.panes[0]) === base) dup += 1;
    }
    const label = page.tab.querySelector(".tno");
    const auto = dup ? `${base} (${dup + 1})` : base;
    if (label) label.textContent = page.name ?? auto;
    // 一页里叠了好几个终端时，悬浮能看到都有谁
    const inner = page.panes.map((p) => p.tag).join("\n");
    page.tab.title = `${page.name ? `${page.name}\n` : ""}${inner}\n双击页签可改名`;
  }

  /** 双击页签就地改名；清空回车 = 退回自动名字 */
  private renamePage(page: Page) {
    if (page.tab.querySelector("input")) return;
    const label = page.tab.querySelector<HTMLElement>(".tno");
    if (!label) return;
    this.renaming = true;
    const input = document.createElement("input");
    input.className = "tno-edit";
    input.spellcheck = false;
    input.value = page.name ?? label.textContent ?? "";
    input.style.width = `${Math.max(90, label.offsetWidth + 12)}px`; // 按当前名字宽度撑开，别一进去就左右滚
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.renaming = false;
      if (save) page.name = input.value.trim() || undefined;
      const span = document.createElement("span");
      span.className = "tno";
      input.replaceWith(span);
      this.namePage(page);
    };
    input.onclick = (ev) => ev.stopPropagation();
    input.ondblclick = (ev) => ev.stopPropagation();
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    };
    input.onblur = () => finish(true);
  }

  private killPane(p: Pane) {
    void invoke("pty_kill", { id: p.id }).catch(() => {});
    p.term.dispose();
    p.splitter?.remove();
    p.el.remove();
  }

  private refresh(page: Page) {
    this.namePage(page);
    this.renumber(page);
    this.rebuildSplitters(page);
    this.relayout(page);
  }

  /** 每次增删终端都重建横条：旧横条可能指向已被删除的终端 */
  private rebuildSplitters(page: Page) {
    for (const p of page.panes) {
      p.splitter?.remove();
      p.splitter = undefined;
    }
    page.panes.forEach((p, i) => {
      if (i === 0) return;
      const sp = document.createElement("div");
      sp.className = "term-splitter-h";
      sp.title = "拖动调整高度（双击恢复均分）";
      sp.innerHTML = `<i></i>`;
      sp.ondblclick = () => {
        for (const x of page.panes) x.ratio = 1 / page.panes.length;
        this.relayout(page);
        this.fitPageBottom(page);
      };
      page.el.insertBefore(sp, p.el);
      p.splitter = sp;
      this.wireVSplitter(sp, page.panes[i - 1], page);
    });
  }

  /** 关掉终端后编号会断，统一重排成 1..n */
  private renumber(page: Page) {
    page.panes.forEach((p, i) => {
      p.no = i + 1;
      const label = p.headEl.firstElementChild;
      if (label) label.textContent = `终端 ${p.no} · ${p.tag}`;
    });
  }

  /**
   * 重排一页里的终端，并让每个都回到最底部。
   * 改高度后行数变了，停在原来的滚动位置会露出去一截旧内容，看着像被上面那块挡住。
   */
  private fitPageBottom(page: Page) {
    for (const p of page.panes) {
      this.fitPane(p);
      p.term.scrollToBottom();
    }
  }

  /** 拖动上下两个终端之间的分隔条 */
  private wireVSplitter(sp: HTMLElement, above: Pane, page: Page) {
    sp.addEventListener("mousedown", (down) => {
      if (!above.el.parentElement) return;
      down.preventDefault();
      const startY = down.clientY;
      const startH = above.el.getBoundingClientRect().height;
      const belowCount = page.panes.length - page.panes.indexOf(above) - 1;
      const total = above.el.parentElement!.getBoundingClientRect().height;
      const gap = (page.panes.length - 1) * 8; // 分隔条占掉的高度
      const avail = Math.max(120, total - gap);
      const max = avail - 60 * belowCount; // 下面每个终端至少留 60px
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none"; // 否则拖的时候会把终端文字选中
      sp.classList.add("dragging");
      const move = (e: MouseEvent) => {
        const h = Math.max(60, Math.min(max, startH + (e.clientY - startY)));
        above.el.style.flex = `0 0 ${Math.round(h)}px`;
        above.ratio = h / avail;
        // 下面的终端重新按剩余空间均分，别留着旧像素高度把最后一块挤没
        const rest = page.panes.slice(page.panes.indexOf(above) + 1);
        const left = Math.max(60, avail - h) / rest.length;
        for (const r of rest) {
          r.ratio = left / avail;
          r.el.style.flex = `0 0 ${Math.round(left)}px`;
        }
        rest[rest.length - 1].el.style.flex = "1 1 0";
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        sp.classList.remove("dragging");
        this.fitPageBottom(page); // 拖动过程中不 fit，松手才重排 PTY，避免反复触发 ConPTY 重绘
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  /** 关掉终端后重排：最后一个撑满，其余保持像素高度 */
  private relayout(page: Page) {
    const n = page.panes.length;
    if (!n) return;
    const gap = (n - 1) * 8;
    const avail = Math.max(120, page.el.getBoundingClientRect().height - gap);
    page.panes.forEach((p, i) => {
      if (i === n - 1) {
        p.el.style.flex = "1 1 0"; // 最后一个吃掉剩下的，避免误差累积成滚动条
        return;
      }
      if (p.ratio === undefined) p.ratio = 1 / n;
      p.el.style.flex = `0 0 ${Math.max(60, Math.round(p.ratio * avail))}px`;
    });
  }

  /** 窗口或终端列尺寸变了：按比例重算高度 */
  /** 整个上下文都不要了：把里面的终端和 PTY 一起收掉，别留在后台 */
  dispose() {
    for (const page of [...this.pages]) for (const p of [...page.panes]) this.killPane(p);
    this.pages.length = 0;
    this.activePage = -1;
  }

  relayoutAll() {
    for (const page of this.pages) this.relayout(page);
  }

  /** 所有页里的终端总数 */
  count() {
    return this.pages.reduce((n, p) => n + p.panes.length, 0);
  }

  private fitPane(p: Pane) {
    if (p.el.offsetParent === null) return; // 隐藏的终端 fit 会算成 0
    try { p.fit.fit(); } catch { /* 容器还没布局好 */ }
    this.syncSize(p);
  }

  // ConPTY 每次 resize 都会让里面的程序整屏重绘，所以：
  // 1) 尺寸没变就不发；2) 变的时候等 80ms 稳定下来再发，避免一帧里抖好几次（中文输入时尤其明显）
  private syncSize(p: Pane) {
    if (p.term.cols === p.cols && p.term.rows === p.rows) return;
    if (p.rt) clearTimeout(p.rt);
    p.rt = window.setTimeout(() => {
      p.rt = 0;
      if (p.term.cols === p.cols && p.term.rows === p.rows) return;
      p.cols = p.term.cols;
      p.rows = p.term.rows;
      void invoke("pty_resize", { id: p.id, cols: p.cols, rows: p.rows }).catch(() => {});
    }, 80);
  }

  setFontSize(px: number) {
    this.fontPx = px;
    for (const page of this.pages) {
      for (const p of page.panes) {
        p.term.options.fontSize = px;
        this.fitPane(p);
      }
    }
  }

  fitAll() {
    for (const page of this.pages) {
      for (const p of page.panes) this.fitPane(p);
    }
  }
}
