// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 OliverMao — NifeCode, 见仓库根目录 LICENSE
// 只装用得到的部分：整包 monaco 会带上 80 多种语言的注册代码，冷启动白白多解析几 MB。
// Shortcut: LANG 表里没有的语言（如 purebasic、systemverilog）退化成纯文本，
// 要加语言就在下面补一行 contribution + LANG 表。
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/edcore.main"; // 编辑器功能：查找 / 折叠 / 补全 / 对照…
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
// 走语言服务（各自 worker）的四种
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
// 只有高亮的语言，和下面 LANG 表一一对应。
// 注意：能用上语言服务的那几个（ts/js/html/css…）也必须在这里注册 id——
// vs/language/* 只装服务，不注册语言名，以前是靠整包导入基本语言表把 id 带进来的
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution"; // 同时注册 c 和 cpp
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// 没有项目上下文时 TS 语义校验会满天红，先关掉；语法错误仍然提示
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});
monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  md: "markdown", markdown: "markdown", py: "python", rs: "rust", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", rb: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", psm1: "powershell",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini", xml: "xml", svg: "xml",
  sql: "sql", kt: "kotlin", swift: "swift", lua: "lua", dart: "dart", vue: "html",
  dockerfile: "dockerfile", gitignore: "plaintext", txt: "plaintext", log: "plaintext",
};

export function languageOf(path: string): string {
  const base = path.split(/[\\/]/).pop()!.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return LANG[ext] ?? "plaintext";
}

// 日志里重定向出来的终端颜色码（ESC[0;36m 之类）在 Monaco 里只是一串奇怪符号，看着没法读。
// 打开纯文本时去掉（设置里可以关掉）；去掉之后文件已不是原样，保存会把这些颜色码从磁盘上一并写掉。
// shortcut: 只认 ANSI 转义序列，CR 覆盖/退格那种进度条残留不管，真遇到再说。
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~]|\x1b/g;

function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI_RE, "") : text;
}

