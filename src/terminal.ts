import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
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
  cols: number;   // 上一次下发给 PTY 的尺寸，用来去重
  rows: number;
  rt?: number;    // resize 去抖定时器
}

/** 一页 = 一组互相独立的终端；页之间切换，页内可以堆叠多个 */
interface Page {
  id: number;
  no: number;
  el: HTMLElement;   // .term-page
  tab: HTMLElement;  // 页标签
  panes: Pane[];
}

export class TerminalHost {
  private pages: Page[] = [];
  private activePage = -1;
  private started = false;
  private seqPage = 0;
  private addBtn: HTMLButtonElement;

  constructor(
    private body: HTMLElement,   // #terms
    private tabs: HTMLElement,   // #term-tabs（页标签栏）
    private cwd: () => string | undefined,
    private ssh: () => { target: string; port: number } | null = () => null,
    private shell: () => { id: string; name: string } | null = () => null,
  ) {
    this.addBtn = document.createElement("button");
    this.addBtn.className = "ttab-add";
    this.addBtn.title = "新建一页（独立的一组终端）";
    this.addBtn.textContent = "＋";
    this.addBtn.onclick = () => this.newPage(true);
    this.tabs.appendChild(this.addBtn);
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
      t = window.setTimeout(() => this.fitAll(), 120);
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

  /** 新建一页；withTerminal=true 时顺带开一个终端 */
  newPage(withTerminal = true): Page {
    const no = ++this.seqPage;
    const el = document.createElement("div");
    el.className = "term-page";

    const tab = document.createElement("div");
    tab.className = "ttab";
    tab.innerHTML = `<span class="tno">页 ${no}</span><span class="x">✕</span>`;
    this.tabs.insertBefore(tab, this.addBtn);
    this.body.appendChild(el);

    const page: Page = { id: no, no, el, tab, panes: [] };
    this.pages.push(page);

    tab.onclick = () => this.activatePage(page.id);
    tab.querySelector(".x")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closePage(page.id);
    });

    this.tidyTabs();
    tab.title = `第 ${no} 页 · 一组独立终端`;
    this.activatePage(page.id);
    if (withTerminal) void this.newTerminal();
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
    this.activatePage(this.pages[Math.min(idx, this.pages.length - 1)].id);
  }

  /** 问一下这个 shell id 的显示名（主进程那边有检测结果） */
  private async shellNameOf(id: string | null): Promise<string | null> {
    if (!id) return this.shell()?.name ?? "本地";
    const list = await invoke<{ id: string; name: string }[]>("shells").catch(() => []);
    return list.find((x) => x.id === id)?.name ?? id;
  }

  /** 在当前页新建一个终端（堆叠在下方）；shellId 不传就用当前偏好 */
  async newTerminal(shellId?: string) {
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
    const close = document.createElement("span");
    close.className = "x";
    close.textContent = "✕";
    head.appendChild(close);
    const termBody = document.createElement("div");
    termBody.className = "term-body";
    el.append(head, termBody);

    // 新开终端时本页恢复等分（不然旧终端会一直占满、新终端被挤成 1px）
    if (page.panes.length > 0) for (const p of page.panes) p.el.style.flex = "";
    page.el.appendChild(el);

    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei Mono", monospace',
      cursorBlink: true,
      theme: { background: "#1e1e1e", foreground: "#cccccc", cursor: "#cccccc" },
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termBody);

    // 连着 SSH 时新终端直接 ssh 过去（这样密码认证也能用）
    const remote = this.ssh();
    const id = await invoke<number>("pty_open", {
      cwd: remote ? null : (this.cwd() ?? null),
      cols: term.cols || 80,
      rows: term.rows || 24,
      ssh: remote ? { target: remote.target, port: remote.port, cwd: this.cwd() ?? null } : null,
      shell: remote ? null : wantShell,
    });

    const pane: Pane = { id, no, term, fit, el, headEl: head, tag, pageId: page.id, cols: 0, rows: 0 };
    page.panes.push(pane);

    head.onclick = () => this.focus(id);
    close.onclick = (ev) => {
      ev.stopPropagation();
      this.closePane(id);
    };

    term.onData((d) => { void invoke("pty_write", { id, data: d }); });
    term.onResize(() => this.syncSize(pane));

    this.syncHeads(page);
    this.refresh(page);
    this.focus(id);
    return id;
  }

  focus(id?: number) {
    const all = this.pages.flatMap((p) => p.panes);
    const p = id === undefined ? all[all.length - 1] : this.findPane(id);
    if (!p) return;
    const page = this.pageById(p.pageId);
    if (page && page.id !== this.pages[this.activePage]?.id) this.activatePage(page.id);
    for (const x of all) x.el.classList.toggle("active", x.id === p.id);
    requestAnimationFrame(() => {
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
    this.syncHeads(page);
    this.refresh(page);
    if (page.panes.length === 0) {
      // 页里最后一个终端关掉，就把这页也关了
      this.closePage(page.id);
      return;
    }
    this.focus(page.panes[page.panes.length - 1].id);
  }

  /** 一页里只有一个终端时不用显示它的小标题栏，两个以上才需要 */
  private syncHeads(page: Page) {
    const show = page.panes.length > 1;
    for (const p of page.panes) p.headEl.style.display = show ? "" : "none";
  }

  private killPane(p: Pane) {
    void invoke("pty_kill", { id: p.id }).catch(() => {});
    p.term.dispose();
    p.splitter?.remove();
    p.el.remove();
  }

  private refresh(page: Page) {
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

  /** 拖动上下两个终端之间的分隔条 */
  private wireVSplitter(sp: HTMLElement, above: Pane, page: Page) {
    sp.addEventListener("mousedown", (down) => {
      if (!above.el.parentElement) return;
      down.preventDefault();
      const startY = down.clientY;
      const startH = above.el.getBoundingClientRect().height;
      const belowCount = page.panes.length - page.panes.indexOf(above) - 1;
      const total = above.el.parentElement!.getBoundingClientRect().height;
      const max = total - 60 * belowCount; // 下面每个终端至少留 60px
      document.body.style.cursor = "row-resize";
      const move = (e: MouseEvent) => {
        const h = Math.max(60, Math.min(max, startH + (e.clientY - startY)));
        above.el.style.flex = `0 0 ${Math.round(h)}px`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
        this.fitAll(); // 拖动过程中不 fit，松手才重排 PTY，避免反复触发 ConPTY 重绘
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  /** 关掉终端后重排：最后一个撑满，其余保持像素高度 */
  private relayout(page: Page) {
    page.panes.forEach((p, i) => {
      if (i === page.panes.length - 1) p.el.style.flex = "1 1 0";
      else if (!p.el.style.flex.startsWith("0 0")) {
        p.el.style.flex = `0 0 ${Math.round(p.el.getBoundingClientRect().height)}px`;
      }
    });
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

  fitAll() {
    for (const page of this.pages) {
      for (const p of page.panes) this.fitPane(p);
    }
  }
}
