import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
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

export interface Doc {
  path: string;
  model: monaco.editor.ITextModel;
  mtime: number;
  savedVersion: number;
  readOnly: boolean;
  host: string | null; // 打开它时连的是哪台机器（切上下文也不会写错地方）
  port: number;
  encoding: string; // 打开时的编码（utf-8 / gbk / utf-16le…），保存时按它写回
}

export class EditorHost {
  private ed: monaco.editor.IStandaloneCodeEditor;
  private docs = new Map<string, Doc>();
  constructor(
    el: HTMLElement,
    onDirty: (path: string, dirty: boolean) => void,
    onCursor: (line: number, col: number) => void,
    onSave: () => void,
  ) {
    this.ed = monaco.editor.create(el, {
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei Mono", monospace',
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      tabSize: 4,
    } as monaco.editor.IStandaloneEditorConstructionOptions);

    this.ed.onDidChangeModelContent(() => {
      const d = this.current();
      if (d) onDirty(d.path, this.isDirty(d));
    });
    this.ed.onDidChangeCursorPosition((e) => onCursor(e.position.lineNumber, e.position.column));
    this.ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave);
  }

  current(): Doc | undefined {
    const model = this.ed.getModel();
    if (!model) return undefined;
    for (const d of this.docs.values()) if (d.model === model) return d;
    return undefined;
  }

  isDirty(d: Doc): boolean {
    return d.model.getAlternativeVersionId() !== d.savedVersion;
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  docsFor(path: string): Doc | undefined {
    return this.docs.get(path);
  }

  mtimeOf(path: string): number | undefined {
    return this.docs.get(path)?.mtime;
  }

  markSaved(path: string, mtime: number) {
    const d = this.docs.get(path);
    if (!d) return;
    d.mtime = mtime;
    d.savedVersion = d.model.getAlternativeVersionId();
  }

  reopen(path: string, content: string, mtime: number, encoding?: string) {
    const d = this.docs.get(path);
    if (!d) return this.open(path, content, mtime);
    // 保留滚动位置和光标，否则外部改动重载会像"整个编辑器被重置"
    const isActive = this.ed.getModel() === d.model;
    const view = isActive ? this.ed.saveViewState() : null;
    d.model.setValue(content);
    if (isActive && view) this.ed.restoreViewState(view);
    d.mtime = mtime;
    d.savedVersion = d.model.getAlternativeVersionId();
    if (encoding) d.encoding = encoding;
  }

  setFontSize(px: number) {
    this.ed.updateOptions({ fontSize: px, lineHeight: Math.round(px * 1.5) });
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
    encoding = "utf-8"
  ): Doc {
    let d = this.docs.get(path);
    if (!d) {
      const model = monaco.editor.createModel(content, languageOf(path), monaco.Uri.file(path));
      // 默认 LF：文本里没出现过 CR 就不跟随 Windows 的 CRLF，新建文件/新行都是 LF
      if (!content.includes("\r")) model.setEOL(monaco.editor.EndOfLineSequence.LF);
      d = { path, model, mtime, savedVersion: model.getAlternativeVersionId(), readOnly: false, host, port, encoding };
      this.docs.set(path, d);
    }
    this.show(path);
    return d;
  }

  setEncoding(path: string, encoding: string) {
    const d = this.docs.get(path);
    if (d) d.encoding = encoding;
  }

  /** 当前文档的换行符：LF / CRLF */
  eolOf(path?: string): string {
    const d = path ? this.docs.get(path) : this.current();
    return d && d.model.getEOL() === "\r\n" ? "CRLF" : "LF";
  }

  show(path: string) {
    const d = this.docs.get(path);
    if (!d) return;
    if (this.ed.getModel() !== d.model) this.ed.setModel(d.model);
    this.ed.focus();
  }

  revealLine(line: number) {
    this.ed.revealLineInCenter(line);
    this.ed.setPosition({ lineNumber: line, column: 1 });
  }

  close(path: string) {
    const d = this.docs.get(path);
    if (!d) return;
    if (this.ed.getModel() === d.model) this.ed.setModel(null);
    d.model.dispose();
    this.docs.delete(path);
  }

  paths(): string[] {
    return [...this.docs.keys()];
  }

  dirtyPaths(): string[] {
    return [...this.docs.values()].filter((d) => this.isDirty(d)).map((d) => d.path);
  }
}

export { monaco };

// git 面板测试

// 触发变更