// 文本里的超链接：Ctrl+点击能点（URL 最后交回宿主，和终端 Ctrl+点击同一个入口）
const URL_RE = /https?:\/\/[^\s"'`<>()\[\]]+/g;

monaco.languages.registerLinkProvider("*", {
  provideLinks(model) {
    // 链接计算会扫全文，而 monaco 每次 Ctrl+悬停都会调一次：内容没改就直接复用上次的结果
    const cached = linkCache.get(model);
    if (cached && cached.version === model.getVersionId()) return { links: cached.links };
    const links: monaco.languages.ILink[] = [];
    const lines = model.getLinesContent();
    for (let i = 0; i < lines.length; i++) {
      URL_RE.lastIndex = 0;
      for (let m; (m = URL_RE.exec(lines[i])); ) {
        const url = m[0].replace(/[.,;:!?]+$/, ""); // 句末标点不算链接
        links.push({
          range: { startLineNumber: i + 1, startColumn: m.index + 1, endLineNumber: i + 1, endColumn: m.index + url.length + 1 },
          url,
          tooltip: "Ctrl+点击打开链接",
        });
      }
    }
    linkCache.set(model, { version: model.getVersionId(), links });
    return { links };
  },
});

const linkCache = new WeakMap<monaco.editor.ITextModel, { version: number; links: monaco.languages.ILink[] }>();

export interface Doc {
  path: string;
  model: monaco.editor.ITextModel;
  mtime: number;
  savedVersion: number;
  readOnly: boolean;
  host: string | null; // 打开它时连的是哪台机器（切上下文也不会写错地方）
  port: number;
  encoding: string; // 打开时的编码（utf-8 / gbk / utf-16le…），保存时按它写回
  ansi: boolean; // 打开时内容里的 ANSI 转义序列被去掉了（保存会把它们写掉）
}

export class EditorHost {
  private ed: monaco.editor.IStandaloneCodeEditor;
  // 每个上下文（本机项目标签 / 每个 SSH 连接）各一份打开的文档，切换标签不会串台
  private ctx = "";
  private maps = new Map<string, Map<string, Doc>>();
  // model -> Doc：current() 每次击键都会调，别再展平所有上下文的数组去找
  private byModel = new Map<monaco.editor.ITextModel, Doc>();
  private minimapPref = true;
  private ansiPref = true; // 打开纯文本时去掉 ANSI 颜色码（设置里可关）
  private actives = new Map<string, string>(); // 每个上下文最后看的是哪个文件
  private views = new Map<string, monaco.editor.ICodeEditorViewState | null>(); // 光标/滚动位置

  /** 当前上下文的文档表 */
  private get docs(): Map<string, Doc> {
    let m = this.maps.get(this.ctx);
    if (!m) {
      m = new Map();
      this.maps.set(this.ctx, m);
    }
    return m;
  }

  /** 跨所有上下文找（路径是唯一的，不用先知道在哪个上下文） */
  private find(path: string): Doc | undefined {
    for (const m of this.maps.values()) {
      const d = m.get(path);
      if (d) return d;
    }
    return undefined;
  }

  private allDocs(): Doc[] {
    return [...this.maps.values()].flatMap((m) => [...m.values()]);
  }

  /** 切到某个上下文：记住这边的光标位置，换成那边的文件（那边没开文件就空着） */
  setCtx(id: string) {
    if (id === this.ctx) return;
    const cur = this.current();
    if (cur) this.actives.set(this.ctx, cur.path);
    this.views.set(this.ctx, this.ed.saveViewState());
    this.ctx = id;
    const p = this.actives.get(id);
    const d = p ? this.docs.get(p) : undefined;
    this.ed.setModel(d ? d.model : null);
    if (d) {
      this.ed.updateOptions({ readOnly: d.readOnly });
      const v = this.views.get(id);
      if (v) this.ed.restoreViewState(v);
    }
  }

  /** 上下文被关掉：把它的模型全释放，别留着占内存 */
  dropCtx(id: string) {
    const m = this.maps.get(id);
    if (!m) return;
    if (this.ctx === id) {
      this.ed.setModel(null);
      this.ctx = "";
      this.maps.set("", new Map());
      this.actives.delete("");
    }
    for (const d of m.values()) {
      if (this.ed.getModel() === d.model) this.ed.setModel(null);
      this.byModel.delete(d.model);
      d.model.dispose();
    }
    this.maps.delete(id);
    this.actives.delete(id);
  }
  constructor(
    el: HTMLElement,
    onDirty: (path: string, dirty: boolean) => void,
    onCursor: (line: number, col: number) => void,
    onSave: () => void,
    onLink: (text: string) => void,
  ) {
    // 链接的 Ctrl+点击最终走到这里；只认 http(s)，别的返回 false 交回 monaco 默认处理
    monaco.editor.registerLinkOpener({
      open: (res) => {
        const text = res.toString(true);
        if (!/^https?:\/\//i.test(text)) return false;
        onLink(text);
        return true;
      },
    });
    this.ed = monaco.editor.create(el, {
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei Mono", monospace',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      // 中文标点（， ： ； ！ ？ （ ））在 Unicode 的"易混淆字符"表里，默认会被框一个黄框
      unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false },
      tabSize: 4,
    } as monaco.editor.IStandaloneEditorConstructionOptions);

    this.ed.onDidChangeModelContent(() => {
      const d = this.current();
      if (d) onDirty(d.path, this.isDirty(d));
    });
    this.ed.onDidChangeCursorPosition((e) => onCursor(e.position.lineNumber, e.position.column));
    // 选中的内容给 agent bridge 用（/state 里的 selection）
    this.ed.onDidChangeCursorSelection(() => {
      const d = this.current();
      const sel = this.ed.getSelection();
      if (!d || !sel || sel.isEmpty()) {
        (window as any).__sel = null;
        return;
      }
      const text = d.model.getValueInRange(sel);
      (window as any).__sel = {
        file: d.path,
        startLine: sel.startLineNumber,
        endLine: sel.endLineNumber,
        text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text,
      };
    });
    this.ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
  }

  current(): Doc | undefined {
    const model = this.ed.getModel();
    return model ? this.byModel.get(model) : undefined;
  }

  /** 预览面板等要跟着「当前文档变了 / 内容变了」动一下：两件事都通知 */
  onDocChange(cb: () => void) {
    this.ed.onDidChangeModel(() => cb());
    this.ed.onDidChangeModelContent(() => cb());
  }

  /** 这个文件当前开在哪个上下文里（崩溃恢复按它还原） */
  ctxOf(path: string): string | undefined {
    for (const [id, m] of this.maps) if (m.has(path)) return id;
    return undefined;
  }

  isDirty(d: Doc): boolean {
    return d.model.getAlternativeVersionId() !== d.savedVersion;
  }

  has(path: string): boolean {
    return !!this.find(path);
  }

  docsFor(path: string): Doc | undefined {
    return this.find(path);
  }

  mtimeOf(path: string): number | undefined {
    return this.find(path)?.mtime;
  }

  markSaved(path: string, mtime: number) {
    const d = this.find(path);
    if (!d) return;
    d.mtime = mtime;
    d.savedVersion = d.model.getAlternativeVersionId();
  }

  reopen(path: string, content: string, mtime: number, encoding?: string) {
    const d = this.find(path);
    if (!d) return this.open(path, content, mtime);
    // 保留滚动位置和光标，否则外部改动重载会像"整个编辑器被重置"
    const isActive = this.ed.getModel() === d.model;
    const view = isActive ? this.ed.saveViewState() : null;
    d.model.setValue(d.ansi ? stripAnsi(content) : content);
    if (isActive && view) this.ed.restoreViewState(view);
    d.mtime = mtime;
    d.savedVersion = d.model.getAlternativeVersionId();
    if (encoding) d.encoding = encoding;
  }

  setMinimap(on: boolean) {
    this.minimapPref = on;
    this.applyViewOptions();
  }

  /** 只读的大文件不画 minimap：8MB 的文本画小地图只会拖慢滚动 */
  private applyViewOptions() {
    this.ed.updateOptions({ minimap: { enabled: this.minimapPref && !this.current()?.readOnly } });
  }

  setWordWrap(on: boolean) {
    this.ed.updateOptions({ wordWrap: on ? "on" : "off" });
  }

  setFontSize(px: number) {
    this.ed.updateOptions({ fontSize: px, lineHeight: Math.round(px * 1.5) });
  }

  /** 高亮易混淆 Unicode 字符（中文标点会被框出来，所以默认关） */
  setUnicodeHighlight(on: boolean) {
    this.ed.updateOptions({ unicodeHighlight: { ambiguousCharacters: on, nonBasicASCII: false } });
  }

  setStripAnsi(on: boolean) {
    this.ansiPref = on;
  }

  fontSize(): number {
    return this.ed.getOption(monaco.editor.EditorOption.fontSize);
  }

  open(
    path: string,
    content: string,
    mtime: number,
    host: string | null = null,
    port = 22,
    encoding = "utf-8",
    readOnly = false
  ): Doc {
    let d = this.docs.get(path);
    if (!d) {
      let ansi = false;
      if (this.ansiPref && languageOf(path) === "plaintext" && content.includes("\x1b")) {
        const clean = stripAnsi(content);
        if (clean !== content) {
          content = clean;
          ansi = true;
        }
      }
      // shortcut: 同一个绝对路径在两个项目里各开一份会有两个同 URI 的模型（罕见），升级点：按 path 复用模型
      const model = monaco.editor.createModel(content, languageOf(path), monaco.Uri.file(path));
      // 默认 LF：文本里没出现过 CR 就不跟随 Windows 的 CRLF，新建文件/新行都是 LF
      if (!content.includes("\r")) model.setEOL(monaco.editor.EndOfLineSequence.LF);
      d = { path, model, mtime, savedVersion: model.getAlternativeVersionId(), readOnly, host, port, encoding, ansi };
      this.docs.set(path, d);
      this.byModel.set(model, d);
    }
    this.show(path);
    return d;
  }

  /** 崩溃恢复用：内容来自缓存，直接当脏文档打开 */
  openDirty(path: string, content: string, mtime: number, host: string | null, port: number, encoding: string) {
    const d = this.open(path, content, mtime, host, port, encoding);
    d.savedVersion = -1; // 跟任何版本都不相等 -> 一直显示脏
    return d;
  }

  setEncoding(path: string, encoding: string) {
    const d = this.find(path);
    if (d) d.encoding = encoding;
  }

  /** 当前文档的换行符：LF / CRLF */
  eolOf(path?: string): string {
    const d = path ? this.find(path) : this.current();
    return d && d.model.getEOL() === "\r\n" ? "CRLF" : "LF";
  }

  show(path: string) {
    const d = this.find(path);
    if (!d) return;
    this.actives.set(this.ctx, path);
    if (this.ed.getModel() !== d.model) this.ed.setModel(d.model);
    this.ed.updateOptions({ readOnly: d.readOnly }); // 超大文件只读
    this.applyViewOptions();
    this.ed.focus();
  }

  revealLine(line: number) {
    this.ed.revealLineInCenter(line);
    this.ed.setPosition({ lineNumber: line, column: 1 });
  }

  close(path: string) {
    const d = this.find(path);
    if (!d) return;
    if (this.ed.getModel() === d.model) this.ed.setModel(null);
    this.byModel.delete(d.model);
    d.model.dispose();
    for (const m of this.maps.values()) m.delete(path);
    for (const [id, p] of this.actives) if (p === path) this.actives.delete(id);
  }

  /** 当前上下文打开的标签（标签栏只用这个） */
  paths(): string[] {
    return [...this.docs.keys()];
  }

  /** 所有上下文里开着的文件（外部改动检测要全查） */
  allPaths(): string[] {
    return this.allDocs().map((d) => d.path);
  }

  /** 某个上下文里的脏文件（关掉这个项目标签前要拦一下，别把没保存的改动丢进黑洞） */
  dirtyOf(id: string): string[] {
    const m = this.maps.get(id);
    if (!m) return [];
    return [...m.values()].filter((d) => this.isDirty(d)).map((d) => d.path);
  }

  /** 所有上下文里的脏文件（保存、bridge /state、退出确认都要全查） */
  dirtyPaths(): string[] {
    return this.allDocs().filter((d) => this.isDirty(d)).map((d) => d.path);
  }
}

export { monaco };

// git 面板测试

// 触发变更
